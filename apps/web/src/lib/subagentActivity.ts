import type { TimelineEntry, ToolEntry } from "@anvil/protocol";

export interface SubagentActivity {
  active: number;
  finished: number;
  items: ToolEntry[];
}

function isActive(entry: ToolEntry): boolean {
  return entry.status === "queued" || entry.status === "running";
}

function entryTime(entry: ToolEntry): number {
  const timestamp = Date.parse(entry.startedAt ?? entry.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function subagentActivityForSession(entries: readonly TimelineEntry[]): SubagentActivity {
  const items = entries
    .filter((entry): entry is ToolEntry => entry.kind === "tool" && entry.name.toLowerCase() === "subagent")
    .sort((left, right) => {
      const activeDifference = Number(isActive(right)) - Number(isActive(left));
      return activeDifference || entryTime(right) - entryTime(left);
    });
  const active = items.filter(isActive).length;
  return { active, finished: items.length - active, items };
}
