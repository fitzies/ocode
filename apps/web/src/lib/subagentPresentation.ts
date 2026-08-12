import type { SubagentRunStatus } from "@anvil/protocol";

import { isActiveSubagentStatus, type SubagentActivityItem } from "./subagentActivity";

export function cleanSubagentSummary(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]\s)\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanSubagentResult(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+answer\s*:?[ \t]*(?:\r?\n)+/i, "")
    .trimStart();
}

export function subagentRoleLabel(role: string): string {
  const clean = role.replace(/[_-]+/g, " ").trim() || "subagent";
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}`;
}

export function subagentStatusLabel(status: SubagentRunStatus): string {
  switch (status) {
    case "needs_attention": return "Needs attention";
    case "starting": return "Starting";
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Interrupted";
  }
}

function durationMilliseconds(item: SubagentActivityItem, now: number): number | undefined {
  const started = Date.parse(item.startedAt ?? item.createdAt);
  const live = isActiveSubagentStatus(item.status) || item.status === "needs_attention";
  if (!live && !item.endedAt) return undefined;
  const ended = item.endedAt ? Date.parse(item.endedAt) : now;
  const duration = ended - started;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function formatSubagentDuration(item: SubagentActivityItem, now: number): string | undefined {
  const milliseconds = durationMilliseconds(item, now);
  if (milliseconds === undefined) return undefined;
  if (milliseconds < 1_000) return "<1s";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatSubagentAge(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
}

export function formatSubagentTimestamp(value: string | undefined): string {
  if (!value) return "Not recorded";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

export function subagentNotificationCopy(item: SubagentActivityItem): string {
  if (!item.notification) return "Not requested";
  switch (item.notification.status) {
    case "pending": return "Pending delivery to parent";
    case "delivering": return "Delivering to parent";
    case "delivered": return "Delivered to parent";
    case "uncertain": return "Delivery uncertain — check the parent thread before retrying";
  }
}
