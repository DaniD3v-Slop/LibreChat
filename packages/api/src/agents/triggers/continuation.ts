import type { AgentTriggerExecutionHostDeps } from './host';

type ContinueResolver = NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>;

export interface AgentContinuationResolverDeps {
  eventActor: ContinueResolver;
  schedule?: ContinueResolver;
  internalSources: ReadonlyMap<string, ContinueResolver>;
}

/** Selects the single continuation adapter authorized for this delivery. */
export function createAgentContinuationResolver({
  eventActor,
  schedule,
  internalSources,
}: AgentContinuationResolverDeps): ContinueResolver {
  return (envelope, context) => {
    if (envelope.target.bindingId != null && envelope.target.sourceKeyId != null) {
      return eventActor(envelope, context);
    }
    if (envelope.event.source.type === 'schedule') {
      return schedule?.(envelope, context);
    }
    if (envelope.event.source.type !== 'internal') {
      return;
    }
    return internalSources.get(envelope.event.source.id)?.(envelope, context);
  };
}
