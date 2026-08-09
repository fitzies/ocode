import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import {
  SUBAGENT_COMPLETION_MAX_BYTES,
  SUBAGENT_IDENTIFIER_MAX_BYTES,
  SUBAGENT_RESULT_PREVIEW_MAX_BYTES,
  SUBAGENT_SPAWN_PROMPT_MAX_BYTES,
  SUBAGENT_TASK_PREVIEW_MAX_BYTES,
  type AnvilEvent,
  type SubagentRole,
  type SubagentRun,
  type SubagentRunStatus,
} from "@anvil/protocol";
import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";

export const MAX_SUBAGENT_RUNS_PER_PARENT = 4;
export const MAX_SUBAGENT_RUNS_GLOBAL = 16;
export const RETAINED_TERMINAL_RUNS_PER_PARENT = 50;
export const RETAINED_TERMINAL_RUNS_GLOBAL = 500;
export const SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES = 32 * 1024;

export interface SubagentAdmission {
  run: SubagentRun;
  created: boolean;
  events: AnvilEvent[];
  prunedChildSessionIds: string[];
}

export interface SubagentOutboxRecord {
  deliveryId: string;
  runId: string;
  parentSessionId: string;
  childSessionId: string;
  status: "pending" | "delivering";
  attempts: number;
  remainingRichBytes: number;
}

const TERMINAL_SQL = "'completed', 'failed', 'cancelled', 'interrupted'";

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  while (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** Owns durable subagent lifecycle, admission, retention, and completion outbox state. */
export class SubagentStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly insertEvents: (events: readonly UnsequencedAnvilEvent[]) => AnvilEvent[],
  ) {}

  admit(input: {
    parentSessionId: string;
    parentToolCallId: string;
    childSessionId: string;
    role: SubagentRole;
    task?: string;
    taskPreview: string;
    timestamp: string;
  }): SubagentAdmission {
    if (!input.parentToolCallId || Buffer.byteLength(input.parentToolCallId) > SUBAGENT_IDENTIFIER_MAX_BYTES) {
      throw new Error("Subagent tool call id is invalid or too large");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT id FROM subagent_runs WHERE parent_session_id = ? AND parent_tool_call_id = ?
      `).get(input.parentSessionId, input.parentToolCallId) as { id?: unknown } | undefined;
      if (existing?.id) {
        const run = this.get(String(existing.id));
        if (!run) throw new Error("Subagent launch disappeared during admission");
        this.database.exec("COMMIT");
        return { run, created: false, events: [], prunedChildSessionIds: [] };
      }
      const parent = this.database.prepare("SELECT internal FROM sessions WHERE id = ?")
        .get(input.parentSessionId) as { internal?: unknown } | undefined;
      if (!parent) throw new Error("Parent session not found");
      if (Boolean(parent.internal)) throw new Error("Subagents cannot launch other subagents");

      const parentCount = Number((this.database.prepare(`
        SELECT COUNT(*) AS count FROM subagent_runs
        WHERE parent_session_id = ? AND status NOT IN (${TERMINAL_SQL})
      `).get(input.parentSessionId) as { count: number }).count);
      if (parentCount >= MAX_SUBAGENT_RUNS_PER_PARENT) {
        throw new Error(`A parent may have at most ${MAX_SUBAGENT_RUNS_PER_PARENT} queued or active subagents`);
      }
      const globalCount = Number((this.database.prepare(`
        SELECT COUNT(*) AS count FROM subagent_runs WHERE status NOT IN (${TERMINAL_SQL})
      `).get() as { count: number }).count);
      if (globalCount >= MAX_SUBAGENT_RUNS_GLOBAL) {
        throw new Error(`Forge may have at most ${MAX_SUBAGENT_RUNS_GLOBAL} queued or active subagents`);
      }

      const pruned = this.pruneTerminalRows(input.parentSessionId);
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO subagent_runs (
          id, parent_session_id, parent_tool_call_id, child_session_id, role, status,
          task_preview, task, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(id, input.parentSessionId, input.parentToolCallId, input.childSessionId, input.role,
        boundedUtf8(input.taskPreview, SUBAGENT_TASK_PREVIEW_MAX_BYTES),
        boundedUtf8(input.task ?? input.taskPreview, SUBAGENT_SPAWN_PROMPT_MAX_BYTES),
        input.timestamp, input.timestamp);
      const run = this.get(id);
      if (!run) throw new Error("Subagent admission was not persisted");
      const events = this.insertEvents([
        ...pruned.map((item) => ({
          sessionId: item.parentSessionId,
          timestamp: input.timestamp,
          type: "subagent.deleted" as const,
          payload: { runId: item.id, parentSessionId: item.parentSessionId },
        })),
        { sessionId: input.parentSessionId, timestamp: input.timestamp, type: "subagent.updated", payload: { run } },
      ]);
      this.database.exec("COMMIT");
      return {
        run,
        created: true,
        events,
        prunedChildSessionIds: pruned.map((item) => item.childSessionId),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): SubagentRun | undefined {
    const row = this.database.prepare(`${this.selectRunSql()} WHERE r.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  resumeMetadata(id: string): { childSessionId: string; role: SubagentRole; task: string } | undefined {
    const row = this.database.prepare("SELECT child_session_id, role, task FROM subagent_runs WHERE id = ?")
      .get(id) as { child_session_id: unknown; role: unknown; task: unknown } | undefined;
    return row ? { childSessionId: String(row.child_session_id), role: String(row.role) as SubagentRole, task: String(row.task) } : undefined;
  }

  getByChildSessionId(childSessionId: string): SubagentRun | undefined {
    const row = this.database.prepare(`${this.selectRunSql()} WHERE r.child_session_id = ?`)
      .get(childSessionId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(parentSessionId?: string): SubagentRun[] {
    const rows = (parentSessionId
      ? this.database.prepare(`${this.selectRunSql()} WHERE r.parent_session_id = ? ORDER BY r.created_at ASC`).all(parentSessionId)
      : this.database.prepare(`${this.selectRunSql()} ORDER BY r.created_at ASC`).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.fromRow(row));
  }

  updateStatus(
    id: string,
    status: SubagentRunStatus,
    timestamp: string,
    input: { resultPreview?: string; error?: string; notify?: boolean } = {},
  ): { run: SubagentRun; events: AnvilEvent[] } | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.get(id);
      if (!previous) throw new Error("Subagent run not found");
      if (["completed", "failed", "cancelled", "interrupted"].includes(previous.status)) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(status);
      this.database.prepare(`
        UPDATE subagent_runs SET status = ?, updated_at = ?,
          started_at = CASE WHEN ? IN ('starting', 'running', 'needs_attention') THEN COALESCE(started_at, ?) ELSE started_at END,
          ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
          result_preview = COALESCE(?, result_preview), error = COALESCE(?, error)
        WHERE id = ?
      `).run(status, timestamp, status, timestamp, terminal ? 1 : 0, timestamp,
        input.resultPreview === undefined ? null : boundedUtf8(input.resultPreview, SUBAGENT_RESULT_PREVIEW_MAX_BYTES),
        input.error === undefined ? null : boundedUtf8(input.error, SUBAGENT_RESULT_PREVIEW_MAX_BYTES), id);
      if (terminal && input.notify !== false) {
        this.database.prepare(`
          INSERT INTO subagent_outbox (delivery_id, run_id, status, attempts, delivery_bytes, updated_at)
          VALUES (?, ?, 'pending', 0, 0, ?)
          ON CONFLICT(run_id) DO NOTHING
        `).run(`subagent-completion:${id}`, id, timestamp);
      }
      const run = this.get(id);
      if (!run) throw new Error("Subagent run disappeared during transition");
      const events = this.insertEvents([{
        sessionId: run.parentSessionId, timestamp, type: "subagent.updated", payload: { run },
      }]);
      this.database.exec("COMMIT");
      return { run, events };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  delete(id: string, timestamp: string): AnvilEvent[] {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.get(id);
      if (!run) {
        this.database.exec("COMMIT");
        return [];
      }
      this.database.prepare("DELETE FROM subagent_runs WHERE id = ?").run(id);
      const events = this.insertEvents([{
        sessionId: run.parentSessionId,
        timestamp,
        type: "subagent.deleted",
        payload: { runId: run.id, parentSessionId: run.parentSessionId },
      }]);
      this.database.exec("COMMIT");
      return events;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  resetDeliveriesAfterRestart(timestamp: string): AnvilEvent[] {
    // A delivering command has an unknown acceptance outcome after restart. Never
    // replay it: this is the same at-most-once side-effect contract as commands.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`
        SELECT o.run_id, r.parent_session_id,
          CASE WHEN o.delivery_bytes > 0 THEN o.delivery_bytes
            ELSE MIN(?, MAX(0, ? - COALESCE(usage.rich_delivery_bytes, 0))) END AS reserved_bytes
        FROM subagent_outbox o
        JOIN subagent_runs r ON r.id = o.run_id
        LEFT JOIN subagent_parent_usage usage ON usage.parent_session_id = r.parent_session_id
        WHERE o.status = 'delivering'
      `).all(SUBAGENT_COMPLETION_MAX_BYTES, SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES) as Array<{
        run_id: unknown; parent_session_id: unknown; reserved_bytes: unknown;
      }>;
      const account = this.database.prepare(`
        INSERT INTO subagent_parent_usage (parent_session_id, rich_delivery_bytes)
        VALUES (?, ?)
        ON CONFLICT(parent_session_id) DO UPDATE SET
          rich_delivery_bytes = MIN(?, subagent_parent_usage.rich_delivery_bytes + excluded.rich_delivery_bytes)
      `);
      for (const row of rows) {
        account.run(String(row.parent_session_id), Number(row.reserved_bytes), SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES);
      }
      this.database.prepare(`
        UPDATE subagent_outbox SET status = 'uncertain', updated_at = ?,
          last_error = COALESCE(last_error, 'Delivery interrupted by Forge restart; not replayed')
        WHERE status = 'delivering'
      `).run(timestamp);
      const events = this.insertEvents(rows.flatMap((row) => {
        const run = this.get(String(row.run_id));
        return run ? [{
          sessionId: run.parentSessionId,
          timestamp,
          type: "subagent.updated" as const,
          payload: { run },
        }] : [];
      }));
      this.database.exec("COMMIT");
      return events;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimDelivery(): SubagentOutboxRecord | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT o.delivery_id, o.run_id, o.attempts, r.parent_session_id, r.child_session_id,
          COALESCE(usage.rich_delivery_bytes, 0) AS spent_bytes
        FROM subagent_outbox o
        JOIN subagent_runs r ON r.id = o.run_id
        LEFT JOIN subagent_parent_usage usage ON usage.parent_session_id = r.parent_session_id
        WHERE o.status = 'pending' AND NOT EXISTS (
          SELECT 1 FROM subagent_outbox active
          JOIN subagent_runs active_run ON active_run.id = active.run_id
          WHERE active.status = 'delivering' AND active_run.parent_session_id = r.parent_session_id
        )
        ORDER BY o.updated_at ASC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const reservedBytes = Math.min(
        SUBAGENT_COMPLETION_MAX_BYTES,
        Math.max(0, SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES - Number(row.spent_bytes)),
      );
      const changed = this.database.prepare(`
        UPDATE subagent_outbox SET status = 'delivering', attempts = attempts + 1,
          delivery_bytes = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'pending'
      `).run(reservedBytes, new Date().toISOString(), String(row.delivery_id));
      if (Number(changed.changes) !== 1) throw new Error("Subagent delivery claim raced");
      this.database.exec("COMMIT");
      return {
        deliveryId: String(row.delivery_id), runId: String(row.run_id),
        parentSessionId: String(row.parent_session_id), childSessionId: String(row.child_session_id),
        status: "delivering", attempts: Number(row.attempts) + 1,
        remainingRichBytes: Math.max(0, SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES - Number(row.spent_bytes)),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishDelivery(
    deliveryId: string,
    status: "delivered" | "uncertain",
    timestamp: string,
    deliveryBytes: number,
    error?: string,
  ): { run: SubagentRun; events: AnvilEvent[] } | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT o.run_id, r.parent_session_id FROM subagent_outbox o
        JOIN subagent_runs r ON r.id = o.run_id
        WHERE o.delivery_id = ? AND o.status = 'delivering'
      `).get(deliveryId) as { run_id: unknown; parent_session_id: unknown } | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const accountedBytes = Math.min(
        SUBAGENT_COMPLETION_MAX_BYTES,
        Math.max(0, Number.isSafeInteger(deliveryBytes) ? deliveryBytes : 0),
      );
      const changed = this.database.prepare(`
        UPDATE subagent_outbox SET status = ?, updated_at = ?, delivery_bytes = ?, last_error = ?
        WHERE delivery_id = ? AND status = 'delivering'
      `).run(status, timestamp, accountedBytes,
        error === undefined ? null : boundedUtf8(error, SUBAGENT_RESULT_PREVIEW_MAX_BYTES), deliveryId);
      if (Number(changed.changes) !== 1) throw new Error("Subagent delivery completion raced");
      this.database.prepare(`
        INSERT INTO subagent_parent_usage (parent_session_id, rich_delivery_bytes)
        VALUES (?, ?)
        ON CONFLICT(parent_session_id) DO UPDATE SET
          rich_delivery_bytes = MIN(?, subagent_parent_usage.rich_delivery_bytes + excluded.rich_delivery_bytes)
      `).run(String(row.parent_session_id), accountedBytes, SUBAGENT_PARENT_COMPLETION_BUDGET_BYTES);
      const run = this.get(String(row.run_id));
      if (!run) throw new Error("Subagent outbox run not found");
      const events = this.insertEvents([{
        sessionId: run.parentSessionId, timestamp, type: "subagent.updated", payload: { run },
      }]);
      this.database.exec("COMMIT");
      return { run, events };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private pruneTerminalRows(parentSessionId: string): Array<{
    id: string;
    parentSessionId: string;
    childSessionId: string;
  }> {
    const candidates = this.database.prepare(`
      SELECT id, parent_session_id, child_session_id FROM subagent_runs WHERE status IN (${TERMINAL_SQL}) AND (
        id IN (SELECT id FROM subagent_runs WHERE parent_session_id = ? AND status IN (${TERMINAL_SQL})
          ORDER BY ended_at DESC, created_at DESC LIMIT -1 OFFSET ?)
        OR id IN (SELECT id FROM subagent_runs WHERE status IN (${TERMINAL_SQL})
          ORDER BY ended_at DESC, created_at DESC LIMIT -1 OFFSET ?)
      )
    `).all(
      parentSessionId,
      RETAINED_TERMINAL_RUNS_PER_PARENT - 1,
      RETAINED_TERMINAL_RUNS_GLOBAL - 1,
    ) as Array<{
      id: unknown; parent_session_id: unknown; child_session_id: unknown;
    }>;
    const remove = this.database.prepare("DELETE FROM subagent_runs WHERE id = ?");
    for (const row of candidates) remove.run(String(row.id));
    return candidates.map((row) => ({
      id: String(row.id),
      parentSessionId: String(row.parent_session_id),
      childSessionId: String(row.child_session_id),
    }));
  }

  private selectRunSql(): string {
    return `SELECT r.*, o.delivery_id, o.status AS notification_status, o.updated_at AS notification_updated_at,
      o.last_error AS notification_error FROM subagent_runs r LEFT JOIN subagent_outbox o ON o.run_id = r.id`;
  }

  private fromRow(row: Record<string, unknown>): SubagentRun {
    return {
      id: String(row.id), parentSessionId: String(row.parent_session_id),
      parentToolCallId: String(row.parent_tool_call_id), childSessionId: String(row.child_session_id),
      role: String(row.role) as SubagentRole, status: String(row.status) as SubagentRunStatus,
      taskPreview: String(row.task_preview),
      ...(row.result_preview == null ? {} : { resultPreview: String(row.result_preview) }),
      ...(row.error == null ? {} : { error: String(row.error) }),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(row.started_at == null ? {} : { startedAt: String(row.started_at) }),
      ...(row.ended_at == null ? {} : { endedAt: String(row.ended_at) }),
      ...(row.delivery_id == null ? {} : { notification: {
        id: String(row.delivery_id), status: String(row.notification_status) as NonNullable<SubagentRun["notification"]>["status"],
        updatedAt: String(row.notification_updated_at),
        ...(row.notification_error == null ? {} : { error: String(row.notification_error) }),
      } }),
    };
  }
}
