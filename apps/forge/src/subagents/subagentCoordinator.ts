import { randomUUID } from "node:crypto";

import {
  SUBAGENT_COMPLETION_MAX_BYTES,
  SUBAGENT_RESULT_PREVIEW_MAX_BYTES,
  SUBAGENT_SPAWN_PROMPT_MAX_BYTES,
  SUBAGENT_TASK_PREVIEW_MAX_BYTES,
  type AnvilCommandResponse,
  type AnvilEvent,
  type SubagentRole,
  type SubagentRun,
} from "@anvil/protocol";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { subagentCompletionHeading } from "./completionMessage.ts";
import { buildSubagentPrompt } from "./roleCatalog.ts";

interface SubagentSessionRuntime {
  createSubagentSession(input: { sessionId: string; parentSessionId: string; title: string }): void;
  sendSubagentPrompt(runId: string, childSessionId: string, prompt: string): Promise<AnvilCommandResponse>;
  cancelSubagentSession(runId: string, childSessionId: string): Promise<AnvilCommandResponse>;
  deliverSubagentCompletion(deliveryId: string, parentSessionId: string, content: string): Promise<AnvilCommandResponse>;
  deleteSubagentSession(childSessionId: string): Promise<void>;
}

export interface SubagentLaunchRequest {
  parentSessionId: string;
  parentToolCallId: string;
  task: string;
  role?: SubagentRole;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Truncate by UTF-8 bytes without splitting a code point. */
export function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let end = Math.min(value.length, room);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > room) end -= 1;
  while (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}

export function subagentCompletionContent(run: SubagentRun, richBytes = SUBAGENT_COMPLETION_MAX_BYTES): string {
  const heading = subagentCompletionHeading(run);
  const reference = `Child session: ${run.childSessionId}`;
  if (richBytes <= 0) return `${heading}\n${reference}\nCompletion preview budget exhausted; inspect the linked child session.`;
  const body = run.resultPreview || run.error || "No result preview was available.";
  return boundedUtf8(`${heading}\n${reference}\n\n${body}`, Math.min(richBytes, SUBAGENT_COMPLETION_MAX_BYTES));
}

export class SubagentCoordinator {
  private readonly prompts = new Map<string, string>();
  private readonly queued: string[] = [];
  private readonly active = new Set<string>();
  private readonly cancelling = new Set<string>();
  private readonly deletingParents = new Set<string>();
  private readonly suppressNotification = new Set<string>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private retentionCleanupTail: Promise<void> = Promise.resolve();
  private readonly pendingRetentionCleanup = new Set<string>();
  private retentionCleanupScheduled = false;
  private stopped = false;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly events: ForgeEventService,
    private readonly sessions: SubagentSessionRuntime,
    private readonly concurrency = 2,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Subagent concurrency must be positive");
    const timestamp = new Date().toISOString();
    this.events.acceptSubagentEvents(this.database.subagents.resetDeliveriesAfterRestart(timestamp));
    for (const run of this.database.subagents.list()) {
      if (TERMINAL.has(run.status)) continue;
      const updated = this.database.subagents.updateStatus(run.id, "interrupted", timestamp, {
        error: "Interrupted by Forge restart; task metadata was preserved but no side effect was replayed",
      });
      if (updated) this.events.acceptSubagentEvents(updated.events);
    }
    this.events.on("event", this.onEvent);
    this.scheduleRetentionCleanup(this.database.unretainedChildSessionIds());
    this.scheduleDelivery();
  }

  launch(request: SubagentLaunchRequest): SubagentRun {
    if (this.stopped) throw new Error("Subagent coordinator is stopping");
    const task = request.task.trim();
    if (!task) throw new Error("Subagent task must not be empty");
    const timestamp = new Date().toISOString();
    const role = request.role ?? "scout";
    if (this.deletingParents.has(request.parentSessionId)) throw new Error("Parent session is being deleted");
    const admission = this.database.subagents.admit({
      parentSessionId: request.parentSessionId,
      parentToolCallId: request.parentToolCallId,
      childSessionId: randomUUID(),
      role,
      task: boundedUtf8(task, SUBAGENT_SPAWN_PROMPT_MAX_BYTES),
      taskPreview: boundedUtf8(task, SUBAGENT_TASK_PREVIEW_MAX_BYTES),
      timestamp,
    });
    if (admission.events.length) this.events.acceptSubagentEvents(admission.events);
    this.scheduleRetentionCleanup([
      ...new Set([...admission.prunedChildSessionIds, ...this.database.unretainedChildSessionIds()]),
    ]);
    if (admission.created) {
      // The role-expanded prompt is intentionally ephemeral. A restart preserves
      // bounded task metadata but never replays a prompt whose side effects may have begun.
      this.prompts.set(admission.run.id, buildSubagentPrompt(role, task));
      this.queued.push(admission.run.id);
      setImmediate(() => this.pump());
    }
    return admission.run;
  }

  status(parentSessionId: string, runId: string): SubagentRun | undefined {
    const run = this.database.subagents.get(runId);
    return run?.parentSessionId === parentSessionId ? run : undefined;
  }

  async cancel(parentSessionId: string, runId: string): Promise<SubagentRun> {
    const run = this.status(parentSessionId, runId);
    if (!run) throw new Error("Subagent run not found");
    if (TERMINAL.has(run.status)) return run;
    this.cancelling.add(run.id);
    if (!this.active.has(run.id)) {
      this.prompts.delete(run.id);
      this.removeQueued(run.id);
      return this.finish(run.id, "cancelled") ?? this.database.subagents.get(run.id)!;
    }
    const response = await this.sessions.cancelSubagentSession(run.id, run.childSessionId);
    if (!response.success) {
      const current = this.database.subagents.get(run.id);
      if (current && !TERMINAL.has(current.status)) this.cancelling.delete(run.id);
      throw new Error(response.error ?? "Pi rejected subagent cancellation");
    }
    const current = this.database.subagents.get(run.id);
    if (current && !TERMINAL.has(current.status)) return this.finish(run.id, "cancelled") ?? current;
    return current ?? run;
  }

  /** Stops and removes every owned child before its parent lifecycle can be deleted. */
  async deleteOwnedChildren(parentSessionId: string): Promise<void> {
    this.deletingParents.add(parentSessionId);
    const runs = this.database.subagents.list(parentSessionId);
    // Session parent linkage is the durable ownership authority. A run row may
    // already have been pruned, but its child must still follow the parent.
    const childSessionIds = this.database.childSessionIds(parentSessionId);
    const runsByChildSessionId = new Map(runs.map((run) => [run.childSessionId, run]));
    const deletedRunIds = new Set<string>();
    for (const run of runs) this.suppressNotification.add(run.id);
    try {
      for (const run of runs) {
        if (!TERMINAL.has(run.status)) await this.cancel(parentSessionId, run.id);
      }
      for (const childSessionId of childSessionIds) {
        await this.sessions.deleteSubagentSession(childSessionId);
        const run = runsByChildSessionId.get(childSessionId);
        if (run) {
          this.events.acceptSubagentEvents(this.database.subagents.delete(run.id, new Date().toISOString()));
          deletedRunIds.add(run.id);
        }
      }
      // Queued children may not have created their session yet.
      for (const run of runs) {
        if (!deletedRunIds.has(run.id)) {
          this.events.acceptSubagentEvents(this.database.subagents.delete(run.id, new Date().toISOString()));
        }
      }
    } catch (error) {
      this.deletingParents.delete(parentSessionId);
      throw error;
    } finally {
      for (const run of runs) this.suppressNotification.delete(run.id);
    }
  }

  /** Releases the launch barrier after the parent deletion commits or aborts. */
  finishParentDeletion(parentSessionId: string): void {
    this.deletingParents.delete(parentSessionId);
  }

  /** Cancels ownership before a directly-addressed internal child is deleted. */
  async prepareChildDeletion(childSessionId: string): Promise<void> {
    const run = this.database.subagents.getByChildSessionId(childSessionId);
    if (!run) return;
    this.suppressNotification.add(run.id);
    try {
      if (!TERMINAL.has(run.status)) await this.cancel(run.parentSessionId, run.id);
      this.events.acceptSubagentEvents(this.database.subagents.delete(run.id, new Date().toISOString()));
    } finally {
      this.suppressNotification.delete(run.id);
    }
  }

  stop(): void {
    this.stopped = true;
    this.events.off("event", this.onEvent);
    this.queued.length = 0;
    this.prompts.clear();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active.size < this.concurrency) {
      const runId = this.queued.shift();
      if (!runId) break;
      const prompt = this.prompts.get(runId);
      const run = this.database.subagents.get(runId);
      if (!prompt || !run || run.status !== "queued") continue;
      this.active.add(runId);
      void this.start(run, prompt);
    }
  }

  private async start(run: SubagentRun, prompt: string): Promise<void> {
    try {
      this.transition(run.id, "starting");
      this.sessions.createSubagentSession({
        sessionId: run.childSessionId,
        parentSessionId: run.parentSessionId,
        title: `Subagent: ${run.taskPreview}`,
      });
      if (this.cancelling.has(run.id)) {
        this.finish(run.id, "cancelled");
        return;
      }
      const response = await this.sessions.sendSubagentPrompt(run.id, run.childSessionId, prompt);
      if (!response.success) {
        this.finish(run.id, "failed", response.error ?? "Pi rejected the child prompt");
        return;
      }
      this.transition(run.id, "running");
    } catch (error) {
      this.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.prompts.delete(run.id);
    }
  }

  private readonly onEvent = (event: AnvilEvent): void => {
    if (!event.sessionId) return;
    const run = this.database.subagents.getByChildSessionId(event.sessionId);
    if (!run || TERMINAL.has(run.status)) return;
    if (event.type === "interaction.requested") {
      this.transition(run.id, "needs_attention");
      return;
    }
    if (event.type === "interaction.resolved" && run.status === "needs_attention") {
      this.transition(run.id, "running");
      return;
    }
    if (event.type !== "run.status") return;
    if (event.payload.status === "running") {
      this.transition(run.id, "running");
      return;
    }
    if (!event.payload.outcome) return;
    if (this.cancelling.has(run.id) || event.payload.outcome === "cancelled") {
      this.finish(run.id, "cancelled");
    } else if (event.payload.outcome === "failed") {
      this.finish(run.id, "failed", event.payload.message ?? "Child Pi run failed");
    } else {
      this.finish(run.id, "completed");
    }
  };

  private transition(runId: string, status: "starting" | "running" | "needs_attention"): SubagentRun | undefined {
    const updated = this.database.subagents.updateStatus(runId, status, new Date().toISOString());
    if (!updated) return undefined;
    this.events.acceptSubagentEvents(updated.events);
    return updated.run;
  }

  private finish(
    runId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    error?: string,
  ): SubagentRun | undefined {
    const previous = this.database.subagents.get(runId);
    if (!previous || TERMINAL.has(previous.status)) return previous;
    const resultPreview = this.resultPreview(previous.childSessionId);
    const updated = this.database.subagents.updateStatus(runId, status, new Date().toISOString(), {
      ...(resultPreview ? { resultPreview } : {}),
      ...(error ? { error: boundedUtf8(error, SUBAGENT_RESULT_PREVIEW_MAX_BYTES) } : {}),
      notify: !this.suppressNotification.has(runId),
    });
    if (!updated) return this.database.subagents.get(runId);
    this.events.acceptSubagentEvents(updated.events);
    this.active.delete(runId);
    this.cancelling.delete(runId);
    this.prompts.delete(runId);
    this.removeQueued(runId);
    this.scheduleDelivery();
    setImmediate(() => this.pump());
    return updated.run;
  }

  private resultPreview(childSessionId: string): string | undefined {
    const messages = this.events.timelineForSession(childSessionId)
      .filter((entry) => entry.kind === "message" && entry.role === "assistant");
    const message = messages.at(-1);
    if (!message || message.kind !== "message") return undefined;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n")
      .trim();
    return text ? boundedUtf8(text, SUBAGENT_RESULT_PREVIEW_MAX_BYTES) : undefined;
  }

  private scheduleRetentionCleanup(childSessionIds: readonly string[]): void {
    for (const childSessionId of childSessionIds) this.pendingRetentionCleanup.add(childSessionId);
    if (this.pendingRetentionCleanup.size === 0 || this.retentionCleanupScheduled) return;
    this.retentionCleanupScheduled = true;
    const drain = async (): Promise<void> => {
      try {
        while (this.pendingRetentionCleanup.size > 0) {
          const childSessionId = this.pendingRetentionCleanup.values().next().value as string;
          this.pendingRetentionCleanup.delete(childSessionId);
          try {
            // Only terminal run rows are pruned. Deleting through SessionManager
            // stops any residual runtime and removes its timeline, artifacts, and files.
            await this.sessions.deleteSubagentSession(childSessionId);
          } catch (error) {
            process.stderr.write(
              `[subagent:${childSessionId}] Retention cleanup failed; ownership remains durable and cleanup will retry on the next launch or restart: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
      } finally {
        this.retentionCleanupScheduled = false;
      }
    };
    this.retentionCleanupTail = this.retentionCleanupTail.then(drain, drain);
  }

  private scheduleDelivery(): void {
    this.deliveryTail = this.deliveryTail.then(() => this.deliverPending(), () => this.deliverPending());
  }

  private async deliverPending(): Promise<void> {
    if (this.stopped) return;
    while (true) {
      const item = this.database.subagents.claimDelivery();
      if (!item) return;
      const run = this.database.subagents.get(item.runId);
      if (!run) continue;
      let status: "delivered" | "uncertain" = "delivered";
      let error: string | undefined;
      const deliveredContent = subagentCompletionContent(run, item.remainingRichBytes);
      try {
        const response = await this.sessions.deliverSubagentCompletion(
          item.deliveryId,
          item.parentSessionId,
          deliveredContent,
        );
        if (!response.success) {
          // Stable Forge command ids prevent an automatic replay after an
          // unknown acceptance outcome. Surface that ambiguity durably.
          status = "uncertain";
          error = response.error ?? "Parent follow-up acceptance is unknown";
        }
      } catch (cause) {
        status = "uncertain";
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const updated = this.database.subagents.finishDelivery(
        item.deliveryId,
        status,
        new Date().toISOString(),
        item.remainingRichBytes > 0 ? Buffer.byteLength(deliveredContent) : 0,
        error,
      );
      if (updated) this.events.acceptSubagentEvents(updated.events);
    }
  }

  private removeQueued(runId: string): void {
    let index: number;
    while ((index = this.queued.indexOf(runId)) >= 0) this.queued.splice(index, 1);
  }
}
