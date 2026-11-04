import type { ISchedule } from '@librechat/data-schemas';

/** Public projection of a schedule — an allowlist of the `TSchedule` fields, so internal
 *  bookkeeping (_id, tenantId, __v, claimToken, lease*, slot, deleting, countedFor,
 *  balanceSkipCount, bookkept, ...) never reaches the browser. */
export type WireSchedule = Pick<
  ISchedule,
  | 'id'
  | 'user'
  | 'name'
  | 'description'
  | 'originConversationId'
  | 'prompt'
  | 'agent_id'
  | 'cadence'
  | 'timezone'
  | 'target'
  | 'conversationId'
  | 'chatProjectId'
  | 'file_ids'
  | 'enabled'
  | 'disabledReason'
  | 'nextRunAt'
  | 'lastRun'
  | 'runCount'
  | 'failureCount'
  | 'configRevision'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** See `TSchedule.inFlight`: the generating occurrences, from their own run rows. */
  inFlight?: Array<{ conversationId: string }>;
};
