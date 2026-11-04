import { createHash } from 'node:crypto';
import { Constants } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  AgentCapabilities,
  stripAgentIdSuffix,
  createScheduleToolSchema,
  listSchedulesToolSchema,
  getScheduleToolSchema,
  updateScheduleToolSchema,
  deleteScheduleToolSchema,
  createScheduleToolJsonSchema,
  listSchedulesToolJsonSchema,
  getScheduleToolJsonSchema,
  updateScheduleToolJsonSchema,
  deleteScheduleToolJsonSchema,
  normalizeCreateScheduleToolInput,
  normalizeUpdateScheduleToolInput,
} from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { Response } from 'express';
import type {
  ScheduleToolRequest,
  ScheduleToolContext,
  ScheduleCrudHandlers,
  ScheduleConversation,
} from '~/schedules/request';
import type { ToolRegistryDefinition, ExtendedJsonSchema } from '~/tools/registry/schema';
import type { CheckAccessParams } from '~/middleware/access';
import type { WireSchedule } from '~/schedules/wire';
import type { ServerRequest } from '~/types/http';
import { hasScheduledGenerationContext, isScheduleFireRequest } from '~/schedules/trigger';
import { isValidTimezone } from '~/schedules/cadence';
import { getSafeErrorMetadata } from '~/utils/errors';
import { checkAccess } from '~/middleware/access';

/** Saved agent.tools capability marker; expands into the five callable tools below. */
export const SCHEDULE_CHAT_TOOL_NAME = 'schedule_chat';
export const SCHEDULE_TOOL_NAMES = [
  'create_schedule',
  'list_schedules',
  'get_schedule',
  'update_schedule',
  'delete_schedule',
] as const;
export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number];
export const SCHEDULE_WRITE_TOOL_NAMES = [
  'create_schedule',
  'update_schedule',
  'delete_schedule',
] as const;
const toolNames: ReadonlySet<string> = new Set(SCHEDULE_TOOL_NAMES);
const writeNames: ReadonlySet<string> = new Set(SCHEDULE_WRITE_TOOL_NAMES);

export function isScheduleToolName(name: string): name is ScheduleToolName {
  return toolNames.has(name);
}

export function isScheduleWriteTool(name: string): boolean {
  return writeNames.has(name);
}

export function expandScheduleToolNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names.flatMap((name) => (name === SCHEDULE_CHAT_TOOL_NAME ? SCHEDULE_TOOL_NAMES : [name])),
    ),
  ];
}

export const ScheduleToolGroupDefinition: ToolRegistryDefinition = {
  name: SCHEDULE_CHAT_TOOL_NAME,
  description:
    'Manage schedules for the current user, agent and project, or this chat when outside a project.',
  schema: { type: 'object', properties: {} },
  toolType: 'builtin',
};

export const ScheduleToolDefinitions: Record<ScheduleToolName, ToolRegistryDefinition> = {
  create_schedule: {
    name: 'create_schedule',
    description:
      'Create a schedule for this user and agent, inheriting this chat’s project. Uses the configured native tool approval policy; asks by default. fire starts a new chat, continue adds a turn to this chat, steer directs its active generation (skipped if idle). prompt.text is a future instruction delivered back to this agent, not reminder notification text. For a reminder, write "Tell the user it is time to go for their run." Attach registered files inside prompt.file_ids. All cadence times are local wall-clock times in the user’s timezone, supplied automatically by LibreChat. Do not ask the user for a timezone; cadence.timezone is an optional override for another location. Returns only the created id. Scheduled generations cannot write schedules.',
    schema: createScheduleToolJsonSchema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  list_schedules: {
    name: 'list_schedules',
    description:
      'List full schedules for this user and agent in this chat’s project; outside a project, only schedules originating in this chat are included. Read-only; available during scheduled runs.',
    schema: listSchedulesToolJsonSchema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  get_schedule: {
    name: 'get_schedule',
    description:
      'Read a schedule by id within the current user, agent and project (or this chat outside a project). Includes prompt, cadence and state, and remembers its revision for later updates in this chat.',
    schema: getScheduleToolJsonSchema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  update_schedule: {
    name: 'update_schedule',
    description:
      'Update a schedule in the current scope under the native approval policy. Read it first in this chat; the server remembers the version and refuses concurrent edits. Supply id and the fields to change directly. Only supplied fields are written. A replaced prompt replaces its attachments too. An explicit continue or steer mode targets this chat. Scheduled generations cannot write schedules. A revision conflict requires reading the current record again.',
    schema: updateScheduleToolJsonSchema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
  delete_schedule: {
    name: 'delete_schedule',
    description:
      'Delete a schedule within the current scope under the native approval policy. A deleting status means active runs are still draining; a 503 error means stopping a run could not be confirmed and deletion should be retried. A subsequent 404 means the schedule no longer exists in this scope. Scheduled generations cannot write schedules.',
    schema: deleteScheduleToolJsonSchema as ExtendedJsonSchema,
    toolType: 'builtin',
  },
};

const schemas = {
  create_schedule: createScheduleToolSchema,
  list_schedules: listSchedulesToolSchema,
  get_schedule: getScheduleToolSchema,
  update_schedule: updateScheduleToolSchema,
  delete_schedule: deleteScheduleToolSchema,
};

interface ScheduleToolDeps {
  req: ServerRequest;
  agentId?: string;
  getRoleByName: CheckAccessParams['getRoleByName'];
  getConversation: (userId: string, conversationId: string) => Promise<ScheduleConversation | null>;
  getGenerationJob?: Parameters<typeof hasScheduledGenerationContext>[1];
  handlers: ScheduleCrudHandlers;
  revisions: {
    get(key: string): Promise<number | undefined>;
    set(key: string, revision: number): Promise<boolean>;
    delete(key: string): Promise<boolean>;
  };
}

export interface ScheduleToolResponse {
  status: number;
  body: unknown;
}

/** Shared opt-in and role gate, also used before native approval is requested. */
export async function isScheduleToolAllowed(
  { req, getRoleByName }: Pick<ScheduleToolDeps, 'req' | 'getRoleByName'>,
  write: boolean,
): Promise<boolean> {
  const endpoint = req.config?.endpoints?.[EModelEndpoint.agents];
  const schedules = req.config?.interfaceConfig?.schedules;
  if (
    !req.user ||
    !endpoint?.capabilities?.includes(AgentCapabilities.schedule_chat) ||
    (write && endpoint.toolApproval?.enabled === false) ||
    schedules == null ||
    schedules === false ||
    (typeof schedules === 'object' && schedules.use === false)
  )
    return false;
  return checkAccess({
    user: req.user,
    permissionType: PermissionTypes.SCHEDULES,
    permissions: write ? [Permissions.USE, Permissions.CREATE] : [Permissions.USE],
    getRoleByName,
  });
}

async function callHandler(
  deps: ScheduleToolDeps,
  handler: keyof ScheduleToolDeps['handlers'],
  body: object,
  context: ScheduleToolContext,
  conversation: NonNullable<Awaited<ReturnType<ScheduleToolDeps['getConversation']>>>,
  id?: string,
): Promise<ScheduleToolResponse> {
  const captured: ScheduleToolResponse = { status: 200, body: undefined };
  const request = Object.assign({} as ScheduleToolRequest, {
    user: deps.req.user,
    config: deps.req.config,
    body,
    params: id ? { id } : {},
    scheduleToolContext: context,
    resolvedConversation: {
      ...conversation,
      conversationId: context.conversationId,
      user: deps.req.user!.id,
    },
  });
  const response = Object.assign({} as Response, {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(value: unknown) {
      captured.body = value;
      return this;
    },
    set() {
      return this;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  });
  await deps.handlers[handler](request, response);
  return captured;
}

/** Model-facing allowlist: ownership, revision fences and run internals stay on the host. */
function toToolSchedule(schedule: WireSchedule, defaultTimezone: string) {
  const cadence =
    schedule.cadence.frequency === 'hourly'
      ? { frequency: schedule.cadence.frequency, minute: schedule.cadence.minute }
      : schedule.cadence;
  return {
    id: schedule.id,
    name: schedule.name,
    description: schedule.description,
    prompt: { text: schedule.prompt, file_ids: schedule.file_ids },
    cadence: {
      ...cadence,
      ...(schedule.timezone !== defaultTimezone && { timezone: schedule.timezone }),
    },
    mode: schedule.target === 'new' ? 'fire' : schedule.target,
    enabled: schedule.enabled,
    disabledReason: schedule.disabledReason,
    nextRunAt: schedule.nextRunAt,
    lastRun: schedule.lastRun && {
      status: schedule.lastRun.status,
      firedAt: schedule.lastRun.firedAt,
    },
    runCount: schedule.runCount,
    failureCount: schedule.failureCount,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

export function createScheduleTool(
  name: ScheduleToolName,
  deps: ScheduleToolDeps,
): DynamicStructuredTool {
  const timezone = deps.req.body.timezone ?? '';
  return tool(
    async (input, config?: { toolCall?: { id?: string }; metadata?: Record<string, unknown> }) => {
      try {
        const write = isScheduleWriteTool(name);
        const { req, agentId, getGenerationJob } = deps;
        if (
          config?.metadata?.[Constants.PROGRAMMATIC_TOOL_CALLING] === true ||
          config?.metadata?.[Constants.BASH_PROGRAMMATIC_TOOL_CALLING] === true ||
          !(await isScheduleToolAllowed(deps, write))
        )
          return JSON.stringify({ code: 'schedule_chat_forbidden' });
        if (write && isScheduleFireRequest(req))
          return JSON.stringify({ code: 'schedule_chat_recursion' });
        const conversationId = req.body.conversationId;
        const callId = config?.toolCall?.id;
        if (!req.user || !agentId || !conversationId || (write && (!callId || !getGenerationJob)))
          return JSON.stringify({ code: 'schedule_chat_missing_context' });
        const conversation = await deps.getConversation(req.user.id, conversationId);
        const persistedAgentId = stripAgentIdSuffix(agentId);
        if (
          !conversation ||
          conversation.agent_id !== persistedAgentId ||
          (conversation.tenantId ?? undefined) !== (req.user.tenantId ?? undefined) ||
          (conversation.user != null && String(conversation.user) !== req.user.id)
        )
          return JSON.stringify({ code: 'schedule_chat_missing_context' });
        const context: ScheduleToolContext = {
          agentId: persistedAgentId,
          conversationId,
          projectId: conversation.chatProjectId ?? null,
        };
        const sessionKey = createHash('sha256')
          .update(
            JSON.stringify([
              req.user.id,
              req.user.tenantId,
              persistedAgentId,
              conversationId,
              context.projectId,
            ]),
          )
          .digest('hex');
        const revisionKey = (id: string) => `${sessionKey}:${id}`;
        const setRevision = async (key: string, revision: number) => {
          if ((await deps.revisions.set(key, revision)) === false)
            throw new Error('Schedule revision cache write failed');
        };
        const remember = (schedule: WireSchedule) =>
          setRevision(revisionKey(schedule.id), schedule.configRevision ?? 0);
        const call = async (
          handler: keyof ScheduleCrudHandlers,
          body: object = {},
          id?: string,
        ) => {
          // Cache and conversation reads can yield to an arriving scheduled steer.
          if (
            write &&
            getGenerationJob &&
            (await hasScheduledGenerationContext(req, getGenerationJob))
          )
            return JSON.stringify({ code: 'schedule_chat_recursion' });
          const result = await callHandler(deps, handler, body, context, conversation, id);
          if (result.status >= 400) {
            if (handler === 'updateSchedule' && result.status === 409 && id)
              await deps.revisions.delete(revisionKey(id));
            return JSON.stringify(result);
          }
          if (handler === 'deleteSchedule') {
            await deps.revisions.delete(revisionKey(id!));
            return JSON.stringify({ id, status: result.status === 202 ? 'deleting' : 'deleted' });
          }
          // These are trusted in-process handler responses, not model-supplied records.
          if (handler === 'listSchedules') {
            const { schedules } = result.body as { schedules: WireSchedule[] };
            const remembered = await Promise.allSettled(schedules.map(remember));
            // Return every read record even if caching fails; a partially cached list
            // must never advance revisions while hiding those records from the model.
            for (const result of remembered) {
              if (result.status === 'rejected')
                logger.warn(
                  '[schedule_chat] Could not remember list revision',
                  getSafeErrorMetadata(result.reason),
                );
            }
            return JSON.stringify({
              schedules: schedules.map((schedule) => toToolSchedule(schedule, timezone)),
            });
          }
          const schedule = result.body as WireSchedule;
          // An ID-only create replay does not reveal edits made since creation.
          if (handler !== 'createSchedule' || (schedule.configRevision ?? 0) === 0)
            await remember(schedule);
          return JSON.stringify(
            handler === 'createSchedule' ? { id: schedule.id } : toToolSchedule(schedule, timezone),
          );
        };
        if (name === 'create_schedule') {
          const create = createScheduleToolSchema.parse(input);
          const payload = normalizeCreateScheduleToolInput(create, timezone);
          if (!isValidTimezone(payload.timezone))
            return JSON.stringify({ code: 'schedule_chat_missing_timezone' });
          const clientRequestId = createHash('sha256')
            .update(
              JSON.stringify([
                req.user.id,
                req.user.tenantId,
                conversationId,
                req.turnStartedAt,
                persistedAgentId,
                callId,
              ]),
            )
            .digest('hex');
          return await call('createSchedule', {
            ...payload,
            agent_id: persistedAgentId,
            clientRequestId,
            enabled: true,
            ...(create.mode !== 'fire' && { conversationId }),
          });
        }
        if (name === 'list_schedules') return await call('listSchedules');
        if (name === 'get_schedule') {
          const { id } = getScheduleToolSchema.parse(input);
          return await call('getSchedule', {}, id);
        }
        if (name === 'update_schedule') {
          const update = updateScheduleToolSchema.parse(input);
          const payload = normalizeUpdateScheduleToolInput(update, timezone);
          if (payload.timezone !== undefined && !isValidTimezone(payload.timezone))
            return JSON.stringify({ code: 'schedule_chat_missing_timezone' });
          // Freeze the read revision per tool call: a retry cannot adopt a later read
          // and silently apply the same edit a second time.
          const key = revisionKey(update.id);
          const attemptKey = `${key}:attempt:${req.turnStartedAt}:${callId}`;
          let expectedConfigRevision = await deps.revisions.get(attemptKey);
          if (expectedConfigRevision == null) {
            expectedConfigRevision = await deps.revisions.get(key);
            if (expectedConfigRevision == null)
              return JSON.stringify({ code: 'schedule_chat_read_required', id: update.id });
            await setRevision(attemptKey, expectedConfigRevision);
          }
          return await call(
            'updateSchedule',
            {
              ...payload,
              expectedConfigRevision,
              ...(update.mode != null && update.mode !== 'fire' && { conversationId }),
            },
            update.id,
          );
        }
        const { id } = deleteScheduleToolSchema.parse(input);
        return await call('deleteSchedule', {}, id);
      } catch (error) {
        logger.error('[schedule_chat] Operation failed', getSafeErrorMetadata(error));
        return JSON.stringify({ code: 'schedule_chat_failed' });
      }
    },
    { name, description: ScheduleToolDefinitions[name].description, schema: schemas[name] },
  );
}
