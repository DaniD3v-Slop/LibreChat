import { z } from 'zod';
import { Validator } from '@cfworker/json-schema';
import {
  createSchedulePayloadSchema,
  updateSchedulePayloadSchema,
  listSchedulesToolSchema,
  getScheduleToolSchema,
  updateScheduleToolSchema,
  deleteScheduleToolSchema,
  listSchedulesToolJsonSchema,
  getScheduleToolJsonSchema,
  updateScheduleToolJsonSchema,
  deleteScheduleToolJsonSchema,
  normalizeUpdateScheduleToolInput,
  createScheduleToolSchema,
  createScheduleToolJsonSchema,
  normalizeCreateScheduleToolInput,
  getScheduleMCPDisabledReason,
  readScheduleMCPOutcomes,
  scheduleMCPOutcomeSchema,
} from './schedules';

it('preserves the previous wire status while providing an optional unattended-auth diagnosis', () => {
  const outcome = {
    server: 'Graph',
    status: 'mcp_configuration_missing' as const,
    detail: 'unattended_auth_required' as const,
  };
  // Represents the schema used by an open tab from before this feature.
  const previousClientSchema = z.object({
    server: z.string(),
    agentId: z.string().optional(),
    status: z.enum([
      'ready',
      'mcp_reauth_required',
      'mcp_configuration_missing',
      'mcp_permission_denied',
      'mcp_unavailable',
    ]),
  });
  expect(previousClientSchema.array().parse([outcome])).toEqual([
    { server: 'Graph', status: 'mcp_configuration_missing' },
  ]);
  expect(scheduleMCPOutcomeSchema.parse(outcome)).toEqual(outcome);
  expect(getScheduleMCPDisabledReason([outcome])).toBe('mcp_configuration_missing');
  expect(
    readScheduleMCPOutcomes(`mcp_configuration_missing: ${JSON.stringify([outcome])}`),
  ).toEqual([outcome]);
});

describe('create_schedule input', () => {
  const input = {
    name: ' Review ',
    prompt: { text: ' Summarize the report ', file_ids: ['report-1', 'report-1'] },
    cadence: { frequency: 'once', at: '2099-11-05T09:00' },
    mode: 'fire',
  };

  it('preserves local one-shot time and uses the host timezone with attached IDs', () => {
    const parsed = createScheduleToolSchema.parse(input);
    expect(normalizeCreateScheduleToolInput(parsed, 'Europe/Vienna')).toEqual({
      name: 'Review',
      prompt: 'Summarize the report',
      file_ids: ['report-1'],
      cadence: { frequency: 'once', at: '2099-11-05T09:00' },
      timezone: 'Europe/Vienna',
      target: 'new',
    });
    const overridden = createScheduleToolSchema.parse({
      ...input,
      cadence: { ...input.cadence, timezone: 'America/New_York' },
    });
    expect(normalizeCreateScheduleToolInput(overridden, 'Europe/Vienna')).toMatchObject({
      cadence: { frequency: 'once', at: '2099-11-05T09:00' },
      timezone: 'America/New_York',
    });
  });

  it.each(['2099-11-05T09:00:00Z', '2099-11-05T09:00:00+01:00', '2099-11-05T09:00:00'])(
    'rejects timestamp offsets and seconds in local one-shot input: %s',
    (at) => {
      expect(
        createScheduleToolSchema.safeParse({ ...input, cadence: { frequency: 'once', at } })
          .success,
      ).toBe(false);
    },
  );

  it('defaults cron to the host timezone and accepts only a nested override', () => {
    const cadence = { frequency: 'cron', expression: '0 9 * * 1' };
    expect(
      normalizeCreateScheduleToolInput(
        createScheduleToolSchema.parse({ ...input, cadence }),
        'Europe/Vienna',
      ),
    ).toMatchObject({ cadence, timezone: 'Europe/Vienna' });
    expect(
      normalizeCreateScheduleToolInput(
        createScheduleToolSchema.parse({ ...input, cadence: { ...cadence, timezone: 'UTC' } }),
        'Europe/Vienna',
      ),
    ).toMatchObject({ cadence, timezone: 'UTC' });
    expect(createScheduleToolSchema.safeParse({ ...input, timezone: 'UTC' }).success).toBe(false);
  });

  it.each([
    { frequency: 'hourly', minute: 15 },
    { frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1, 3] },
  ])('normalizes structured recurring cadence $frequency', (cadence) => {
    const normalized = normalizeCreateScheduleToolInput(
      createScheduleToolSchema.parse({ ...input, cadence }),
      'Europe/Vienna',
    );
    expect(normalized.timezone).toBe('Europe/Vienna');
    expect(normalized.cadence).toEqual(
      cadence.frequency === 'hourly' ? { ...cadence, hour: 0 } : cadence,
    );
  });

  it.each([
    'agent_id',
    'conversationId',
    'originConversationId',
    'chatProjectId',
    'user',
    'clientRequestId',
    'currentProject',
    'timezone',
  ])('rejects model-supplied host field %s', (field) => {
    expect(createScheduleToolSchema.safeParse({ ...input, [field]: 'spoofed' }).success).toBe(
      false,
    );
  });

  it.each(['continue', 'steer'])(
    'normalizes mode %s without model-selected IDs or project',
    (mode) => {
      expect(
        normalizeCreateScheduleToolInput(
          createScheduleToolSchema.parse({ ...input, mode }),
          'Europe/Vienna',
        ),
      ).toMatchObject({ target: mode });
    },
  );

  it('normalizes optional description metadata', () => {
    expect(
      normalizeCreateScheduleToolInput(
        createScheduleToolSchema.parse({ ...input, description: ' Weekly report review ' }),
        'Europe/Vienna',
      ),
    ).toMatchObject({ description: 'Weekly report review' });
  });

  it('retains shared prompt and attachment limits', () => {
    expect(createScheduleToolSchema.safeParse({ ...input, prompt: { text: ' ' } }).success).toBe(
      false,
    );
    expect(
      createScheduleToolSchema.safeParse({
        ...input,
        prompt: { text: 'x', file_ids: Array.from({ length: 11 }, (_, i) => `file-${i}`) },
      }).success,
    ).toBe(false);
  });

  it('explains the future instruction to the model in both schema representations', () => {
    const description = createScheduleToolSchema.shape.prompt.shape.text.description;
    expect(description).toEqual(expect.any(String));
    expect(createScheduleToolJsonSchema).toHaveProperty(
      'properties.prompt.properties.text.description',
      description,
    );
    expect(updateScheduleToolJsonSchema).toHaveProperty(
      'properties.prompt.properties.text.description',
      description,
    );
  });

  it('exposes a JSON schema matching representative native tool inputs', () => {
    const validator = new Validator(createScheduleToolJsonSchema);
    const valid = [
      input,
      { ...input, prompt: { text: 'Follow up' } },
      { ...input, cadence: { frequency: 'hourly', minute: 15 } },
      { ...input, cadence: { frequency: 'daily', hour: 9, minute: 0 } },
      { ...input, cadence: { frequency: 'weekdays', hour: 9, minute: 0 } },
      { ...input, cadence: { frequency: 'weekly', hour: 9, minute: 0, daysOfWeek: [1, 1] } },
      { ...input, cadence: { frequency: 'cron', expression: '0 9 * * 1' }, mode: 'continue' },
      { ...input, mode: 'steer' },
    ];
    for (const candidate of valid) {
      for (const cadence of [candidate.cadence, { ...candidate.cadence, timezone: 'Asia/Tokyo' }]) {
        const value = { ...candidate, cadence };
        expect(validator.validate(value).valid).toBe(true);
        expect(createScheduleToolSchema.safeParse(value).success).toBe(true);
      }
    }
    for (const candidate of [
      { ...input, agent_id: 'spoofed' },
      { ...input, cadence: { frequency: 'daily', hour: 99, minute: 0 } },
      { ...input, cadence: { frequency: 'cron', expression: '0 9 * * 1', timezone: '' } },
      { ...input, prompt: { text: 'x', file_ids: [{ file_id: 'report-1' }] } },
      { ...input, prompt: { text: 'x', user: 'spoofed' } },
    ]) {
      expect(validator.validate(candidate).valid).toBe(false);
      expect(createScheduleToolSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

it('preserves existing new-chat payloads and accepts host-bound continuation targets', () => {
  const input = {
    name: 'Reminder',
    prompt: 'Follow up',
    agent_id: 'agent-1',
    cadence: { frequency: 'daily', hour: 9, minute: 0 },
    timezone: 'UTC',
    clientRequestId: 'call-1',
  };
  expect(createSchedulePayloadSchema.parse(input).target).toBe('new');
  expect(
    createSchedulePayloadSchema.parse({
      ...input,
      target: 'continue',
      conversationId: 'conversation-1',
    }),
  ).toMatchObject({ target: 'continue', conversationId: 'conversation-1' });
  expect(
    createSchedulePayloadSchema.parse({
      ...input,
      target: 'steer',
      conversationId: 'conversation-1',
    }),
  ).toMatchObject({ target: 'steer', conversationId: 'conversation-1' });
});

describe('schedule CRUD tool contracts', () => {
  it('lists the server-bound scope without accepting filters', () => {
    expect(listSchedulesToolSchema.safeParse({ agent_id: 'other' }).success).toBe(false);
    expect(listSchedulesToolSchema.safeParse({ chatProjectId: 'other' }).success).toBe(false);
  });

  it('accepts only the opaque schedule id for direct lookup', () => {
    expect(getScheduleToolSchema.parse({ id: ' sched-1 ' })).toEqual({
      id: 'sched-1',
    });
    expect(getScheduleToolSchema.safeParse({ id: ' ' }).success).toBe(false);
    expect(getScheduleToolSchema.safeParse({ id: 'sched-1', user: 'other' }).success).toBe(false);
  });

  it('normalizes only supplied update fields and preserves explicit false', () => {
    const input = updateScheduleToolSchema.parse({
      id: 'sched-1',
      name: ' Renamed ',
      description: ' Updated ',
      enabled: false,
    });
    expect(normalizeUpdateScheduleToolInput(input, 'Europe/Vienna')).toEqual({
      name: 'Renamed',
      description: 'Updated',
      enabled: false,
    });
  });

  it.each([
    { mode: 'continue', target: 'continue', timezone: undefined },
    { mode: 'fire', target: 'new', timezone: 'Asia/Tokyo' },
  ])(
    'treats prompt and cadence updates as whole replacements in $mode mode',
    ({ mode, target, timezone }) => {
      const input = updateScheduleToolSchema.parse({
        id: 'sched-1',
        prompt: { text: 'New message' },
        cadence: { frequency: 'once', at: '2099-11-05T09:00', timezone },
        mode,
      });
      expect(normalizeUpdateScheduleToolInput(input, 'Europe/Vienna')).toEqual({
        prompt: 'New message',
        file_ids: [],
        cadence: { frequency: 'once', at: '2099-11-05T09:00' },
        timezone: timezone ?? 'Europe/Vienna',
        target,
      });
    },
  );

  it.each([
    { id: 'sched-1' },
    { id: 'sched-1', expectedConfigRevision: 0, enabled: false },
    { id: 'sched-1', changes: { enabled: false } },
    { schedule_id: 'sched-1', enabled: false },
    { id: 'sched-1', prompt: { file_ids: [] } },
    { id: 'sched-1', cadence: { frequency: 'daily' } },
    { id: 'sched-1', originConversationId: 'other' },
    { id: 'sched-1', currentProject: false },
    { id: 'sched-1', timezone: 'UTC' },
    { id: 'sched-1', cadence: { frequency: 'daily', hour: 9, minute: 0, timezone: '' } },
    { id: 'sched-1', agent_id: 'other' },
    { id: 'sched-1', enabled: false, user: 'other' },
  ])('rejects incomplete replacements, old wrappers and scope fields', (input) => {
    expect(updateScheduleToolSchema.safeParse(input).success).toBe(false);
  });

  it('rejects the former lookup field instead of accepting both ID names', () => {
    expect(getScheduleToolSchema.safeParse({ schedule_id: 'sched-1' }).success).toBe(false);
    expect(deleteScheduleToolSchema.safeParse({ schedule_id: 'sched-1' }).success).toBe(false);
  });

  it('exports JSON schemas matching the read and update contracts', () => {
    const contracts = [
      {
        native: listSchedulesToolSchema,
        json: listSchedulesToolJsonSchema,
        valid: {},
        invalid: { user: 'other' },
      },
      {
        native: getScheduleToolSchema,
        json: getScheduleToolJsonSchema,
        valid: { id: 'sched-1' },
        invalid: {},
      },
      {
        native: deleteScheduleToolSchema,
        json: deleteScheduleToolJsonSchema,
        valid: { id: 'sched-1' },
        invalid: { id: '' },
      },
      {
        native: updateScheduleToolSchema,
        json: updateScheduleToolJsonSchema,
        valid: { id: 'sched-1', enabled: false },
        invalid: { id: 'sched-1' },
      },
    ];
    for (const { native, json, valid, invalid } of contracts) {
      const validator = new Validator(json);
      expect(validator.validate(valid).valid).toBe(true);
      expect(native.safeParse(valid).success).toBe(true);
      expect(validator.validate(invalid).valid).toBe(false);
      expect(native.safeParse(invalid).success).toBe(false);
    }
  });
});

it('carries description metadata without accepting body-provided origin', () => {
  const input = {
    name: 'Reminder',
    description: ' Metadata ',
    originConversationId: 'origin-chat',
    prompt: 'Follow up',
    agent_id: 'agent-1',
    cadence: { frequency: 'daily', hour: 9, minute: 0 },
    timezone: 'UTC',
    clientRequestId: 'call-1',
  };
  expect(createSchedulePayloadSchema.parse(input)).toMatchObject({ description: 'Metadata' });
  expect(createSchedulePayloadSchema.parse(input)).not.toHaveProperty('originConversationId');
  expect(
    updateSchedulePayloadSchema.parse({ name: 'Edited', originConversationId: 'other' }),
  ).not.toHaveProperty('originConversationId');
});
