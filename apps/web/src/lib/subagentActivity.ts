import type {
  JsonValue,
  SubagentNotificationStatus,
  SubagentRole,
  SubagentRun,
  SubagentRunStatus,
  TimelineEntry,
  ToolEntry,
} from "@anvil/protocol";

const LEGACY_PREVIEW_LENGTH = 1_000;

export interface SubagentActivityItem {
  id: string;
  source: "durable" | "legacy";
  role: SubagentRole | string;
  status: SubagentRunStatus;
  task: string;
  result?: string;
  error?: string;
  parentToolCallId: string;
  childSessionId?: string;
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

export interface SubagentActivity {
  active: number;
  finished: number;
  failed: number;
  needsAttention: number;
  items: SubagentActivityItem[];
}

function argument(entry: ToolEntry, keys: readonly string[]): string | undefined {
  if (!entry.arguments || typeof entry.arguments !== "object" || Array.isArray(entry.arguments)) return undefined;
  const values = entry.arguments as Record<string, JsonValue>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function bounded(value: string | undefined, length = LEGACY_PREVIEW_LENGTH): string | undefined {
  if (!value) return undefined;
  const clean = value.trim();
  if (!clean) return undefined;
  return clean.length <= length ? clean : `${clean.slice(0, length - 1).trimEnd()}…`;
}

function legacyResponse(entry: ToolEntry): string | undefined {
  let preview = "";
  for (const block of entry.output) {
    if (block.type !== "text" || !block.text.trim()) continue;
    const separator = preview ? "\n\n" : "";
    preview += separator + block.text.slice(0, LEGACY_PREVIEW_LENGTH - preview.length);
    if (preview.length >= LEGACY_PREVIEW_LENGTH) break;
  }
  return bounded(preview);
}

function legacyStatus(entry: ToolEntry): SubagentRunStatus {
  if (entry.status === "queued") return "queued";
  if (entry.status === "running") return "running";
  if (entry.status === "completed") return "completed";
  if (entry.status === "cancelled") return "cancelled";
  return "failed";
}

function legacyItem(entry: ToolEntry): SubagentActivityItem {
  const response = legacyResponse(entry);
  const status = legacyStatus(entry);
  return {
    id: `legacy:${entry.id}`,
    source: "legacy",
    role: argument(entry, ["role", "agent"]) ?? entry.label ?? "Subagent",
    status,
    task: bounded(argument(entry, ["task", "message", "prompt"])) ?? bounded(entry.summary) ?? "Task unavailable",
    ...(status === "failed" ? { error: response ?? "The subagent tool failed." } : response ? { result: response } : {}),
    parentToolCallId: entry.toolCallId,
    createdAt: entry.createdAt,
    updatedAt: entry.endedAt ?? entry.startedAt ?? entry.createdAt,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
  };
}

function durableItem(run: SubagentRun): SubagentActivityItem {
  return {
    id: run.id,
    source: "durable",
    role: run.role,
    status: run.status,
    task: run.taskPreview || "Task unavailable",
    result: run.resultPreview,
    error: run.error,
    parentToolCallId: run.parentToolCallId,
    childSessionId: run.childSessionId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    notification: run.notification,
  };
}

export function isActiveSubagentStatus(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

export function canCancelSubagentStatus(status: SubagentRunStatus): boolean {
  return isActiveSubagentStatus(status) || status === "needs_attention";
}

function itemTime(item: SubagentActivityItem): number {
  const timestamp = Date.parse(item.startedAt ?? item.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function statusPriority(status: SubagentRunStatus): number {
  if (status === "needs_attention") return 0;
  if (isActiveSubagentStatus(status)) return 1;
  if (status === "failed" || status === "interrupted") return 2;
  return 3;
}

/**
 * Builds activity from Forge's bounded durable projection. Legacy `subagent`
 * tools remain visible only when no durable run owns the same parent tool call.
 */
export function subagentActivityForSession(
  runs: readonly SubagentRun[],
  entries: readonly TimelineEntry[],
): SubagentActivity {
  const linkedToolCallIds = new Set(runs.map((run) => run.parentToolCallId));
  const legacy = entries
    .filter((entry): entry is ToolEntry => (
      entry.kind === "tool" &&
      entry.name.toLowerCase() === "subagent" &&
      !linkedToolCallIds.has(entry.toolCallId)
    ))
    .map(legacyItem);
  const items = [...runs.map(durableItem), ...legacy].sort((left, right) => (
    statusPriority(left.status) - statusPriority(right.status) || itemTime(right) - itemTime(left)
  ));

  return {
    active: items.filter((item) => isActiveSubagentStatus(item.status)).length,
    finished: items.filter((item) => ["completed", "cancelled"].includes(item.status)).length,
    failed: items.filter((item) => item.status === "failed" || item.status === "interrupted").length,
    needsAttention: items.filter((item) => item.status === "needs_attention").length,
    items,
  };
}
