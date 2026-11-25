import type { AgentContinueTriggerEnvelope } from '../agents/triggers/envelope';
import {
  AgentTriggerExecutionError,
  createAgentTriggerExecutionHost,
} from '../agents/triggers/host';
import { createScheduleContinueResolver } from './continuation';

const envelope: AgentContinueTriggerEnvelope = {
  version: 1,
  mode: 'continue',
  requestId: 'r1',
  deliveryId: 'd1',
  receivedAt: 100,
  principal: { userId: 'user-1', tenantId: 't1' },
  target: { agentId: 'agent-1', conversationId: 'chat-1', parentMessageId: 'placeholder' },
  event: {
    id: 'event-1',
    type: 'schedule.occurrence',
    occurredAt: 100,
    source: { type: 'schedule', id: 'schedule-1' },
  },
  input: 'Follow up',
  run: { metadata: { configRevision: 4, manual: false } },
};

function setup() {
  const getConvo = jest.fn(async () => ({ agent_id: 'agent-1', tenantId: 't1' }));
  const getMessages = jest.fn(async () => [{ messageId: 'latest-response' }]);
  const getGenerationJob = jest.fn(
    async (): Promise<{ status?: string; createdAt?: number } | null> => null,
  );
  const resolve = createScheduleContinueResolver({
    methods: { getConvo, getMessages },
    getGenerationJob,
  });
  return { resolve, getConvo, getMessages, getGenerationJob };
}

describe('scheduled continuation admission', () => {
  it('resolves the latest eligible response for the originating conversation', async () => {
    const { resolve, getMessages } = setup();
    await expect(resolve(envelope, { idempotencyKey: 'key-1' })).resolves.toMatchObject({
      status: 'ready',
      input: 'Follow up',
      parentMessageId: 'latest-response',
    });
    expect(getMessages).toHaveBeenCalledWith(
      { user: 'user-1', conversationId: 'chat-1', isCreatedByUser: false },
      'messageId createdAt',
      { sort: { createdAt: -1, _id: -1 }, limit: 1 },
    );
  });

  it.each(['running', 'requires_action'])(
    'defers %s conversations without consuming retry budget',
    async (status) => {
      const { resolve, getGenerationJob, getMessages } = setup();
      getGenerationJob.mockResolvedValue({ status, createdAt: 10 });
      await expect(resolve(envelope, { idempotencyKey: 'key-1' })).rejects.toMatchObject({
        code: 'PARENT_NOT_READY',
        retryable: true,
        deferWithoutAttempt: true,
      });
      expect(getMessages).not.toHaveBeenCalled();
    },
  );

  it.each([
    { agent_id: 'other-agent', tenantId: 't1' },
    { agent_id: 'agent-1', tenantId: 'other-tenant' },
  ])('rejects a changed target', async (target) => {
    const { resolve, getConvo, getMessages } = setup();
    getConvo.mockResolvedValue(target);
    await expect(resolve(envelope, { idempotencyKey: 'key-1' })).rejects.toMatchObject({
      code: 'SCHEDULE_TARGET_UNAVAILABLE',
      retryable: false,
    });
    expect(getMessages).not.toHaveBeenCalled();
  });
});

it.each(['getConvo', 'getGenerationJob', 'getMessages'] as const)(
  'redacts unexpected %s failures before they reach durable delivery errors',
  async (method) => {
    const fixture = setup();
    fixture[method].mockRejectedValue(new Error('PRIVATE-DIAGNOSTIC-MARKER'));
    const host = createAgentTriggerExecutionHost({
      getBaseUrl: () => 'http://127.0.0.1:3080',
      mintToken: () => 'local-test-token',
      fetch: jest.fn(),
      prepareContinue: fixture.resolve,
    });
    const captured: unknown[] = [];
    await Promise.resolve()
      .then(() => fixture.resolve(envelope, { idempotencyKey: 'key-1' }))
      .catch((error: unknown) => captured.push(error));
    await host.dispatch(envelope).catch((error: unknown) => captured.push(error));
    expect(captured).toHaveLength(2);
    for (const error of captured) {
      expect(error).toBeInstanceOf(AgentTriggerExecutionError);
      expect(error).toMatchObject({
        code: 'SCHEDULE_TARGET_UNAVAILABLE',
        status: 503,
        retryable: true,
        certainty: 'definite',
      });
      expect((error as Error).message).not.toContain('PRIVATE-DIAGNOSTIC-MARKER');
    }
  },
);
