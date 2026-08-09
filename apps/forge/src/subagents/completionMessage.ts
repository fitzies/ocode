import type {
  MessageEntry,
  SubagentCompletionMessageOrigin,
  SubagentCompletionStatus,
  SubagentRun,
} from "@anvil/protocol";

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentCompletionStatus>([
  "completed", "failed", "cancelled", "interrupted",
]);

function isTerminalSubagentStatus(status: SubagentRun["status"]): status is SubagentCompletionStatus {
  return TERMINAL_SUBAGENT_STATUSES.has(status as SubagentCompletionStatus);
}

export function subagentCompletionHeading(run: SubagentRun): string {
  return `[ocode ${run.role} subagent ${run.id} ${run.status}]`;
}

export function subagentCompletionPrefix(run: SubagentRun): string {
  return `${subagentCompletionHeading(run)}\nChild session: ${run.childSessionId}`;
}

/**
 * Recognizes only completion envelopes that agree with Forge's durable run
 * metadata. The message keeps Pi's user role; origin records who authored it.
 */
export function subagentCompletionOrigin(
  parentSessionId: string,
  message: MessageEntry,
  runs: readonly SubagentRun[],
): SubagentCompletionMessageOrigin | undefined {
  if (message.role !== "user") return undefined;
  const content = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n");
  if (!content) return undefined;

  const run = runs.find((candidate) =>
    candidate.parentSessionId === parentSessionId &&
    candidate.notification !== undefined &&
    isTerminalSubagentStatus(candidate.status) &&
    content.startsWith(`${subagentCompletionPrefix(candidate)}\n`)
  );
  if (!run?.notification || !isTerminalSubagentStatus(run.status)) return undefined;
  return {
    type: "subagentCompletion",
    runId: run.id,
    childSessionId: run.childSessionId,
    deliveryId: run.notification.id,
    role: run.role,
    status: run.status,
  };
}
