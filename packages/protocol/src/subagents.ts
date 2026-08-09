export const SUBAGENT_IDENTIFIER_MAX_BYTES = 512;
export const SUBAGENT_TASK_PREVIEW_MAX_BYTES = 2 * 1024;
export const SUBAGENT_RESULT_PREVIEW_MAX_BYTES = 4 * 1024;
export const SUBAGENT_COMPLETION_MAX_BYTES = 8 * 1024;
export const SUBAGENT_SPAWN_PROMPT_MAX_BYTES = 48 * 1024;

export type SubagentRole = "builder" | "scout" | "researcher" | "reviewer";

export type SubagentRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type SubagentNotificationStatus = "pending" | "delivering" | "delivered" | "uncertain";

export interface SubagentRun {
  id: string;
  parentSessionId: string;
  parentToolCallId: string;
  childSessionId: string;
  role: SubagentRole;
  status: SubagentRunStatus;
  taskPreview: string;
  resultPreview?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  notification?: {
    id: string;
    status: SubagentNotificationStatus;
    updatedAt: string;
    error?: string;
  };
}

const ROLES = new Set<SubagentRole>(["builder", "scout", "researcher", "reviewer"]);
const RUN_STATUSES = new Set<SubagentRunStatus>([
  "queued", "starting", "running", "needs_attention", "completed", "failed", "cancelled", "interrupted",
]);
const NOTIFICATION_STATUSES = new Set<SubagentNotificationStatus>([
  "pending", "delivering", "delivered", "uncertain",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isSubagentRun(value: unknown): value is SubagentRun {
  if (!isRecord(value)) return false;
  if (!["id", "parentSessionId", "parentToolCallId", "childSessionId", "status", "taskPreview", "createdAt", "updatedAt"]
    .every((key) => typeof value[key] === "string")) return false;
  if (!["id", "parentSessionId", "parentToolCallId", "childSessionId"].every((key) =>
    (value[key] as string).length > 0 && utf8Bytes(value[key] as string) <= SUBAGENT_IDENTIFIER_MAX_BYTES
  )) return false;
  if (!ROLES.has(value.role as SubagentRole) || !RUN_STATUSES.has(value.status as SubagentRunStatus)) return false;
  if (utf8Bytes(value.taskPreview as string) > SUBAGENT_TASK_PREVIEW_MAX_BYTES) return false;
  if (value.resultPreview !== undefined && (
    typeof value.resultPreview !== "string" || utf8Bytes(value.resultPreview) > SUBAGENT_RESULT_PREVIEW_MAX_BYTES
  )) return false;
  if (value.error !== undefined && (
    typeof value.error !== "string" || utf8Bytes(value.error) > SUBAGENT_RESULT_PREVIEW_MAX_BYTES
  )) return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.endedAt !== undefined && typeof value.endedAt !== "string") return false;
  if (value.notification !== undefined) {
    if (!isRecord(value.notification) ||
      typeof value.notification.id !== "string" ||
      utf8Bytes(value.notification.id) > SUBAGENT_IDENTIFIER_MAX_BYTES ||
      typeof value.notification.updatedAt !== "string" ||
      !NOTIFICATION_STATUSES.has(value.notification.status as SubagentNotificationStatus) ||
      (value.notification.error !== undefined && (
        typeof value.notification.error !== "string" ||
        utf8Bytes(value.notification.error) > SUBAGENT_RESULT_PREVIEW_MAX_BYTES
      ))) return false;
  }
  return true;
}

export function isTerminalSubagentStatus(status: SubagentRunStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
