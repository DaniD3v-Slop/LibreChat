import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { SerializableJobData } from '~/stream/interfaces/IJobStore';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { MCPToolAlias } from '~/tools/classification';
import type { ResolvedToolApprovalHook } from './hooks';
import {
  healToolApprovalPolicy,
  isHITLEnabled,
  isToolApprovalPauseCapable,
  isToolDeniedByApprovalPolicy,
  resolveToolApprovalPolicy,
  exemptScheduleReadsFromApproval,
} from './policy';
import { SCHEDULE_CHAT_TOOL_NAME, SCHEDULE_WRITE_TOOL_NAMES } from '~/agents/schedule';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionTool';
import { resolvedToolApprovalHooksCanMatch } from './hooks';
import { collectReachableAgents } from '../traversal';

interface ApprovalToolReference {
  readonly name?: string;
}

interface ApprovalToolRegistry {
  keys(): Iterable<string>;
  has(name: string): boolean;
}

interface ApprovalSubagentGraph {
  readonly memberConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
}

export interface ToolApprovalAdmissionAgent {
  readonly id?: string;
  readonly tools?: readonly (string | ApprovalToolReference)[];
  readonly toolRegistry?: ApprovalToolRegistry;
  readonly toolDefinitions?: readonly ApprovalToolReference[];
  readonly mcpToolAliases?: readonly MCPToolAlias[];
  readonly subagentAgentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly lazySubagentConfigs?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphMemberMetadata?: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly subagentGraphConfigs?: readonly ApprovalSubagentGraph[];
}

export interface ToolApprovalAdmissionInput {
  readonly policy: TToolApprovalPolicy | undefined;
  readonly agents: readonly (ToolApprovalAdmissionAgent | null | undefined)[];
  readonly hostGeneratedToolNames?: readonly string[];
  readonly resolvedProgrammaticHooks?: readonly ResolvedToolApprovalHook[];
  readonly pluginHookSource?: PluginHookSource;
  readonly askUserQuestionAdminDisabled?: boolean;
}

function agentHasTool(agent: ToolApprovalAdmissionAgent, toolName: string): boolean {
  return (
    agent.tools?.some((tool) => (typeof tool === 'string' ? tool : tool.name) === toolName) ===
      true ||
    agent.toolRegistry?.has(toolName) === true ||
    agent.toolDefinitions?.some((definition) => definition.name === toolName) === true
  );
}

function collectApprovalAgents(roots: readonly (ToolApprovalAdmissionAgent | null | undefined)[]): {
  agents: ToolApprovalAdmissionAgent[];
  lazyAgentIds: Set<string | undefined>;
} {
  const agents = collectReachableAgents(roots);
  const lazyAgentIds = new Set(
    agents.flatMap((agent) => (agent.lazySubagentConfigs ?? []).map((child) => child?.id)),
  );
  return { agents, lazyAgentIds };
}

function agentsRequestScheduleChat(agents: readonly ToolApprovalAdmissionAgent[]): boolean {
  return agents.some(
    (agent) =>
      agentHasTool(agent, SCHEDULE_CHAT_TOOL_NAME) ||
      SCHEDULE_WRITE_TOOL_NAMES.some((name) => agentHasTool(agent, name)),
  );
}

/** Whether an eager or declared lazy agent can write schedules. */
export function agentGraphRequestsScheduleChat(
  roots: readonly (ToolApprovalAdmissionAgent | null | undefined)[],
): boolean {
  return agentsRequestScheduleChat(collectReachableAgents(roots));
}

/**
 * Whether an initialized run can pause through tool approval or a top-level
 * `ask_user_question`. Eager tools are matched exactly across every subagent
 * form; unresolved lazy surfaces are classified conservatively. The interrupt
 * boundary remains the final fail-closed durability check.
 */
export function canAgentGraphPause({
  policy: configuredPolicy,
  agents,
  hostGeneratedToolNames = [],
  resolvedProgrammaticHooks = [],
  pluginHookSource,
  askUserQuestionAdminDisabled = false,
}: ToolApprovalAdmissionInput): boolean {
  const approvalGraph = collectApprovalAgents(agents);
  const policy = resolveToolApprovalPolicy({
    endpoint: configuredPolicy,
    scheduleChat: agentsRequestScheduleChat(approvalGraph.agents),
  });
  const asksUserQuestion =
    !askUserQuestionAdminDisabled &&
    !isToolDeniedByApprovalPolicy(policy, ASK_USER_QUESTION_TOOL_NAME) &&
    agents.some((agent) => agent != null && agentHasTool(agent, ASK_USER_QUESTION_TOOL_NAME));
  if (!isHITLEnabled(policy)) {
    return asksUserQuestion;
  }

  const toolOwners = new Map<string, Set<string | undefined>>();
  const aliases: MCPToolAlias[] = [];
  const aliasesByToolName = new Map<string, string[]>();
  const addToolName = (name: unknown, agentId?: string) => {
    if (name === SCHEDULE_CHAT_TOOL_NAME) {
      for (const writeName of SCHEDULE_WRITE_TOOL_NAMES) {
        addToolName(writeName, agentId);
      }
      return;
    }
    if (typeof name === 'string' && name !== ASK_USER_QUESTION_TOOL_NAME) {
      const owners = toolOwners.get(name) ?? new Set<string | undefined>();
      owners.add(agentId);
      toolOwners.set(name, owners);
    }
  };

  for (const name of hostGeneratedToolNames) {
    addToolName(name);
  }

  for (const agent of approvalGraph.agents) {
    for (const tool of agent.tools ?? []) {
      addToolName(typeof tool === 'string' ? tool : tool.name, agent.id);
    }
    if (agent.toolRegistry) {
      for (const name of agent.toolRegistry.keys()) {
        addToolName(name, agent.id);
      }
    }
    for (const definition of agent.toolDefinitions ?? []) {
      addToolName(definition.name, agent.id);
    }
    for (const alias of agent.mcpToolAliases ?? []) {
      aliases.push(alias);
      const names = aliasesByToolName.get(alias.name) ?? [];
      names.push(alias.aliasName);
      aliasesByToolName.set(alias.name, names);
    }
  }

  const effectivePolicy = exemptScheduleReadsFromApproval(healToolApprovalPolicy(policy, aliases));
  const knownToolCanPause = Array.from(toolOwners).some(([toolName, agentIds]) => {
    const matcherNames = [toolName, ...(aliasesByToolName.get(toolName) ?? [])];
    const pluginHookCanAsk = pluginHookSource?.hasToolApprovalHooks?.([toolName]) === true;
    return Array.from(agentIds).some((agentId) => {
      const requestHookCanAsk = resolvedToolApprovalHooksCanMatch(
        resolvedProgrammaticHooks,
        matcherNames,
        agentId,
      );
      return isToolApprovalPauseCapable(effectivePolicy, requestHookCanAsk || pluginHookCanAsk, [
        toolName,
      ]);
    });
  });
  if (knownToolCanPause) {
    return true;
  }
  if (approvalGraph.lazyAgentIds.size > 0) {
    const pluginHookCanAsk = pluginHookSource?.hasToolApprovalHooks?.() === true;
    const unresolvedHookCanAsk = Array.from(approvalGraph.lazyAgentIds).some(
      (agentId) =>
        resolvedProgrammaticHooks.some(
          ({ agentIds }) => agentIds == null || (agentId != null && agentIds.has(agentId)),
        ) || pluginHookCanAsk,
    );
    const staticPolicyCanAsk = isToolApprovalPauseCapable(effectivePolicy);
    if (staticPolicyCanAsk || unresolvedHookCanAsk) {
      return true;
    }
  }
  return asksUserQuestion;
}

/**
 * Whether `createRun` attaches a checkpointer for this initialization.
 * Cleanup follows attachment, not current pause capability: a retry must not
 * restore remnants written before a policy or request-hook change.
 */
export function agentRunUsesCheckpointer({
  policy,
  agents,
  askUserQuestionAdminDisabled = false,
}: Pick<
  ToolApprovalAdmissionInput,
  'policy' | 'agents' | 'askUserQuestionAdminDisabled'
>): boolean {
  return (
    isHITLEnabled(
      resolveToolApprovalPolicy({
        endpoint: policy,
        scheduleChat: agentGraphRequestsScheduleChat(agents),
      }),
    ) ||
    (!askUserQuestionAdminDisabled &&
      agents.some((agent) => agent != null && agentHasTool(agent, ASK_USER_QUESTION_TOOL_NAME)))
  );
}

/** Terminal owners prune exact generation scopes even when no approval is currently pending. */
export function shouldPruneAgentCheckpoint(
  metadata:
    | Pick<
        SerializableJobData,
        'checkpointNamespace' | 'pendingAction' | 'resolvedAskUserQuestions'
      >
    | undefined,
  policy?: TToolApprovalPolicy,
): boolean {
  return (
    (typeof metadata?.checkpointNamespace === 'string' &&
      metadata.checkpointNamespace.length > 0) ||
    isHITLEnabled(policy) ||
    metadata?.pendingAction != null ||
    (metadata?.resolvedAskUserQuestions?.length ?? 0) > 0
  );
}
