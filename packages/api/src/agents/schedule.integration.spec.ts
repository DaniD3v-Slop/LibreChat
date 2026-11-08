import { Keyv } from 'keyv';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import type { TCreateScheduleToolInput } from 'librechat-data-provider';
import type { IRole } from '@librechat/data-schemas';
import type { SchedulesHandlersDeps } from '~/schedules/handlers';
import type { ScheduleLimits } from '~/schedules/types';
import type { ScheduleToolName } from './schedule';
import type { ServerRequest } from '~/types';
import { DEFAULT_SCHEDULE_LIMITS, SCHEDULE_FILE_HOLD } from '~/schedules/types';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createSchedulesHandlers } from '~/schedules/handlers';
import { createScheduleTool } from './schedule';

let mongo: MongoMemoryServer;
let models: ReturnType<typeof createModels>;
let methods: ReturnType<typeof createMethods>;
const jobManagers: GenerationJobManagerClass[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  models = createModels(mongoose);
  methods = createMethods(mongoose);
  await Promise.all([models.Schedule.init(), models.ScheduleRun.init()]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 60_000);

afterEach(async () => {
  await Promise.all(
    jobManagers.splice(0).map((manager) => manager.destroy({ settlementBudgetMs: 0 })),
  );
});

beforeEach(async () => {
  await Promise.all([
    models.Schedule.deleteMany({}),
    models.ScheduleRun.deleteMany({}),
    models.Conversation.deleteMany({}),
    models.ChatProject.deleteMany({}),
    models.File.deleteMany({}),
  ]);
});

interface ToolResult {
  id?: string;
  code?: string;
  status?: number | 'deleted' | 'deleting';
  body?: { error?: string };
  schedules?: Array<{ id: string }>;
}

async function createProject(userId: string, name: string): Promise<string> {
  const project = await methods.createChatProject(userId, { name });
  if (!project._id) {
    throw new Error('Created project has no ID');
  }
  return project._id.toString();
}

async function setup(
  options: {
    userId?: string;
    projectId?: string;
    revisions?: Keyv<number>;
  } = {},
) {
  const userId = options.userId ?? new mongoose.Types.ObjectId().toHexString();
  const revisions = options.revisions ?? new Keyv<number>();
  const conversationId = randomUUID();
  const agentId = 'agent-current';
  const projectId = options.projectId ?? (await createProject(userId, 'Work'));
  await models.Conversation.create({
    conversationId,
    user: userId,
    agent_id: agentId,
    endpoint: 'agents',
    chatProjectId: projectId,
  });
  const fileId = randomUUID();
  const originalExpiry = new Date(Date.now() + 60_000);
  await models.File.create({
    user: userId,
    file_id: fileId,
    filename: 'generated-report.pdf',
    filepath: '/test/generated-report.pdf',
    type: 'application/pdf',
    bytes: 100,
    context: 'assistants_output',
    expiresAt: originalExpiry,
  });

  const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  const jobManager = new GenerationJobManagerClass({ jobStore, cleanupOnComplete: false });
  jobManager.initialize();
  jobManagers.push(jobManager);
  const job = await jobManager.createJob(conversationId, userId, conversationId);
  const req = {
    body: { conversationId, timezone: 'Europe/Vienna' },
    turnStartedAt: job.createdAt,
    user: { id: userId, role: 'USER' },
    config: {
      interfaceConfig: { schedules: true },
      endpoints: { agents: { capabilities: [AgentCapabilities.schedule_chat] } },
    },
  } as ServerRequest;
  const limits: ScheduleLimits = { ...DEFAULT_SCHEDULE_LIMITS };
  const deps: SchedulesHandlersDeps = {
    methods,
    getLimits: async () => limits,
    getConversation: methods.getConvo,
    canViewAgent: async () => true,
    canUseProject: async (id, owner) => (await methods.getChatProject(owner, id)) != null,
    filterOwnedFileIds: async (ids, owner) => {
      const files = await methods.getFiles({ user: owner, file_id: { $in: ids } });
      if (files == null) {
        throw new Error('Attachment lookup failed');
      }
      return files.map((file) => file.file_id);
    },
    markFilesUsed: async (ids, owner) => {
      await methods.extendFilesTTL(ids, SCHEDULE_FILE_HOLD, { user: owner });
      const files = await methods.getFiles({ user: owner, file_id: { $in: ids } });
      if (files?.length !== ids.length) {
        throw new Error('Attachment disappeared');
      }
    },
    preflightMCP: async () => [],
    fireNow: async () => null,
    deleteSchedule: async (id, owner, scope) => {
      if (!(await methods.markScheduleDeleting(id, owner, scope))) return 'not_found';
      await methods.deleteScheduleById(id, owner);
      return 'deleted';
    },
    isUserDeleting: async () => false,
  };
  const getRoleByName = async (): Promise<IRole> =>
    ({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
      },
    }) as IRole;
  const handlers = createSchedulesHandlers(deps);
  const input: TCreateScheduleToolInput = {
    name: 'Report follow-up',
    description: 'Follow up on the generated report',
    prompt: { text: 'Summarize the report', file_ids: [fileId] },
    cadence: { frequency: 'once', at: '2099-11-05T09:00' },
    mode: 'fire',
  };
  const operate = async (
    name: ScheduleToolName,
    payload: object,
    callId = 'call-1',
    runtimeAgentId = agentId,
  ) => {
    const instance = createScheduleTool(name, {
      req,
      agentId: runtimeAgentId,
      getRoleByName,
      getConversation: methods.getConvo,
      getGenerationJob: (id) => jobManager.getJob(id),
      handlers,
      revisions,
    });
    const output = await instance.invoke(payload, {
      toolCall: { id: callId, name, args: payload, type: 'tool_call' },
    });
    const result: ToolResult = JSON.parse(
      typeof output === 'string' ? output : String(output.content),
    );
    return result;
  };
  const invoke = (
    payload: TCreateScheduleToolInput = input,
    callId = 'call-1',
    runtimeAgentId = agentId,
  ) => operate('create_schedule', payload, callId, runtimeAgentId);
  return {
    userId,
    conversationId,
    agentId,
    projectId,
    fileId,
    originalExpiry,
    jobStore,
    jobManager,
    req,
    limits,
    revisions,
    input,
    invoke,
    operate,
  };
}

describe('schedule tools through the shared CRUD handlers and MongoDB', () => {
  it('creates more than ten schedules by default without quota reads', async () => {
    const h = await setup();
    const count = jest.spyOn(methods, 'countSchedulesByUser');
    try {
      const results = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          h.invoke({ ...h.input, prompt: { text: 'Future follow-up' } }, `create-${index}`),
        ),
      );
      expect(results.every((result) => typeof result.id === 'string')).toBe(true);
      expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(11);
      expect(count).not.toHaveBeenCalled();
    } finally {
      count.mockRestore();
    }
  });

  it('scopes reused call IDs to the originating generation epoch', async () => {
    const h = await setup();
    const first = await h.invoke();
    expect(first.id).toEqual(expect.any(String));
    await h.jobStore.deleteJob(h.conversationId, h.req.turnStartedAt);
    const replacement = await h.jobManager.createJob(h.conversationId, h.userId, h.conversationId);
    expect(replacement.createdAt).not.toBe(h.req.turnStartedAt);
    h.req.turnStartedAt = replacement.createdAt;

    const second = await h.invoke();
    expect(second.id).toEqual(expect.any(String));
    expect(second.id).not.toBe(first.id);
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(2);
  });

  it('replays the saved agent identity across runtime suffix changes', async () => {
    const h = await setup();
    const first = await h.invoke(h.input, 'call-1', `${h.agentId}____1`);
    expect(first.id).toEqual(expect.any(String));

    expect(await h.invoke(h.input, 'call-1', `${h.agentId}____2`)).toMatchObject({
      id: first.id,
    });
    expect(await methods.getScheduleById(String(first.id), h.userId)).toMatchObject({
      agent_id: h.agentId,
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
    await methods.updateScheduleById(String(first.id), h.userId, { description: 'Unseen UI edit' });
    expect(await h.invoke(h.input, 'call-1', `${h.agentId}____2`)).toEqual({ id: first.id });
    expect(
      await h.operate(
        'update_schedule',
        {
          id: first.id,
          description: 'Based on the original create',
        },
        'after-create-replay',
      ),
    ).toMatchObject({ status: 409 });
    expect(await methods.getScheduleById(String(first.id), h.userId)).toMatchObject({
      description: 'Unseen UI edit',
      configRevision: 1,
    });
  });

  it('persists a user-owned armed schedule with normalized timing and a retained generated attachment', async () => {
    const h = await setup();
    const result = await h.invoke();
    expect(result).toEqual({ id: expect.any(String) });
    const saved = await methods.getScheduleById(String(result.id), h.userId);
    expect(saved).toMatchObject({
      name: h.input.name,
      description: h.input.description,
      originConversationId: h.conversationId,
      prompt: h.input.prompt.text,
      agent_id: h.agentId,
      target: 'new',
      chatProjectId: h.projectId,
      cadence: { frequency: 'once', at: '2099-11-05T09:00' },
      timezone: 'Europe/Vienna',
      file_ids: [h.fileId],
      enabled: true,
    });
    expect(saved?.nextRunAt).toBeInstanceOf(Date);
    const attachment = await models.File.findOne({ file_id: h.fileId }).lean();
    expect(attachment?.expiresAt?.getTime()).toBeGreaterThan(h.originalExpiry.getTime());
    expect(attachment?.usage).toBe(0);
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
  });

  it('resolves concurrent retries of the same call to one persisted schedule', async () => {
    const h = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => h.invoke()));
    expect(results.every((result) => typeof result.id === 'string')).toBe(true);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
  });

  it('does not disclose a committed schedule after the originating chat moves out of its scope', async () => {
    const h = await setup();
    const first = await h.invoke();
    expect(first.id).toEqual(expect.any(String));
    const movedProjectId = await createProject(h.userId, 'Moved');
    await models.Conversation.updateOne(
      { conversationId: h.conversationId },
      { chatProjectId: movedProjectId },
    );

    expect([404, 409]).toContain((await h.invoke()).status);
    expect(await methods.getScheduleById(String(first.id), h.userId)).toMatchObject({
      chatProjectId: h.projectId,
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
  });

  it('refuses a reused call identity carrying a different prompt', async () => {
    const h = await setup();
    expect(await h.invoke()).toEqual({ id: expect.any(String) });

    expect(
      await h.invoke({ ...h.input, prompt: { text: 'A different scheduled instruction' } }),
    ).toMatchObject({
      status: 409,
      body: { error: 'clientRequestId was already used to create a different schedule' },
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
  });

  it('keeps the same call ID isolated between requesting users', async () => {
    const first = await setup();
    const second = await setup();
    const [a, b] = await Promise.all([first.invoke(), second.invoke()]);
    expect(a.id).toEqual(expect.any(String));
    expect(b.id).toEqual(expect.any(String));
    expect(a.id).not.toBe(b.id);
    expect(await methods.getScheduleById(String(a.id), second.userId)).toBeNull();
    expect(await methods.getScheduleById(String(b.id), first.userId)).toBeNull();
  });

  it('enforces the user limit while replaying active and completed schedules', async () => {
    const h = await setup();
    h.limits.maxPerUser = 1;
    const first = await h.invoke();
    expect(first.id).toEqual(expect.any(String));
    expect(await h.invoke()).toEqual({ id: first.id });
    expect(await h.invoke(h.input, 'call-2')).toMatchObject({
      status: 400,
      body: { error: 'Schedule limit reached (1). Delete a schedule to add another.' },
    });
    await models.Schedule.updateOne(
      { id: first.id },
      { $set: { enabled: false, disabledReason: 'completed' }, $unset: { nextRunAt: 1 } },
    );
    expect(await h.invoke()).toEqual({ id: first.id });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
  });

  it("rejects another user's attachment through the shared ownership lookup", async () => {
    const owner = await setup();
    const other = await setup();
    expect(
      await other.invoke({
        ...other.input,
        prompt: { text: 'Read this report', file_ids: [owner.fileId] },
      }),
    ).toMatchObject({ status: 400, body: { error: 'One or more attached files were not found' } });
    expect(await models.Schedule.countDocuments({ user: other.userId })).toBe(0);
  });

  it.each(['continue', 'steer'] as const)(
    'persists the host-bound %s conversation and real project',
    async (mode) => {
      const h = await setup();
      const result = await h.invoke({ ...h.input, mode });
      expect(result).toEqual({ id: expect.any(String) });
      expect(await methods.getScheduleById(String(result.id), h.userId)).toMatchObject({
        target: mode,
        conversationId: h.conversationId,
        chatProjectId: h.projectId,
        agent_id: h.agentId,
      });
    },
  );

  it.each(['user', 'agent_id', 'tenantId'] as const)(
    'refuses a current conversation whose %s is outside the authenticated scope',
    async (field) => {
      const h = await setup();
      await models.Conversation.collection.updateOne(
        { conversationId: h.conversationId },
        {
          $set: {
            [field]: field === 'user' ? new mongoose.Types.ObjectId().toHexString() : 'other',
          },
        },
      );

      expect(await h.invoke({ ...h.input, mode: 'continue' })).toMatchObject({
        code: 'schedule_chat_missing_context',
      });
      expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(0);
    },
  );

  it("returns the shared handler's past-time rejection without inserting a row", async () => {
    const h = await setup();
    expect(
      await h.invoke({ ...h.input, cadence: { frequency: 'once', at: '2000-01-01T09:00' } }),
    ).toMatchObject({
      status: 400,
      body: { error: 'Schedule time is in the past' },
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(0);
  });

  it('enforces the same recurring interval floor as the Schedules UI', async () => {
    const h = await setup();
    expect(
      await h.invoke({
        ...h.input,
        cadence: { frequency: 'cron', expression: '* * * * *' },
      }),
    ).toMatchObject({
      status: 400,
      body: { error: 'Schedule interval must be at least 60 minutes' },
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(0);
  });

  it("respects required and pinned project policies instead of broadening the tool's scope", async () => {
    const h = await setup();
    h.limits.requireProject = true;
    await models.Conversation.updateOne(
      { conversationId: h.conversationId },
      { $unset: { chatProjectId: 1 } },
    );
    expect(await h.invoke()).toMatchObject({
      status: 400,
      body: { error: 'Scheduled chats must be assigned to a project' },
    });
    await models.Conversation.updateOne(
      { conversationId: h.conversationId },
      { chatProjectId: h.projectId },
    );
    h.limits.projectId = await createProject(h.userId, 'Pinned');
    expect(await h.invoke()).toMatchObject({
      status: 400,
      body: { error: 'Scheduled chats are pinned to a specific project' },
    });
    expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(0);
  });
});

it('creates, reads, updates and deletes model records through the native tool adapters', async () => {
  const h = await setup();
  const created = await h.invoke();
  expect(created).toEqual({ id: expect.any(String) });
  const id = String(created.id);
  const saved = await methods.getScheduleById(id, h.userId);
  for (const outsideScope of [
    { agent_id: 'agent-other' },
    { chatProjectId: await createProject(h.userId, 'Other') },
    { tenantId: 'other' },
  ]) {
    const foreign = await methods.createSchedule({
      ...saved,
      ...outsideScope,
      id: randomUUID(),
      _id: undefined,
      clientRequestId: undefined,
      clientRequestDigest: undefined,
      slot: undefined,
    });
    expect(await h.operate('get_schedule', { id: foreign.id })).toMatchObject({ status: 404 });
    expect(await h.operate('update_schedule', { id: foreign.id, enabled: false })).toEqual({
      code: 'schedule_chat_read_required',
      id: foreign.id,
    });
    expect(await h.operate('delete_schedule', { id: foreign.id })).toMatchObject({ status: 404 });
    expect(await methods.getScheduleById(foreign.id, h.userId)).toMatchObject({ enabled: true });
  }
  const listed = await h.operate('list_schedules', {});
  expect(listed).toMatchObject({ schedules: [{ id, prompt: h.input.prompt }] });
  expect(Object.keys(listed)).toEqual(['schedules']);
  const current = await h.operate('get_schedule', { id });
  expect(current).toMatchObject({ id, prompt: h.input.prompt });
  const updated = await h.operate('update_schedule', {
    id,
    description: 'Follow up on the report',
  });
  expect(updated).toMatchObject({ id, description: 'Follow up on the report' });
  for (const record of [current, updated, ...(listed.schedules ?? [])]) {
    for (const field of [
      'user',
      'tenantId',
      'agent_id',
      'chatProjectId',
      'configRevision',
      'originConversationId',
      'status',
      'body',
    ]) {
      expect(record).not.toHaveProperty(field);
    }
  }
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'Follow up on the report',
    originConversationId: h.conversationId,
    prompt: h.input.prompt.text,
    file_ids: [h.fileId],
  });
  expect(await h.operate('delete_schedule', { id })).toEqual({ id, status: 'deleted' });
  expect(await methods.getScheduleById(id, h.userId)).toBeNull();
  expect(await h.operate('delete_schedule', { id })).toMatchObject({ status: 404 });
});

it('allows scheduled reads but refuses all three scheduled writes through real job metadata', async () => {
  const h = await setup();
  const created = await h.invoke();
  const id = String(created.id);
  await h.jobManager.updateMetadata(
    h.conversationId,
    { scheduleSteered: true },
    h.req.turnStartedAt,
  );
  expect(await h.operate('list_schedules', {})).toMatchObject({
    schedules: [{ id }],
  });
  expect(await h.operate('get_schedule', { id })).toMatchObject({
    id,
  });
  expect(await h.invoke(h.input, 'another-call')).toMatchObject({
    code: 'schedule_chat_recursion',
  });
  expect(
    await h.operate('update_schedule', {
      id,
      enabled: false,
    }),
  ).toMatchObject({ code: 'schedule_chat_recursion' });
  expect(await h.operate('delete_schedule', { id })).toMatchObject({
    code: 'schedule_chat_recursion',
  });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({ enabled: true });
  expect(await models.Schedule.countDocuments({ user: h.userId })).toBe(1);
});

it('uses an explicit cadence timezone instead of the host default when supplied', async () => {
  const h = await setup();
  const created = await h.invoke({
    ...h.input,
    cadence: { frequency: 'once', at: '2099-11-05T09:00', timezone: 'UTC' },
  });

  expect(created).toEqual({ id: expect.any(String) });
  expect(await methods.getScheduleById(String(created.id), h.userId)).toMatchObject({
    cadence: { frequency: 'once', at: '2099-11-05T09:00' },
    timezone: 'UTC',
    nextRunAt: new Date('2099-11-05T09:00:00Z'),
  });
});

it('requires an observation in this chat even when another chat for the same user observed the schedule', async () => {
  const h = await setup();
  const created = await h.invoke();
  const id = String(created.id);
  const other = await setup({ userId: h.userId, projectId: h.projectId, revisions: h.revisions });

  expect(await other.operate('update_schedule', { id, description: 'Unobserved change' })).toEqual({
    code: 'schedule_chat_read_required',
    id,
  });
  expect(await other.operate('list_schedules', {})).toMatchObject({ schedules: [{ id }] });
  expect(
    await other.operate('update_schedule', { id, description: 'Observed change' }, 'after-list'),
  ).toMatchObject({ id, description: 'Observed change' });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'Observed change',
    originConversationId: h.conversationId,
    configRevision: 1,
  });
});

it('requires a fresh read after a real UI edit wins the revision fence', async () => {
  const h = await setup();
  const created = await h.invoke();
  const id = String(created.id);
  await methods.updateScheduleById(id, h.userId, { description: 'Edited in the Schedules UI' });

  expect(
    await h.operate('update_schedule', { id, description: 'Stale change' }, 'stale-update'),
  ).toMatchObject({ status: 409 });
  expect(
    await h.operate('update_schedule', { id, description: 'No read yet' }, 'unobserved-update'),
  ).toEqual({ code: 'schedule_chat_read_required', id });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'Edited in the Schedules UI',
    configRevision: 1,
  });
  expect(await h.operate('get_schedule', { id })).toMatchObject({
    id,
    description: 'Edited in the Schedules UI',
  });
  expect(
    await h.operate('update_schedule', { id, description: 'After reading' }, 'fresh-update'),
  ).toMatchObject({ id, description: 'After reading' });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'After reading',
    configRevision: 2,
  });
});

it('remembers committed revisions across tool instances and later turns in the same chat', async () => {
  const h = await setup();
  const created = await h.invoke();
  const id = String(created.id);

  expect(
    await h.operate('update_schedule', { id, description: 'First change' }, 'update-1'),
  ).toMatchObject({ id, description: 'First change' });
  expect(await h.operate('update_schedule', { id, enabled: false }, 'update-2')).toMatchObject({
    id,
    enabled: false,
  });
  await h.jobStore.deleteJob(h.conversationId, h.req.turnStartedAt);
  const replacement = await h.jobManager.createJob(h.conversationId, h.userId, h.conversationId);
  h.req.turnStartedAt = replacement.createdAt;
  expect(
    await h.operate('update_schedule', { id, name: 'A later turn' }, 'update-3'),
  ).toMatchObject({ id, name: 'A later turn' });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    name: 'A later turn',
    description: 'First change',
    enabled: false,
    configRevision: 3,
  });
});

it('freezes an update call revision so retrying it cannot overwrite a later observation', async () => {
  const h = await setup();
  const created = await h.invoke();
  const id = String(created.id);

  expect(
    await h.operate('update_schedule', { id, description: 'Committed once' }, 'frozen-update'),
  ).toMatchObject({ id, description: 'Committed once' });
  expect(
    await h.operate('update_schedule', { id, description: 'Committed once' }, 'frozen-update'),
  ).toMatchObject({ status: 409 });
  expect(await h.operate('get_schedule', { id })).toMatchObject({ id });
  expect(
    await h.operate(
      'update_schedule',
      { id, description: 'Retry must not overwrite' },
      'frozen-update',
    ),
  ).toMatchObject({ status: 409 });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'Committed once',
    configRevision: 1,
  });
  expect(await h.operate('get_schedule', { id })).toMatchObject({ id });
  expect(
    await h.operate('update_schedule', { id, description: 'A new approved call' }, 'new-update'),
  ).toMatchObject({ id, description: 'A new approved call' });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'A new approved call',
    configRevision: 2,
  });
});

it('returns every listed record when one revision cache write fails after another advances', async () => {
  const h = await setup();
  const first = await h.invoke();
  const second = await h.invoke({ ...h.input, name: 'Another follow-up' }, 'create-second');
  const id = String(first.id);
  await methods.updateScheduleById(id, h.userId, { description: 'An edit the model has not seen' });
  const persist = h.revisions.set.bind(h.revisions);
  const set = jest.spyOn(h.revisions, 'set');
  const firstRemembered: Promise<void> = new Promise((resolve) => {
    set.mockImplementation(async (key, revision) => {
      if (revision === 1) {
        const saved = await persist(key, revision);
        resolve();
        return saved;
      }
      await firstRemembered;
      return false;
    });
  });
  try {
    expect(await h.operate('list_schedules', {})).toEqual({
      schedules: expect.arrayContaining([
        expect.objectContaining({ id, description: 'An edit the model has not seen' }),
        expect.objectContaining({ id: second.id }),
      ]),
    });
  } finally {
    set.mockRestore();
  }

  expect(
    await h.operate(
      'update_schedule',
      { id, description: 'Based on the returned edit' },
      'after-list',
    ),
  ).toMatchObject({ id, description: 'Based on the returned edit' });
  expect(await methods.getScheduleById(id, h.userId)).toMatchObject({
    description: 'Based on the returned edit',
    configRevision: 2,
  });
});
