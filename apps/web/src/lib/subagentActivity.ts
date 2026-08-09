import type { SubagentRun } from "@anvil/protocol";

export interface SubagentActivity {
  active: number;
  finished: number;
  items: SubagentRun[];
}

function isActive(entry: SubagentRun): boolean {
  return entry.status === "queued" || entry.status === "running" || entry.status === "paused";
}

function entryTime(entry: SubagentRun): number {
  const timestamp = Date.parse(entry.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function subagentActivityForSession(entries: readonly SubagentRun[]): SubagentActivity {
  const items = [...entries].sort((left, right) => {
    const activeDifference = Number(isActive(right)) - Number(isActive(left));
    return activeDifference || entryTime(right) - entryTime(left);
  });
  const active = items.filter(isActive).length;
  return { active, finished: items.length - active, items };
}
