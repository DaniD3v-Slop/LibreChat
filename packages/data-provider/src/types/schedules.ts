import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Schema } from './tools';

/** Cadences the dialog builds from structured pickers (hour, minute, weekday). */
export const scheduleStructuredFrequencies = ['hourly', 'daily', 'weekdays', 'weekly'] as const;
export type ScheduleStructuredFrequency = (typeof scheduleStructuredFrequencies)[number];

export const scheduleFrequencies = [...scheduleStructuredFrequencies, 'cron', 'once'] as const;
export type ScheduleFrequency = (typeof scheduleFrequencies)[number];

/** Bounds a stored expression. Generous for five fields, because each one can hold a
 *  list: an every-minute-of-the-hour cadence spelled out runs past two hundred chars. */
export const SCHEDULE_CRON_MAX_LENGTH = 256;

export const scheduleTargets = ['new', 'continue', 'steer'] as const;
export type ScheduleTarget = (typeof scheduleTargets)[number];

export type ScheduleDisabledReason =
  | 'mcp_reauth_required'
  | 'mcp_configuration_missing'
  | 'mcp_permission_denied'
  | 'too_many_failures'
  | 'agent_deleted'
  | 'invalid_schedule'
  | 'permission_revoked'
  | 'insufficient_balance'
  | 'project_deleted'
  | 'project_required'
  /** A one-time schedule dispatched its only occurrence. */
  | 'completed'
  /** A one-time schedule's instant passed without it firing (engine down, never armed). */
  | 'expired';

export type ScheduleRunStatus =
  | 'started'
  | 'requires_action'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'skipped_overlap'
  | 'skipped_inactive'
  | 'skipped_balance';

export const structuredCadenceSchema = z.object({
  frequency: z.enum(scheduleStructuredFrequencies),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) => Array.from(new Set(days)))
    .optional(),
});
export type TStructuredCadence = z.infer<typeof structuredCadenceSchema>;

/**
 * A raw cron expression carries its own hour and minute, so it cannot share the
 * structured shape: there is no single `hour` for `0 9,17 * * 1-5`. Syntax is
 * validated server-side by croner, the same parser the engine fires from, rather
 * than by a regex that would accept patterns croner then rejects at fire time.
 */
export const cronCadenceSchema = z.object({
  frequency: z.literal('cron'),
  expression: z.string().trim().min(1).max(SCHEDULE_CRON_MAX_LENGTH),
});
export type TCronCadence = z.infer<typeof cronCadenceSchema>;

/** Minute precision, matching the five-field cron cadences. */
export const SCHEDULE_ONCE_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * A single occurrence at a wall-clock time in the schedule's own timezone, so the
 * instant the user named survives a DST change between creation and firing. `at`
 * carries no offset on purpose: the `timezone` field is the one source of truth.
 * Calendar validity (no February 30) and "not in the past" are checked server-side.
 */
export const onceCadenceSchema = z.object({
  frequency: z.literal('once'),
  at: z.string().regex(SCHEDULE_ONCE_AT_PATTERN, 'Expected YYYY-MM-DDTHH:mm'),
});
export type TOnceCadence = z.infer<typeof onceCadenceSchema>;

export const scheduleCadenceSchema = z.discriminatedUnion('frequency', [
  structuredCadenceSchema,
  cronCadenceSchema,
  onceCadenceSchema,
]);
export type TScheduleCadence = z.infer<typeof scheduleCadenceSchema>;

export const isCronCadence = (cadence: TScheduleCadence): cadence is TCronCadence =>
  cadence.frequency === 'cron';

export const isOnceCadence = (cadence: TScheduleCadence): cadence is TOnceCadence =>
  cadence.frequency === 'once';

export const isStructuredCadence = (cadence: TScheduleCadence): cadence is TStructuredCadence =>
  !isCronCadence(cadence) && !isOnceCadence(cadence);

export const createSchedulePayloadSchema = z.object({
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(2000).optional(),
  prompt: z.string().trim().min(1).max(32000),
  agent_id: z.string().trim().min(1),
  cadence: scheduleCadenceSchema,
  timezone: z.string().min(1),
  target: z.enum(scheduleTargets).default('new'),
  /** Existing conversation selected by the trusted host for continue/steer. */
  conversationId: z.string().trim().min(1).optional(),
  file_ids: z
    .array(z.string())
    .max(10)
    .transform((ids) => Array.from(new Set(ids)))
    .optional(),
  /**
   * Chat project each run's conversation is filed under. `null` clears the scope.
   * Ownership is checked server-side at write time and again at every fire, so a
   * deleted project disables the schedule instead of silently filing runs loose.
   */
  chatProjectId: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
  /**
   * Client-generated key making creation idempotent across retries. Creation commits
   * the row and arms it in two writes, so a failure between them leaves the client
   * unable to tell whether anything persisted; retrying blind can produce two recurring
   * schedules. A retry carrying the same key resolves to the original row instead.
   * REQUIRED: an optional key preserves the keyless duplicate path for any client
   * that omits it, which is exactly the failure the key exists to close.
   */
  clientRequestId: z.string().trim().min(1).max(128),
});
export type TCreateSchedule = z.infer<typeof createSchedulePayloadSchema>;

const scheduleToolTimezoneSchema = createSchedulePayloadSchema.shape.timezone
  .optional()
  .describe('Optional IANA timezone override; defaults to the current chat timezone.');

const scheduleToolCadenceSchema = z.discriminatedUnion('frequency', [
  onceCadenceSchema
    .extend({
      at: onceCadenceSchema.shape.at.describe('Local YYYY-MM-DDTHH:mm in the selected timezone.'),
      timezone: scheduleToolTimezoneSchema,
    })
    .strict(),
  cronCadenceSchema.extend({ timezone: scheduleToolTimezoneSchema }).strict(),
  structuredCadenceSchema
    .omit({ hour: true, daysOfWeek: true })
    .extend({ frequency: z.literal('hourly'), timezone: scheduleToolTimezoneSchema })
    .strict(),
  structuredCadenceSchema
    .omit({ daysOfWeek: true })
    .extend({ frequency: z.enum(['daily', 'weekdays']), timezone: scheduleToolTimezoneSchema })
    .strict(),
  structuredCadenceSchema
    .extend({
      frequency: z.literal('weekly'),
      daysOfWeek: structuredCadenceSchema.shape.daysOfWeek.unwrap(),
      timezone: scheduleToolTimezoneSchema,
    })
    .strict(),
]);

/** Model input excludes the principal and destination identifiers bound by the host. */
export const createScheduleToolSchema = z
  .object({
    name: createSchedulePayloadSchema.shape.name,
    description: createSchedulePayloadSchema.shape.description.describe(
      'Optional schedule metadata; not part of the delivered message.',
    ),
    prompt: z
      .object({
        text: createSchedulePayloadSchema.shape.prompt.describe(
          'Instruction delivered to this same agent when the schedule fires. Example: "Tell the user it is time to go for their run."',
        ),
        file_ids: createSchedulePayloadSchema.shape.file_ids,
      })
      .strict(),
    cadence: scheduleToolCadenceSchema,
    mode: z
      .enum(['fire', 'continue', 'steer'])
      .describe('Start a new chat, continue this chat, or steer its active generation.'),
  })
  .strict();
export type TCreateScheduleToolInput = z.infer<typeof createScheduleToolSchema>;

export const listSchedulesToolSchema = z.object({}).strict();
export type TListSchedulesToolInput = z.infer<typeof listSchedulesToolSchema>;

export const getScheduleToolSchema = z.object({ id: z.string().trim().min(1) }).strict();
export type TGetScheduleToolInput = z.infer<typeof getScheduleToolSchema>;

export const deleteScheduleToolSchema = getScheduleToolSchema;
export type TDeleteScheduleToolInput = z.infer<typeof deleteScheduleToolSchema>;

export const updateScheduleToolSchema = createScheduleToolSchema
  .partial()
  .extend({ id: getScheduleToolSchema.shape.id, enabled: z.boolean().optional() })
  .strict()
  .refine(
    (input) => Object.entries(input).some(([key, value]) => key !== 'id' && value !== undefined),
    {
      message: 'At least one schedule field must change',
    },
  );
export type TUpdateScheduleToolInput = z.infer<typeof updateScheduleToolSchema>;

function toToolJsonSchema(schema: z.ZodType<unknown>): Schema {
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Schema;
}

export const createScheduleToolJsonSchema: Schema = toToolJsonSchema(createScheduleToolSchema);
export const listSchedulesToolJsonSchema: Schema = toToolJsonSchema(listSchedulesToolSchema);
export const getScheduleToolJsonSchema: Schema = toToolJsonSchema(getScheduleToolSchema);
export const deleteScheduleToolJsonSchema: Schema = getScheduleToolJsonSchema;

/** The non-empty patch refinement has no JSON-schema representation in Zod. */
export const updateScheduleToolJsonSchema: Schema = {
  ...toToolJsonSchema(updateScheduleToolSchema),
  minProperties: 2,
};

function normalizeScheduleToolCadence(
  cadence: TCreateScheduleToolInput['cadence'],
  defaultTimezone: string,
): Pick<TCreateSchedule, 'cadence' | 'timezone'> {
  const { timezone = defaultTimezone, ...stored } = cadence;
  return {
    cadence: stored.frequency === 'hourly' ? { ...stored, hour: 0 } : stored,
    timezone,
  };
}

/** Translate validated tool input; the shared create handler owns write validation. */
export function normalizeCreateScheduleToolInput(
  input: TCreateScheduleToolInput,
  defaultTimezone: string,
): Pick<
  TCreateSchedule,
  'name' | 'description' | 'prompt' | 'file_ids' | 'cadence' | 'timezone' | 'target'
> {
  return {
    name: input.name,
    ...(input.description !== undefined && { description: input.description }),
    prompt: input.prompt.text,
    file_ids: input.prompt.file_ids,
    target: input.mode === 'fire' ? 'new' : input.mode,
    ...normalizeScheduleToolCadence(input.cadence, defaultTimezone),
  };
}

/** Idempotency is a property of the CREATE attempt, not of the schedule's config. */
export const updateSchedulePayloadSchema = createSchedulePayloadSchema
  .omit({ clientRequestId: true })
  .partial()
  .extend({
    /**
     * The configRevision the client's edit was computed from (captured when the
     * dialog opened). The server fences the update on it, so a concurrent edit
     * from another tab answers 409 instead of being silently overwritten by a
     * payload rebuilt from a stale snapshot (cadence is sent whole, so the
     * server-side fresh-read fence alone cannot detect this).
     */
    expectedConfigRevision: z.number().int().min(0).optional(),
  });
export type TUpdateSchedule = z.infer<typeof updateSchedulePayloadSchema>;

/** Preserve patch omission; supplied prompt and cadence values replace those fields whole. */
export function normalizeUpdateScheduleToolInput(
  input: TUpdateScheduleToolInput,
  defaultTimezone: string,
): Omit<TUpdateSchedule, 'expectedConfigRevision'> {
  const normalized: Omit<TUpdateSchedule, 'expectedConfigRevision'> = {};
  if (input.name !== undefined) normalized.name = input.name;
  if (input.description !== undefined) normalized.description = input.description;
  if (input.enabled !== undefined) normalized.enabled = input.enabled;
  if (input.mode !== undefined) {
    normalized.target = input.mode === 'fire' ? 'new' : input.mode;
  }

  if (input.prompt !== undefined) {
    normalized.prompt = input.prompt.text;
    normalized.file_ids = input.prompt.file_ids ?? [];
  }

  if (input.cadence !== undefined) {
    Object.assign(normalized, normalizeScheduleToolCadence(input.cadence, defaultTimezone));
  }

  return normalized;
}

export type TScheduleLastRun = {
  conversationId?: string;
  status: ScheduleRunStatus;
  error?: string;
  mcp?: ScheduleMCPOutcome[];
  firedAt: string;
};

export type TSchedule = {
  id: string;
  user: string;
  name: string;
  description?: string;
  prompt: string;
  agent_id: string;
  cadence: TScheduleCadence;
  timezone: string;
  target: ScheduleTarget;
  conversationId?: string;
  originConversationId?: string;
  file_ids?: string[];
  chatProjectId?: string | null;
  enabled: boolean;
  disabledReason?: ScheduleDisabledReason;
  nextRunAt?: string;
  lastRun?: TScheduleLastRun;
  /**
   * The occurrences generating right now. Read from their own run rows, not from
   * `lastRun`, which is projected only when a run settles, pauses or skips and is
   * deliberately withheld from a run whose schedule was edited mid-flight. This is
   * the signal a client has that a chat is on its way, and the id to fetch it by.
   * A run parked on an approval is not here: its chat was listed long ago, and the
   * rows can accumulate for as long as approvals wait.
   */
  inFlight?: Array<{ conversationId: string }>;
  runCount: number;
  failureCount: number;
  configRevision?: number;
  createdAt: string;
  updatedAt: string;
};

export type TScheduleRun = {
  mcp?: ScheduleMCPOutcome[];
  scheduleId: string;
  scheduledFor: string;
  firedAt?: string;
  conversationId?: string;
  status: ScheduleRunStatus;
  error?: string;
  droppedFileIds?: string[];
  durationMs?: number;
};

/** Server-resolved policy the dialog must mirror. Sourced from the same
 *  per-principal `interface.schedules` resolution the write handlers and the fire
 *  path enforce, so the form can never offer a choice the server would refuse. */
export type TScheduleLimits = {
  maxPerUser: number;
  /** Served with the list so the dialog can refuse a cadence the floor would reject
   *  rather than surfacing it as a 400 after submit. */
  minIntervalMinutes: number;
  /** Every schedule must be filed under a chat project. */
  requireProject: boolean;
  /** Operator-pinned destination project; when set it is the ONLY destination and
   *  the client must not offer a picker. */
  projectId?: string;
};

export type TSchedulesResponse = {
  schedules: TSchedule[];
  limits: TScheduleLimits;
};

export type TScheduleRunNowResponse = {
  scheduleId: string;
  conversationId: string;
  status: 'started';
};

/** Only structured schedule preflight failures may request immediate suspension. */
export function getScheduleMCPDisabledReason(
  outcomes?: ScheduleMCPOutcome[],
): 'mcp_reauth_required' | 'mcp_configuration_missing' | 'mcp_permission_denied' | undefined {
  const statuses = new Set(outcomes?.map((outcome) => outcome.status));
  if (statuses.has('mcp_permission_denied')) return 'mcp_permission_denied';
  if (statuses.has('mcp_configuration_missing')) return 'mcp_configuration_missing';
  if (statuses.has('mcp_reauth_required')) return 'mcp_reauth_required';
  return undefined;
}

export const scheduleMCPOutcomeSchema = z.object({
  server: z.string(),
  /** Agent whose selected tool requires this server. Used to open the correct
   * recovery chat when the requirement belongs to a handoff or subagent. */
  agentId: z.string().optional(),
  /** Additional diagnosis; older clients ignore unknown keys and retain the known status. */
  detail: z.enum(['unattended_auth_required']).optional(),
  status: z.enum([
    'ready',
    'mcp_reauth_required',
    'mcp_configuration_missing',
    'mcp_permission_denied',
    'mcp_unavailable',
  ]),
});
export type ScheduleMCPOutcome = z.infer<typeof scheduleMCPOutcomeSchema>;
export type ScheduleMCPStatus = ScheduleMCPOutcome['status'];

export function readScheduleMCPOutcomes(error?: string): ScheduleMCPOutcome[] {
  if (
    !error ||
    !/^mcp_(reauth_required|configuration_missing|permission_denied|unavailable): \[/.test(error)
  )
    return [];
  try {
    const result = scheduleMCPOutcomeSchema
      .array()
      .safeParse(JSON.parse(error.slice(error.indexOf(': ') + 2)));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
