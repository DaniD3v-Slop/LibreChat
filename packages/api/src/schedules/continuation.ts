import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import type { TSubagentThreadLineage } from 'librechat-data-provider';
import type { AgentTriggerExecutionHostDeps } from '../agents/triggers/host';
import type { ScheduleConversation } from './types';
import { isAgentEventRetentionActive } from '../agents/eventRetention';
import { AgentTriggerExecutionError } from '../agents/triggers/host';
import { getSafeErrorMetadata } from '~/utils/errors';

type ContinueResolver = NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>;

export interface ScheduleContinuationDeps {
  methods: {
    getConvo: (
      userId: string,
      conversationId: string,
    ) => Promise<
      | (ScheduleConversation & {
          subagentThread?: TSubagentThreadLineage;
          expiredAt?: Date;
        })
      | null
    >;
    getMessages: (
      filter: { user: string; conversationId: string; isCreatedByUser: false },
      select: string,
      options: { sort: { createdAt: -1; _id: -1 }; limit: number },
    ) => Promise<Array<{ messageId: string }>>;
  };
  getGenerationJob: (conversationId: string) => Promise<
    | {
        status?: string;
        createdAt?: number;
        metadata?: { terminalPersistencePending?: boolean };
      }
    | null
    | undefined
  >;
}

/**
 * Resolves an owner-bound conversation's latest eligible branch at dispatch.
 * The owning chat request rechecks schedule liveness, revision and policy before
 * generation admission; this adapter only resolves conversation eligibility.
 */
export function createScheduleContinueResolver({
  methods,
  getGenerationJob,
}: ScheduleContinuationDeps): ContinueResolver {
  return async (envelope) => {
    if (
      envelope.event.source.type !== 'schedule' ||
      envelope.event.type !== 'schedule.occurrence'
    ) {
      return;
    }
    try {
      const invalid = () =>
        new AgentTriggerExecutionError('The scheduled conversation is no longer available.', {
          mode: 'continue',
          certainty: 'definite',
          retryable: false,
          code: 'SCHEDULE_TARGET_UNAVAILABLE',
          status: 404,
        });
      const conversation = await methods.getConvo(
        envelope.principal.userId,
        envelope.target.conversationId,
      );
      if (
        conversation == null ||
        conversation.agent_id !== envelope.target.agentId ||
        (conversation.tenantId ?? undefined) !== envelope.principal.tenantId ||
        conversation.subagentThread != null ||
        !isAgentEventRetentionActive(conversation.expiredAt)
      ) {
        throw invalid();
      }
      const active = await getGenerationJob(envelope.target.conversationId);
      if (
        active?.status === 'running' ||
        active?.status === 'requires_action' ||
        active?.metadata?.terminalPersistencePending === true
      ) {
        throw new AgentTriggerExecutionError(
          'The scheduled conversation is still handling an earlier turn.',
          {
            mode: 'continue',
            certainty: 'definite',
            retryable: true,
            deferWithoutAttempt: true,
            code: 'PARENT_NOT_READY',
            status: 409,
          },
        );
      }
      const [latestAssistant] = await methods.getMessages(
        {
          user: envelope.principal.userId,
          conversationId: envelope.target.conversationId,
          isCreatedByUser: false,
        },
        'messageId createdAt',
        { sort: { createdAt: -1, _id: -1 }, limit: 1 },
      );
      return {
        status: 'ready',
        input: envelope.input,
        parentMessageId: latestAssistant?.messageId ?? Constants.NO_PARENT,
        ...(active?.createdAt != null && { expectedPredecessorCreatedAt: active.createdAt }),
      };
    } catch (error) {
      if (
        error instanceof AgentTriggerExecutionError &&
        (error.code === 'PARENT_NOT_READY' || error.code === 'SCHEDULE_TARGET_UNAVAILABLE')
      ) {
        throw error;
      }
      logger.error('[schedules] continuation admission failed', getSafeErrorMetadata(error));
      throw new AgentTriggerExecutionError(
        'Scheduled conversation state is temporarily unavailable.',
        {
          mode: 'continue',
          certainty: 'definite',
          retryable: true,
          code: 'SCHEDULE_TARGET_UNAVAILABLE',
          status: 503,
        },
      );
    }
  };
}
