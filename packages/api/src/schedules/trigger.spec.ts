import {
  captureScheduleFireContext,
  hasScheduledGenerationContext,
  exemptFromConcurrencyLimiter,
  exemptFromUserLimiter,
  isScheduleFireRequest,
  readScheduleFireContext,
} from './trigger';

function request(manual = false) {
  return {
    _isAgentTrigger: true,
    body: {
      scheduleId: 'spoofed',
      agentTrigger: {
        version: 1,
        deliveryId: 'delivery-1',
        event: {
          id: 'occurrence-1',
          type: 'schedule.occurrence',
          occurredAt: 1_725_000_000_000,
          source: { id: 'schedule-1', type: 'schedule' },
        },
        metadata: { manual, configRevision: 7 },
      },
    },
  };
}

describe('schedule trigger context', () => {
  it('projects a verified generic trigger into schedule lifecycle fields', () => {
    const req = request();

    expect(captureScheduleFireContext(req)).toEqual({
      scheduleId: 'schedule-1',
      scheduledFor: new Date(1_725_000_000_000).toISOString(),
      manual: false,
      configRevision: 7,
    });
    expect(req.body).toMatchObject({
      scheduleId: 'schedule-1',
      scheduledFor: new Date(1_725_000_000_000).toISOString(),
      scheduleConfigRevision: 7,
    });
    expect(isScheduleFireRequest(req)).toBe(true);
    expect(exemptFromUserLimiter(req)).toBe(true);
    expect(exemptFromConcurrencyLimiter(req)).toBe(true);
  });

  it('preserves the agent bound by the trusted trigger target', () => {
    const req = request();
    const context = readScheduleFireContext({
      ...req,
      body: {
        agentTrigger: { ...req.body.agentTrigger, target: { agentId: 'agent-1' } },
      },
    });

    expect(context).toMatchObject({ scheduleId: 'schedule-1', agentId: 'agent-1' });
  });

  it.each([undefined, '', 123])(
    'keeps schedule provenance without accepting an invalid agent target %s',
    (agentId) => {
      const req = request();
      const context = readScheduleFireContext({
        ...req,
        body: {
          agentTrigger: { ...req.body.agentTrigger, target: { agentId } },
        },
      });

      expect(context).toMatchObject({ scheduleId: 'schedule-1' });
      expect(context).not.toHaveProperty('agentId');
    },
  );

  it('keeps manual runs on the interactive user and concurrency limiters', () => {
    const req = request(true);
    captureScheduleFireContext(req);

    expect(exemptFromUserLimiter(req)).toBe(false);
    expect(exemptFromConcurrencyLimiter(req)).toBe(false);
  });

  it('rejects copied metadata without a verified agent-trigger identity', () => {
    const req = request();
    req._isAgentTrigger = false;

    expect(readScheduleFireContext(req)).toBeUndefined();
    expect(captureScheduleFireContext(req)).toBeUndefined();
    expect(req.body.scheduleId).toBe('spoofed');
    expect(isScheduleFireRequest(req)).toBe(false);
  });

  it.each([
    { event: { type: 'schedule.occurrence', occurredAt: 1, source: { id: 's', type: 'webhook' } } },
    {
      event: { type: 'schedule.occurrence', occurredAt: -1, source: { id: 's', type: 'schedule' } },
    },
    {
      event: { type: 'schedule.occurrence', occurredAt: 1, source: { id: 's', type: 'schedule' } },
      metadata: { manual: 'yes' },
    },
  ])('fails closed for malformed schedule trigger metadata', (agentTrigger) => {
    expect(
      readScheduleFireContext({
        _isAgentTrigger: true,
        body: { agentTrigger: { version: 1, ...agentTrigger } },
      }),
    ).toBeUndefined();
  });
});

describe('schedule generation recursion context', () => {
  const req = {
    user: { id: 'user-1', tenantId: 'tenant-1' },
    turnStartedAt: 123,
    body: { conversationId: 'conversation-1' },
  };

  it('reads durable scheduled-steer context on an ordinary or resumed request', async () => {
    const getJob = jest.fn(async () => ({
      createdAt: 123,
      metadata: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        scheduleSteered: true,
      },
    }));
    expect(await hasScheduledGenerationContext(req, getJob)).toBe(true);
    expect(getJob).toHaveBeenCalledWith('conversation-1');
  });

  it('does not cache an earlier non-scheduled generation snapshot', async () => {
    const metadata = { userId: 'user-1', tenantId: 'tenant-1', scheduleSteered: false };
    const getJob = async () => ({ createdAt: 123, metadata });
    expect(await hasScheduledGenerationContext(req, getJob)).toBe(false);
    metadata.scheduleSteered = true;
    expect(await hasScheduledGenerationContext(req, getJob)).toBe(true);
  });

  it.each([
    undefined,
    { createdAt: 124, metadata: { userId: 'user-1', tenantId: 'tenant-1' } },
    { createdAt: 123, metadata: { userId: 'other', tenantId: 'tenant-1' } },
    { createdAt: 123, metadata: { userId: 'user-1', tenantId: 'other' } },
  ])('fails closed for missing or mismatched generation identity', async (job) => {
    await expect(hasScheduledGenerationContext(req, async () => job)).rejects.toThrow();
  });

  it('uses trusted schedule request provenance without another job lookup', async () => {
    const getJob = jest.fn();
    expect(await hasScheduledGenerationContext({ ...req, _isScheduledFire: true }, getJob)).toBe(
      true,
    );
    expect(getJob).not.toHaveBeenCalled();
  });
});
