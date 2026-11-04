import type { HookCallback } from '@librechat/agents';
import type { CheckAccessParams } from '~/middleware/access';
import type { ServerRequest } from '~/types';
import { isScheduleToolAllowed, isScheduleToolName, isScheduleWriteTool } from '~/agents/schedule';
import { hasScheduledGenerationContext } from '~/schedules/trigger';

/** Check permissions and deny scheduled writes before native approval, including late steers. */
export function createScheduleChatApprovalHook(
  req: ServerRequest,
  getJob: Parameters<typeof hasScheduledGenerationContext>[1],
  getRoleByName: CheckAccessParams['getRoleByName'],
): HookCallback<'PreToolUse'> {
  return async ({ toolName }) => {
    if (!isScheduleToolName(toolName)) {
      return {};
    }
    try {
      if (!(await isScheduleToolAllowed({ req, getRoleByName }, isScheduleWriteTool(toolName)))) {
        return { decision: 'deny', reason: 'Schedule access is not permitted.' };
      }
      if (!isScheduleWriteTool(toolName)) return {};
      if (await hasScheduledGenerationContext(req, getJob)) {
        return { decision: 'deny', reason: 'Scheduled generations cannot modify schedules.' };
      }
      return {};
    } catch {
      return { decision: 'deny', reason: 'Schedule access requires a verified active chat.' };
    }
  };
}
