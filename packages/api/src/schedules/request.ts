import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

export interface ScheduleToolContext {
  agentId: string;
  conversationId: string;
  projectId: string | null;
}

/** The host captures this context from the authenticated current chat, never model input. */
export interface ScheduleToolRequest extends ServerRequest {
  scheduleToolContext?: ScheduleToolContext;
}

export interface ScheduleConversation {
  conversationId?: string;
  user?: string;
  agent_id?: string | null;
  tenantId?: string | null;
  chatProjectId?: string | null;
}

/** In-process callers use the same CRUD handlers as the HTTP routes. */
export interface ScheduleCrudHandlers {
  createSchedule: (req: ScheduleToolRequest, res: Response) => Promise<void>;
  listSchedules: (req: ScheduleToolRequest, res: Response) => Promise<void>;
  getSchedule: (req: ScheduleToolRequest, res: Response) => Promise<void>;
  updateSchedule: (req: ScheduleToolRequest, res: Response) => Promise<void>;
  deleteSchedule: (req: ScheduleToolRequest, res: Response) => Promise<void>;
}
