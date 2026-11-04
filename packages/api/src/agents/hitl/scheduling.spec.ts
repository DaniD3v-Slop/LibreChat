import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Run, Providers, MemorySaver, FakeChatModel } from '@librechat/agents';
import { AgentCapabilities, PermissionTypes, Permissions } from 'librechat-data-provider';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { RunStreamConfig } from '@librechat/agents';
import type { IRole } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { resolveToolApprovalPolicy, exemptScheduleReadsFromApproval } from './policy';
import { createScheduleChatApprovalHook } from './scheduling';
import { buildHITLRunWiring } from './runtime';

/** Exercise the real SDK approval boundary; only the provider is scripted. */
async function buildRun({
  saver,
  execute,
  toolCalls = true,
  interactive = true,
  endpoint,
  toolName = 'create_schedule',
}: {
  saver: MemorySaver;
  execute: (input: { text: string }) => Promise<string>;
  toolCalls?: boolean;
  interactive?: boolean;
  endpoint?: TToolApprovalPolicy;
  toolName?:
    | 'create_schedule'
    | 'list_schedules'
    | 'get_schedule'
    | 'update_schedule'
    | 'delete_schedule';
}) {
  const nativeTool = tool(execute, {
    name: toolName,
    description: 'Create a future chat.',
    schema: z.object({ text: z.string() }),
  });
  const wiring = buildHITLRunWiring(
    exemptScheduleReadsFromApproval(resolveToolApprovalPolicy({ endpoint, scheduleChat: true })),
  );
  const run = await Run.create({
    runId: 'schedule-approval-run',
    graphConfig: {
      type: 'standard',
      llmConfig: { provider: Providers.OPENAI, model: 'local-test-model', streaming: true },
      instructions: 'Use the provided tool when asked.',
      tools: [nativeTool],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    hooks: wiring!.hooks,
    ...(interactive && { humanInTheLoop: wiring!.humanInTheLoop }),
  });
  run.Graph!.overrideModel = new FakeChatModel({
    responses: ['Preparing a schedule.', 'Scheduled.'],
    ...(toolCalls && {
      toolCalls: [
        {
          name: toolName,
          args: { text: 'Follow up' },
          id: 'schedule-call',
          type: 'tool_call',
        },
      ],
    }),
  });
  return run;
}

function config(threadId: string): RunStreamConfig {
  return {
    runName: 'ScheduleApproval',
    configurable: { thread_id: threadId },
    version: 'v2',
  };
}

describe('schedule_chat real native approval', () => {
  it.each(['approve', 'reject'] as const)(
    'applies a restored %s decision to the original proposal',
    async (decision) => {
      const saver = new MemorySaver();
      const execute = jest.fn(async ({ text }: { text: string }) => text);
      const endpoint: TToolApprovalPolicy | undefined =
        decision === 'approve' ? { enabled: true, mode: 'bypass' } : undefined;
      const run = await buildRun({ saver, execute, endpoint });
      const streamConfig = config(`schedule-${decision}`);
      await run.processStream(
        { messages: [new HumanMessage('Schedule a follow-up')] },
        streamConfig,
      );
      expect(run.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(execute).not.toHaveBeenCalled();

      const resumed = await buildRun({ saver, execute, endpoint, toolCalls: false });
      await resumed.resume({ 'schedule-call': { type: decision } }, streamConfig);
      expect(resumed.getInterrupt()).toBeUndefined();
      expect(execute.mock.calls.map(([args]) => args)).toEqual(
        decision === 'approve' ? [{ text: 'Follow up' }] : [],
      );
    },
  );

  it.each(['update_schedule', 'delete_schedule'] as const)(
    'requires native consent before %s even in bypass mode',
    async (toolName) => {
      const execute = jest.fn(async () => 'changed');
      const run = await buildRun({
        saver: new MemorySaver(),
        execute,
        toolName,
        endpoint: { enabled: true, mode: 'bypass' },
      });
      await run.processStream(
        { messages: [new HumanMessage('Modify the schedule')] },
        config(`write-${toolName}`),
      );
      expect(run.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['default', 'dontAsk', 'bypass'] as const)(
    'honors explicit allow, overlapping ask and deny under %s',
    async (mode) => {
      const cases = [
        { allow: ['create_schedule'] },
        { allow: ['*'] },
        { allow: ['create_schedule'], ask: ['create_schedule'] },
        { deny: ['*_schedule'] },
      ];
      for (const [index, rules] of cases.entries()) {
        const execute = jest.fn(async () => 'created');
        const run = await buildRun({
          saver: new MemorySaver(),
          execute,
          endpoint: { enabled: true, mode, ...rules },
        });
        await run.processStream(
          { messages: [new HumanMessage('Schedule a follow-up')] },
          config(`${mode}-${index}`),
        );
        expect(execute).toHaveBeenCalledTimes(rules.ask || rules.deny ? 0 : 1);
        expect(run.getInterrupt()?.payload.type).toBe(rules.ask ? 'tool_approval' : undefined);
      }
    },
  );

  it.each(['list_schedules', 'get_schedule'] as const)(
    'dispatches read-only %s without a native interrupt under default approval',
    async (toolName) => {
      const execute = jest.fn(async ({ text }: { text: string }) => text);
      const run = await buildRun({
        saver: new MemorySaver(),
        execute,
        interactive: false,
        toolName,
        endpoint: { enabled: true, mode: 'default' },
      });
      await run.processStream(
        { messages: [new HumanMessage('Read schedules')] },
        config(`read-${toolName}`),
      );
      expect(run.getInterrupt()).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses scheduling when the caller cannot pause for native approval', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const execute = jest.fn(async ({ text }: { text: string }) => text);
    const run = await buildRun({ saver: new MemorySaver(), execute, interactive: false });
    await run.processStream(
      { messages: [new HumanMessage('Schedule a follow-up')] },
      config('schedule-headless'),
    );
    expect(run.getInterrupt()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('humanInTheLoop is not enabled'));
  });
});

describe('schedule creation live generation guard', () => {
  const makeRequest = () =>
    Object.assign({} as ServerRequest, {
      body: { conversationId: 'conversation' },
      user: { id: 'owner', role: 'USER' },
      turnStartedAt: 42,
      config: {
        interfaceConfig: { schedules: true },
        endpoints: { agents: { capabilities: [AgentCapabilities.schedule_chat] } },
      },
    });
  const getRoleByName = async (): Promise<IRole> =>
    ({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
      },
    }) as IRole;
  const req = makeRequest();
  const input = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'run',
    toolName: 'create_schedule',
    toolInput: {},
    toolUseId: 'call',
  };

  it('rechecks the active generation before every request for approval', async () => {
    const metadata = { userId: 'owner', scheduleSteered: false };
    const getJob = jest.fn(async () => ({ createdAt: 42, metadata }));
    const hook = createScheduleChatApprovalHook(req, getJob, getRoleByName);
    expect(await hook(input, new AbortController().signal)).toEqual({});
    metadata.scheduleSteered = true;
    expect(await hook(input, new AbortController().signal)).toMatchObject({ decision: 'deny' });
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('denies scheduling when its generation identity cannot be checked', async () => {
    const hook = createScheduleChatApprovalHook(req, async () => null, getRoleByName);
    expect(await hook(input, new AbortController().signal)).toMatchObject({ decision: 'deny' });
  });

  it.each(['capability', 'schedules', 'approval', 'role'])(
    'denies before asking for consent when the %s gate is disabled',
    async (gate) => {
      const request = makeRequest();
      if (gate === 'capability') request.config!.endpoints!.agents!.capabilities = [];
      if (gate === 'schedules') request.config!.interfaceConfig!.schedules = false;
      if (gate === 'approval') request.config!.endpoints!.agents!.toolApproval = { enabled: false };
      const getJob = jest.fn(async () => ({ createdAt: 42, metadata: { userId: 'owner' } }));
      const hook = createScheduleChatApprovalHook(
        request,
        getJob,
        gate === 'role' ? async () => null : getRoleByName,
      );
      expect(await hook(input, new AbortController().signal)).toMatchObject({ decision: 'deny' });
      expect(getJob).not.toHaveBeenCalled();
    },
  );

  it.each(['read_file', 'list_schedules', 'get_schedule'])(
    'does not inspect live jobs for %s',
    async (toolName) => {
      const getJob = jest.fn(async () => null);
      const hook = createScheduleChatApprovalHook(req, getJob, getRoleByName);
      expect(await hook({ ...input, toolName }, new AbortController().signal)).toEqual({});
      expect(getJob).not.toHaveBeenCalled();
    },
  );
});
