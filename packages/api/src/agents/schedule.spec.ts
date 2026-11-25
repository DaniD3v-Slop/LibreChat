import Keyv from 'keyv';
import { Types } from 'mongoose';
import { Constants } from '@librechat/agents';
import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import type { IRole } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { WireSchedule } from '~/schedules/handlers';
import type { ScheduleToolName } from './schedule';
import type { ServerRequest } from '~/types/http';
import { createScheduleTool, SCHEDULE_TOOL_NAMES } from './schedule';

const userId = '000000000000000000000001';
const input = {
  name: 'Reminder',
  description: 'Follow-up',
  prompt: { text: 'Follow up', file_ids: ['file-1'] },
  cadence: { frequency: 'once', at: '2099-11-05T09:00' },
  mode: 'fire',
};
function payloadFor(name: ScheduleToolName): object {
  if (name === 'create_schedule') return input;
  if (name === 'list_schedules') return {};
  return name === 'update_schedule' ? { id: 'schedule-1', enabled: false } : { id: 'schedule-1' };
}

function setup() {
  const req: ServerRequest = Object.assign({} as ServerRequest, {
    body: { conversationId: 'conversation-1', timezone: 'Europe/Vienna' },
    turnStartedAt: 42,
    user: { id: userId, role: 'USER' },
    config: {
      interfaceConfig: { schedules: true },
      endpoints: { agents: { capabilities: [AgentCapabilities.schedule_chat] } },
    },
  });
  const record: WireSchedule = {
    id: 'schedule-1',
    user: new Types.ObjectId(userId),
    agent_id: 'agent-1',
    name: input.name,
    description: input.description,
    prompt: input.prompt.text,
    cadence: { frequency: 'once', at: input.cadence.at },
    timezone: 'Europe/Vienna',
    target: 'new',
    enabled: true,
    file_ids: input.prompt.file_ids,
    conversationId: 'conversation-1',
    originConversationId: 'origin-1',
    chatProjectId: 'project-1',
    configRevision: 3,
    nextRunAt: new Date('2099-11-05T08:00:00Z'),
    lastRun: {
      status: 'success',
      firedAt: new Date('2026-11-04T12:00:00Z'),
      conversationId: 'prior-run',
      error: 'private-run-detail',
    },
    runCount: 1,
    failureCount: 0,
    createdAt: new Date('2026-11-04T11:00:00Z'),
    updatedAt: new Date('2026-11-04T12:00:00Z'),
  };
  const getRoleByName = jest.fn(
    async (): Promise<IRole | null> =>
      ({
        permissions: {
          [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
        },
      }) as IRole,
  );
  const handler = (status: number, body: object) =>
    jest.fn(async (_request: ServerRequest, response: Response) => {
      response.status(status).json(body);
    });
  const handlers = {
    createSchedule: handler(201, record),
    listSchedules: handler(200, { schedules: [record], limits: { maxPerUser: 10 } }),
    getSchedule: handler(200, record),
    updateSchedule: handler(200, { ...record, configRevision: 4 }),
    deleteSchedule: handler(202, { id: record.id }),
  };
  const cache = new Keyv<number>();
  const revisions = {
    get: (key: string) => cache.get(key),
    set: (key: string, revision: number) => cache.set(key, revision),
    delete: (key: string) => cache.delete(key),
  };
  const getConversation = jest.fn(async () => ({
    conversationId: 'conversation-1',
    user: userId,
    agent_id: 'agent-1',
    chatProjectId: 'project-1',
  }));
  const getGenerationJob = jest.fn(async () => ({ createdAt: 42, metadata: { userId } }));
  const deps = {
    req,
    agentId: 'agent-1',
    getRoleByName,
    getConversation,
    getGenerationJob,
    handlers,
    revisions,
  };
  const invoke = async (name: ScheduleToolName, payload: object = {}, callId = 'call-1') => {
    const result = await createScheduleTool(name, deps).invoke(payload, {
      toolCall: { id: callId, name, args: payload, type: 'tool_call' },
    });
    return JSON.parse(typeof result === 'string' ? result : String(result.content));
  };
  return { ...deps, record, invoke };
}

describe('native schedule CRUD tools', () => {
  it('returns model-facing records without ownership, revision or default timezone fields', async () => {
    const h = setup();
    expect(await h.invoke('create_schedule', input)).toEqual({ id: 'schedule-1' });
    const expected = {
      id: 'schedule-1',
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      cadence: input.cadence,
      mode: 'fire',
      enabled: true,
      nextRunAt: '2099-11-05T08:00:00.000Z',
      lastRun: { status: 'success', firedAt: '2026-11-04T12:00:00.000Z' },
      runCount: 1,
      failureCount: 0,
      createdAt: '2026-11-04T11:00:00.000Z',
      updatedAt: '2026-11-04T12:00:00.000Z',
    };
    expect(await h.invoke('get_schedule', { id: 'schedule-1' })).toEqual(expected);
    expect(await h.invoke('list_schedules')).toEqual({ schedules: [expected] });
    expect(
      await h.invoke('update_schedule', { id: 'schedule-1', description: 'Metadata only' }),
    ).toEqual(expected);
    expect(h.handlers.updateSchedule.mock.calls[0][0].body).toEqual({
      expectedConfigRevision: 3,
      description: 'Metadata only',
    });
  });
  it('uses the browser timezone for recurring creates and flat cadence updates', async () => {
    const h = setup();
    h.req.body.timezone = 'America/New_York';
    const cadence = { frequency: 'daily', hour: 19, minute: 25 };
    await h.invoke('create_schedule', { ...input, cadence });
    expect(h.handlers.createSchedule.mock.calls[0][0].body).toMatchObject({
      cadence,
      timezone: 'America/New_York',
    });
    await h.invoke('get_schedule', { id: 'schedule-1' });
    await h.invoke('update_schedule', { id: 'schedule-1', cadence });
    expect(h.handlers.updateSchedule.mock.calls[0][0].body).toEqual({
      expectedConfigRevision: 3,
      cadence,
      timezone: 'America/New_York',
    });
  });
  it('accepts an explicit cadence timezone without a browser default and exposes overrides on reads', async () => {
    const h = setup();
    delete h.req.body.timezone;
    const cadence = { ...input.cadence, timezone: 'Asia/Tokyo' };
    expect(await h.invoke('create_schedule', { ...input, cadence })).toEqual({ id: 'schedule-1' });
    expect(h.handlers.createSchedule.mock.calls[0][0].body).toMatchObject({
      cadence: input.cadence,
      timezone: 'Asia/Tokyo',
    });
    h.record.timezone = 'Asia/Tokyo';
    expect(await h.invoke('get_schedule', { id: 'schedule-1' })).toMatchObject({ cadence });
  });
  it.each([undefined, 'not/a/timezone'])(
    'refuses timed writes without a valid timezone: %s',
    async (timezone) => {
      const h = setup();
      Object.assign(h.req.body, { timezone });
      expect(await h.invoke('create_schedule', input)).toEqual({
        code: 'schedule_chat_missing_timezone',
      });
      expect(h.handlers.createSchedule).not.toHaveBeenCalled();
      await h.invoke('get_schedule', { id: 'schedule-1' });
      expect(
        await h.invoke('update_schedule', { id: 'schedule-1', cadence: input.cadence }),
      ).toEqual({ code: 'schedule_chat_missing_timezone' });
      expect(h.handlers.updateSchedule).not.toHaveBeenCalled();
      expect(
        await h.invoke('update_schedule', { id: 'schedule-1', description: 'Rename only' }),
      ).toMatchObject({ id: 'schedule-1' });
      expect(await h.invoke('list_schedules')).toHaveProperty('schedules');
    },
  );
  it.each(['list_schedules', 'get_schedule'] as const)(
    'allows scheduled read-only %s with USE and approvals off',
    async (name) => {
      const h = setup();
      Object.assign(h.req, { _isScheduledFire: true });
      h.req.config!.endpoints!.agents!.toolApproval = { enabled: false };
      h.getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: false },
        },
      } as IRole);
      expect(await h.invoke(name, payloadFor(name))).not.toHaveProperty('code');
      expect(h.getGenerationJob).not.toHaveBeenCalled();
    },
  );
  it('binds continuation edits using a legacy hourly record without a revision', async () => {
    const h = setup();
    h.record.cadence = { frequency: 'hourly', hour: 0, minute: 15 };
    h.record.target = 'continue';
    delete h.record.configRevision;
    const read = await h.invoke('get_schedule', { id: 'schedule-1' });
    expect(read.mode).toBe('continue');
    expect(read.cadence).toEqual({ frequency: 'hourly', minute: 15 });
    await h.invoke('update_schedule', { id: 'schedule-1', mode: 'continue' });
    expect(h.handlers.updateSchedule.mock.calls[0][0].body).toEqual({
      expectedConfigRevision: 0,
      target: 'continue',
      conversationId: 'conversation-1',
    });
  });
  it.each([202, 200])(
    'projects delete status %s without an HTTP success envelope',
    async (status) => {
      const h = setup();
      h.handlers.deleteSchedule.mockImplementationOnce(async (_req, res) => {
        res.status(status).json({ id: 'schedule-1' });
      });
      expect(await h.invoke('delete_schedule', { id: 'schedule-1' })).toEqual({
        id: 'schedule-1',
        status: status === 202 ? 'deleting' : 'deleted',
      });
    },
  );
  it('refuses a scheduled steer arriving during conversation lookup', async () => {
    const h = setup();
    const conversation = await h.getConversation();
    h.getConversation.mockImplementationOnce(async () => {
      h.getGenerationJob.mockResolvedValue({
        createdAt: 42,
        metadata: Object.assign({ userId }, { scheduleSteered: true }),
      });
      return conversation;
    });
    expect(await h.invoke('create_schedule', input)).toEqual({ code: 'schedule_chat_recursion' });
    expect(h.handlers.createSchedule).not.toHaveBeenCalled();
  });
  it.each(['get', 'set'] as const)(
    'refuses a scheduled steer arriving while revision %s awaits',
    async (method) => {
      const h = setup();
      await h.invoke('get_schedule', { id: 'schedule-1' });
      const steer = async () => {
        await Promise.resolve();
        h.getGenerationJob.mockResolvedValue({
          createdAt: 42,
          metadata: Object.assign({ userId }, { scheduleSteered: true }),
        });
      };
      if (method === 'get')
        jest.spyOn(h.revisions, 'get').mockImplementationOnce(async () => {
          await steer();
          return 3;
        });
      else
        jest.spyOn(h.revisions, 'set').mockImplementationOnce(async () => {
          await steer();
          return true;
        });
      expect(await h.invoke('update_schedule', { id: 'schedule-1', enabled: false })).toEqual({
        code: 'schedule_chat_recursion',
      });
      expect(h.handlers.updateSchedule).not.toHaveBeenCalled();
    },
  );
  it('refuses an update when its attempt revision could not be stored', async () => {
    const h = setup();
    await h.invoke('get_schedule', { id: 'schedule-1' });
    jest.spyOn(h.revisions, 'set').mockResolvedValueOnce(false);
    expect(await h.invoke('update_schedule', { id: 'schedule-1', enabled: false })).toEqual({
      code: 'schedule_chat_failed',
    });
    expect(h.handlers.updateSchedule).not.toHaveBeenCalled();
  });
  it('keeps handler failures inside the tool error boundary and preserves HTTP errors', async () => {
    const h = setup();
    h.handlers.createSchedule.mockRejectedValueOnce(new Error('UNSAFE_PROVIDER_PAYLOAD'));
    expect(await h.invoke('create_schedule', input)).toEqual({ code: 'schedule_chat_failed' });
    h.handlers.createSchedule.mockImplementationOnce(async (_req, res) => {
      res.status(409).json({ error: 'Schedule changed' });
    });
    expect(await h.invoke('create_schedule', input)).toEqual({
      status: 409,
      body: { error: 'Schedule changed' },
    });
  });
  it('refuses trusted scheduled requests before invoking a handler', async () => {
    const h = setup();
    Object.assign(h.req, { _isScheduledFire: true });
    expect(await h.invoke('create_schedule', input)).toMatchObject({
      code: 'schedule_chat_recursion',
    });
    for (const handle of Object.values(h.handlers)) expect(handle).not.toHaveBeenCalled();
  });
});

it.each(SCHEDULE_TOOL_NAMES)(
  'enforces the shared opt-in and USE permission before %s',
  async (name) => {
    const h = setup();
    const payload = payloadFor(name);
    const allowedRole = await h.getRoleByName();
    h.getRoleByName.mockResolvedValue({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: false, [Permissions.CREATE]: true },
      },
    } as IRole);
    expect(await h.invoke(name, payload)).toMatchObject({ code: 'schedule_chat_forbidden' });
    expect(h.getConversation).not.toHaveBeenCalled();
    h.getRoleByName.mockResolvedValue(allowedRole);
    h.req.config!.endpoints!.agents!.capabilities = [];
    expect(await h.invoke(name, payload)).toMatchObject({ code: 'schedule_chat_forbidden' });
    for (const handle of Object.values(h.handlers)) expect(handle).not.toHaveBeenCalled();
  },
);

it.each(['create_schedule', 'update_schedule', 'delete_schedule'] as const)(
  'requires CREATE permission for %s',
  async (name) => {
    const h = setup();
    h.getRoleByName.mockResolvedValue({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: false },
      },
    } as IRole);
    expect(await h.invoke(name, payloadFor(name))).toMatchObject({
      code: 'schedule_chat_forbidden',
    });
    expect(h.getGenerationJob).not.toHaveBeenCalled();
  },
);

it.each([Constants.PROGRAMMATIC_TOOL_CALLING, Constants.BASH_PROGRAMMATIC_TOOL_CALLING])(
  'refuses nested %s dispatch for all schedule tools',
  async (nested) => {
    const h = setup();
    for (const name of SCHEDULE_TOOL_NAMES) {
      const payload = payloadFor(name);
      const result = await createScheduleTool(name, h).invoke(payload, {
        metadata: { [nested]: true },
        toolCall: { name, id: 'nested-call', args: payload, type: 'tool_call' },
      });
      expect(
        JSON.parse(typeof result === 'string' ? result : String(result.content)),
      ).toMatchObject({ code: 'schedule_chat_forbidden' });
    }
    for (const handle of Object.values(h.handlers)) expect(handle).not.toHaveBeenCalled();
  },
);
