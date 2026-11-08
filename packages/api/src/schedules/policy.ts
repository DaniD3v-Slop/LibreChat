export interface ScheduleLimits {
  /** Feature-level switch: when false the engine claims/fires nothing. */
  enabled: boolean;
  /** Omitted means unlimited; an explicit zero prevents creation. */
  maxPerUser?: number;
  minIntervalMinutes: number;
  autoDisableAfterFailures: number;
  /** Maximum claimed occurrences concurrently passing readiness admission per replica. */
  admissionConcurrency: number;
  fireConcurrency: number;
  /** Maximum MCP readiness probes active during one schedule admission. */
  mcpPreflightConcurrency: number;
  /** Maximum wall-clock time for one unattended MCP readiness admission. */
  mcpPreflightTimeoutMs: number;
  /** Every schedule must be filed under a chat project. A pinned `projectId`
   *  implies this, so callers only ever have to read one flag. */
  requireProject: boolean;
  /** Operator-pinned destination project. When set it OVERRIDES whatever the row
   *  stores, at write time and at fire time alike — the pin is a policy about where
   *  scheduled runs land, and a stored id from before the pin must not outrank it. */
  projectId?: string;
}

export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = {
  enabled: true,
  minIntervalMinutes: 60,
  autoDisableAfterFailures: 5,
  admissionConcurrency: 20,
  fireConcurrency: 5,
  mcpPreflightConcurrency: 3,
  mcpPreflightTimeoutMs: 5 * 60_000,
  requireProject: false,
};

/**
 * The project a schedule's runs must land in under the CURRENT policy: an operator
 * pin outranks the stored choice, otherwise the owner's own selection stands.
 * Single source of truth for the write handlers, the fire path, and the wire
 * projection, so the form, the precheck, and the dispatched conversation can never
 * disagree about the destination.
 */
export function resolveScheduleProjectId(
  limits: Pick<ScheduleLimits, 'projectId'>,
  stored?: string | null,
): string | undefined {
  return limits.projectId ?? stored ?? undefined;
}

export interface ScheduleUserContext {
  id: string;
  tenantId?: string;
  role?: string;
}
