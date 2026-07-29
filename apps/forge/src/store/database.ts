import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import {
  ANVIL_PROTOCOL_VERSION,
  isAnvilEvent,
  isAnvilSnapshot,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type AnvilSnapshot,
  type InteractionRequest,
  type ProjectSummary,
  type SessionSummary,
  type ShellTerminalMetadata,
} from "@anvil/protocol";

// Keep the specifier indirect until tsup's esbuild recognizes node:sqlite as a built-in.
const sqliteModuleName = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as typeof import("node:sqlite");

const SCHEMA_VERSION = 10;
const RETAINED_EVENT_COUNT = 100_000;
const MAX_COMPACTION_ROWS_PER_CHECKPOINT = 1_000;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected persisted JSON text");
  return JSON.parse(value);
}

function upgradeStoredResourceBlocks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(upgradeStoredResourceBlocks);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const upgraded = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(record.type === "projectResource" && key === "projectId"))
    .map(([key, child]) => [key, upgradeStoredResourceBlocks(child)]));
  const isSessionSummary = typeof record.id === "string" &&
    typeof record.projectId === "string" &&
    typeof record.title === "string" &&
    typeof record.modelId === "string" &&
    typeof record.thinkingLevel === "string";
  if (isSessionSummary && record.readThroughSequence === undefined) {
    const terminalSequence = Number(record.lastTerminalSequence ?? 0);
    upgraded.readThroughSequence = Number.isSafeInteger(terminalSequence) && terminalSequence >= 0
      ? terminalSequence
      : 0;
  }
  return upgraded;
}

function upgradeStoredSnapshotProtocol(value: unknown): unknown {
  if (
    Number(ANVIL_PROTOCOL_VERSION) === 9 &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [5, 6, 7, 8].includes(Number((value as { protocolVersion?: unknown }).protocolVersion))
  ) {
    // Protocols 7–9 add strict session-relative project resources, Forge-owned
    // read cursors, and root-owned project creation. Snapshots upgrade structurally.
    return upgradeStoredResourceBlocks({
      ...(value as Record<string, unknown>),
      protocolVersion: ANVIL_PROTOCOL_VERSION,
    });
  }
  return value;
}

export interface StoredSnapshot {
  snapshot: AnvilSnapshot;
  cursor: number;
}

export interface RuntimeSessionRecord {
  session: SessionSummary;
  piSessionId?: string;
  piSessionFile?: string;
}

export interface StoredTerminalRecord {
  metadata: ShellTerminalMetadata;
  historyFile: string;
  historyVersion: number;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  mediaType: string;
  byteLength: number;
  name?: string;
  purpose: "output" | "upload" | "input";
  createdAt: string;
}

export class ForgeDatabase {
  private readonly database: DatabaseSyncInstance;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.migrate();
    this.database.prepare("UPDATE commands SET status = 'unknown' WHERE status = 'pending'").run();
  }

  close(): void {
    this.database.close();
  }

  syncProjects(projects: readonly ProjectSummary[]): void {
    const upsert = this.database.prepare(`
      INSERT INTO projects (id, name, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        updated_at = excluded.updated_at
    `);
    const timestamp = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const project of projects) {
        upsert.run(project.id, project.name, project.path, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listProjects(): ProjectSummary[] {
    const rows = this.database.prepare(`
      SELECT id, name, path FROM projects ORDER BY created_at ASC, name ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
    }));
  }

  createProjectWithEvent(
    project: ProjectSummary,
    event: UnsequencedAnvilEvent,
  ): AnvilEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO projects (id, name, path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, project.name, project.path, timestamp, timestamp);
      const [committed] = this.insertEvents([event]);
      if (!committed) throw new Error("Project creation did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(session: SessionSummary): void {
    this.insertSession(session);
  }

  createSessionWithEvent(
    session: SessionSummary,
    event: UnsequencedAnvilEvent,
  ): AnvilEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertSession(session);
      const [committed] = this.insertEvents([event]);
      if (!committed) throw new Error("Session creation did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renameSessionWithEvent(
    sessionId: string,
    title: string,
    event: UnsequencedAnvilEvent,
  ): AnvilEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
        title,
        event.timestamp,
        sessionId,
      );
      if (Number(updated.changes) !== 1) throw new Error("Session not found");
      const [committed] = this.insertEvents([event]);
      if (!committed) throw new Error("Session rename did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setSessionSettledWithEvent(
    sessionId: string,
    settled: boolean,
    event: UnsequencedAnvilEvent,
  ): AnvilEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database.prepare("UPDATE sessions SET settled = ? WHERE id = ?").run(
        settled ? 1 : 0,
        sessionId,
      );
      if (Number(updated.changes) !== 1) throw new Error("Session not found");
      const [committed] = this.insertEvents([event]);
      if (!committed) throw new Error("Session settlement did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markSessionReadWithEvent(
    sessionId: string,
    throughSequence: number,
    timestamp: string,
  ): AnvilEvent | undefined {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("Invalid read-through sequence");
    }
    return this.setSessionReadStateWithEvent(sessionId, "read", throughSequence, timestamp);
  }

  markSessionUnreadWithEvent(sessionId: string, timestamp: string): AnvilEvent | undefined {
    return this.setSessionReadStateWithEvent(sessionId, "unread", 0, timestamp);
  }

  updateSession(session: SessionSummary, piState?: { sessionId?: string; sessionFile?: string }): void {
    this.database.prepare(`
      UPDATE sessions SET
        pi_session_id = COALESCE(?, pi_session_id),
        pi_session_file = COALESCE(?, pi_session_file),
        title = ?, model_id = ?, thinking_level = ?, status = ?, settled = ?, branch = ?, updated_at = ?,
        last_user_message_at = ?, last_user_message_sequence = ?, last_activity_sequence = ?, last_terminal_sequence = ?, last_terminal_outcome = ?
      WHERE id = ?
    `).run(
      piState?.sessionId ?? null,
      piState?.sessionFile ?? null,
      session.title,
      session.modelId,
      session.thinkingLevel,
      session.status,
      session.settled ? 1 : 0,
      session.branch ?? null,
      session.updatedAt,
      session.lastUserMessageAt ?? null,
      session.lastUserMessageSequence ?? null,
      session.lastActivitySequence ?? 0,
      session.lastTerminalSequence ?? null,
      session.lastTerminalOutcome ?? null,
      session.id,
    );
  }

  deleteSessionWithEvent(sessionId: string, event: UnsequencedAnvilEvent): AnvilEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM pending_interactions WHERE session_id = ?").run(sessionId);
      this.database.prepare("DELETE FROM commands WHERE session_id = ?").run(sessionId);
      this.database.prepare(`
        UPDATE events
        SET type = 'unknown', payload_json = ?, raw_json = NULL
        WHERE session_id = ?
      `).run(JSON.stringify({ eventType: "session.redacted", payload: null }), sessionId);
      const deleted = this.database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      if (Number(deleted.changes) !== 1) throw new Error("Session not found");
      const [committed] = this.insertEvents([event]);
      if (!committed) throw new Error("Session deletion did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSession(id: string): RuntimeSessionRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, project_id, title, model_id, thinking_level, status, settled, branch, updated_at,
             last_user_message_at, last_user_message_sequence, last_activity_sequence, last_terminal_sequence, last_terminal_outcome,
             read_through_sequence, pi_session_id, pi_session_file
      FROM sessions WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      session: {
        id: String(row.id),
        projectId: String(row.project_id),
        title: String(row.title),
        modelId: String(row.model_id),
        thinkingLevel: String(row.thinking_level) as SessionSummary["thinkingLevel"],
        status: String(row.status) as SessionSummary["status"],
        settled: Boolean(row.settled),
        ...(typeof row.branch === "string" ? { branch: row.branch } : {}),
        updatedAt: String(row.updated_at),
        ...(row.last_user_message_at === null ? {} : { lastUserMessageAt: String(row.last_user_message_at) }),
        ...(row.last_user_message_sequence === null ? {} : { lastUserMessageSequence: Number(row.last_user_message_sequence) }),
        lastActivitySequence: Number(row.last_activity_sequence ?? 0),
        ...(row.last_terminal_sequence === null ? {} : { lastTerminalSequence: Number(row.last_terminal_sequence) }),
        ...(row.last_terminal_outcome === null ? {} : { lastTerminalOutcome: String(row.last_terminal_outcome) as NonNullable<SessionSummary["lastTerminalOutcome"]> }),
        readThroughSequence: Number(row.read_through_sequence ?? 0),
      },
      piSessionId: typeof row.pi_session_id === "string" ? row.pi_session_id : undefined,
      piSessionFile: typeof row.pi_session_file === "string" ? row.pi_session_file : undefined,
    };
  }

  listTerminalRecords(projectId?: string): StoredTerminalRecord[] {
    const rows = (projectId
      ? this.database.prepare(`
          SELECT project_id, terminal_id, label, status, created_at, updated_at, sequence,
                 rows, cols, pid, exit_code, exit_signal, history_file, history_version
          FROM terminal_records WHERE project_id = ? ORDER BY created_at ASC
        `).all(projectId)
      : this.database.prepare(`
          SELECT project_id, terminal_id, label, status, created_at, updated_at, sequence,
                 rows, cols, pid, exit_code, exit_signal, history_file, history_version
          FROM terminal_records ORDER BY project_id ASC, created_at ASC
        `).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      metadata: {
        projectId: String(row.project_id),
        terminalId: String(row.terminal_id),
        label: String(row.label),
        status: String(row.status) as ShellTerminalMetadata["status"],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        sequence: Number(row.sequence),
        rows: Number(row.rows),
        cols: Number(row.cols),
        ...(row.pid === null ? {} : { pid: Number(row.pid) }),
        ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
        ...(row.exit_signal === null ? {} : { exitSignal: Number(row.exit_signal) }),
      },
      historyFile: String(row.history_file),
      historyVersion: Number(row.history_version),
    }));
  }

  upsertTerminalRecord(record: StoredTerminalRecord): void {
    const terminal = record.metadata;
    this.database.prepare(`
      INSERT INTO terminal_records (
        project_id, terminal_id, label, status, created_at, updated_at, sequence,
        rows, cols, pid, exit_code, exit_signal, history_file, history_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, terminal_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        updated_at = excluded.updated_at,
        sequence = excluded.sequence,
        rows = excluded.rows,
        cols = excluded.cols,
        pid = excluded.pid,
        exit_code = excluded.exit_code,
        exit_signal = excluded.exit_signal,
        history_file = excluded.history_file,
        history_version = excluded.history_version
    `).run(
      terminal.projectId, terminal.terminalId, terminal.label, terminal.status,
      terminal.createdAt, terminal.updatedAt, terminal.sequence, terminal.rows, terminal.cols,
      terminal.pid ?? null, terminal.exitCode ?? null, terminal.exitSignal ?? null,
      record.historyFile, record.historyVersion,
    );
  }

  markRunningTerminalsInterrupted(timestamp = new Date().toISOString()): void {
    this.database.prepare(`
      UPDATE terminal_records
      SET status = 'interrupted', updated_at = ?, pid = NULL, exit_code = NULL, exit_signal = NULL
      WHERE status = 'running'
    `).run(timestamp);
  }

  deleteTerminalRecord(projectId: string, terminalId: string): boolean {
    return Number(this.database.prepare(`
      DELETE FROM terminal_records WHERE project_id = ? AND terminal_id = ?
    `).run(projectId, terminalId).changes) > 0;
  }

  beginCommand(command: AnvilClientCommand): "started" | "pending" | "unknown" | AnvilCommandResponse {
    const existing = this.database.prepare("SELECT status, response_json FROM commands WHERE id = ?").get(command.id) as Record<string, unknown> | undefined;
    if (existing) {
      if (typeof existing.response_json === "string") return parseJson(existing.response_json) as AnvilCommandResponse;
      return existing.status === "pending" ? "pending" : "unknown";
    }
    this.database.prepare(`
      INSERT INTO commands (id, session_id, type, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(command.id, command.sessionId, command.type, command.timestamp);
    return "started";
  }

  completeCommand(response: AnvilCommandResponse): void {
    this.database.prepare(`
      UPDATE commands SET status = ?, completed_at = ?, response_json = ? WHERE id = ?
    `).run(
      response.outcome === "unknown" ? "unknown" : "completed",
      response.timestamp,
      JSON.stringify(response),
      response.commandId,
    );
  }

  appendEvents(
    events: readonly UnsequencedAnvilEvent[],
    artifacts: readonly ArtifactRecord[] = [],
  ): AnvilEvent[] {
    if (events.length === 0 && artifacts.length === 0) return [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insertArtifact = this.database.prepare(`
        INSERT INTO artifacts (id, session_id, media_type, byte_length, name, purpose, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifacts) {
        insertArtifact.run(
          artifact.id,
          artifact.sessionId,
          artifact.mediaType,
          artifact.byteLength,
          artifact.name ?? null,
          artifact.purpose,
          artifact.createdAt,
        );
      }
      const committed = this.insertEvents(events);
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, session_id, media_type, byte_length, name, purpose, created_at
      FROM artifacts WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      mediaType: String(row.media_type),
      byteLength: Number(row.byte_length),
      ...(row.name === null ? {} : { name: String(row.name) }),
      purpose: String(row.purpose) as ArtifactRecord["purpose"],
      createdAt: String(row.created_at),
    };
  }

  listArtifactIds(): string[] {
    return (this.database.prepare("SELECT id FROM artifacts").all() as Array<Record<string, unknown>>)
      .map((row) => String(row.id));
  }

  listArtifacts(): ArtifactRecord[] {
    const rows = this.database.prepare(`
      SELECT id, session_id, media_type, byte_length, name, purpose, created_at
      FROM artifacts ORDER BY created_at ASC, id ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      mediaType: String(row.media_type),
      byteLength: Number(row.byte_length),
      ...(row.name === null ? {} : { name: String(row.name) }),
      purpose: String(row.purpose) as ArtifactRecord["purpose"],
      createdAt: String(row.created_at),
    }));
  }

  consumeUploadedArtifacts(sessionId: string, ids: readonly string[]): void {
    const consume = this.database.prepare(`
      UPDATE artifacts SET purpose = 'input'
      WHERE id = ? AND session_id = ? AND purpose = 'upload'
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) consume.run(id, sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteUploadedArtifact(sessionId: string, id: string): boolean {
    return Number(this.database.prepare(`
      DELETE FROM artifacts WHERE id = ? AND session_id = ? AND purpose = 'upload'
    `).run(id, sessionId).changes) > 0;
  }

  deleteStaleUploads(before: string): string[] {
    const ids = (this.database.prepare(`
      SELECT id FROM artifacts WHERE purpose = 'upload' AND created_at < ?
    `).all(before) as Array<Record<string, unknown>>).map((row) => String(row.id));
    if (ids.length > 0) {
      this.database.prepare(`DELETE FROM artifacts WHERE purpose = 'upload' AND created_at < ?`).run(before);
    }
    return ids;
  }

  artifactIdsForSession(sessionId: string): string[] {
    return (this.database.prepare("SELECT id FROM artifacts WHERE session_id = ?").all(sessionId) as Array<Record<string, unknown>>)
      .map((row) => String(row.id));
  }

  readEventsAfter(sequence: number, limit = 1_000): AnvilEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid event cursor");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new Error("Invalid event limit");
    const rows = this.database.prepare(`
      SELECT sequence, id, session_id, timestamp, type, payload_json, raw_json
      FROM events
      WHERE sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(sequence, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.eventFromRow(row));
  }

  readSessionEventsAfter(
    sessionId: string,
    sequence: number,
    throughSequence: number,
    limit = 10_000,
  ): AnvilEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid event cursor");
    if (!Number.isSafeInteger(throughSequence) || throughSequence < sequence) throw new Error("Invalid detail cursor");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new Error("Invalid event limit");
    const rows = this.database.prepare(`
      SELECT sequence, id, session_id, timestamp, type, payload_json, raw_json
      FROM events
      WHERE session_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(sessionId, sequence, throughSequence, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.eventFromRow(row));
  }

  commandOutcome(commandId: string): AnvilCommandResponse | "pending" | "unknown" | undefined {
    const row = this.database.prepare(
      "SELECT status, response_json FROM commands WHERE id = ?",
    ).get(commandId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (typeof row.response_json === "string") return parseJson(row.response_json) as AnvilCommandResponse;
    return row.status === "pending" ? "pending" : "unknown";
  }

  listPendingInteractions(): InteractionRequest[] {
    const rows = this.database.prepare(`
      SELECT request_json FROM pending_interactions ORDER BY requested_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => parseJson(row.request_json) as InteractionRequest);
  }

  latestSequence(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as Record<string, unknown>;
    return Number(row.sequence);
  }

  saveSnapshot(
    snapshot: AnvilSnapshot,
    retention: {
      retainedEventCount?: number;
      maxCompactionRows?: number;
      discardPreviousSnapshots?: boolean;
    } = {},
  ): void {
    if (!isAnvilSnapshot(snapshot)) throw new Error("Cannot persist an invalid Anvil snapshot");
    if (snapshot.lastSequence > this.latestSequence()) {
      throw new Error("Snapshot cursor is ahead of the event journal");
    }

    const previousCompactedThrough = this.compactedThrough();
    const retainedEventCount = retention.retainedEventCount ?? RETAINED_EVENT_COUNT;
    const maxCompactionRows = retention.maxCompactionRows ?? MAX_COMPACTION_ROWS_PER_CHECKPOINT;
    const desiredCompactedThrough = Math.max(0, snapshot.lastSequence - retainedEventCount);
    const compactedThrough = Math.min(
      desiredCompactedThrough,
      previousCompactedThrough + maxCompactionRows,
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO snapshots (cursor, captured_at, snapshot_json)
        VALUES (?, ?, ?)
        ON CONFLICT(cursor) DO UPDATE SET
          captured_at = excluded.captured_at,
          snapshot_json = excluded.snapshot_json
      `).run(snapshot.lastSequence, snapshot.capturedAt, JSON.stringify(snapshot));
      if (retention.discardPreviousSnapshots) {
        this.database.prepare("DELETE FROM snapshots WHERE cursor <> ?").run(snapshot.lastSequence);
      } else {
        this.database.prepare(`
          DELETE FROM snapshots
          WHERE cursor NOT IN (SELECT cursor FROM snapshots ORDER BY cursor DESC LIMIT 3)
        `).run();
      }
      if (compactedThrough > previousCompactedThrough) {
        this.database.prepare("DELETE FROM events WHERE sequence <= ?").run(compactedThrough);
        this.database.prepare(`
          INSERT INTO runtime_metadata (key, value)
          VALUES ('compacted_through_sequence', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(compactedThrough));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  runtimeMetadata(key: string): string | undefined {
    const row = this.database.prepare(`
      SELECT value FROM runtime_metadata WHERE key = ?
    `).get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  setRuntimeMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  compactedThrough(): number {
    const value = Number(this.runtimeMetadata("compacted_through_sequence") ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const rows = this.database.prepare(`
      SELECT cursor, snapshot_json
      FROM snapshots
      ORDER BY cursor DESC
      LIMIT 3
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      try {
        const snapshot = upgradeStoredSnapshotProtocol(parseJson(row.snapshot_json));
        if (isAnvilSnapshot(snapshot)) return { snapshot, cursor: Number(row.cursor) };
      } catch {
        // Ignore corrupt or obsolete snapshots and continue toward a full journal replay.
      }
    }
    return undefined;
  }

  private eventFromRow(row: Record<string, unknown>): AnvilEvent {
    const candidate = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      sequence: Number(row.sequence),
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      type: row.type,
      payload: upgradeStoredResourceBlocks(parseJson(row.payload_json)),
      ...(row.raw_json === null ? {} : { raw: parseJson(row.raw_json) }),
    };
    if (!isAnvilEvent(candidate)) {
      throw new Error(`Persisted event ${String(row.sequence)} failed protocol validation`);
    }
    return candidate;
  }

  private setSessionReadStateWithEvent(
    sessionId: string,
    mode: "read" | "unread",
    throughSequence: number,
    timestamp: string,
  ): AnvilEvent | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT last_terminal_sequence, read_through_sequence
        FROM sessions WHERE id = ?
      `).get(sessionId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Session not found");

      const current = Number(row.read_through_sequence ?? 0);
      const terminal = row.last_terminal_sequence === null
        ? undefined
        : Number(row.last_terminal_sequence);
      const next = mode === "read"
        ? Math.max(current, Math.min(throughSequence, terminal ?? 0))
        : terminal === undefined ? current : Math.max(0, terminal - 1);
      if (next === current) {
        this.database.exec("COMMIT");
        return undefined;
      }

      this.database.prepare(`
        UPDATE sessions SET read_through_sequence = ? WHERE id = ?
      `).run(next, sessionId);
      const [committed] = this.insertEvents([{
        sessionId,
        timestamp,
        type: "session.readState",
        payload: { readThroughSequence: next },
      }]);
      if (!committed) throw new Error("Session read-state update did not produce an event");
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSession(session: SessionSummary): void {
    this.database.prepare(`
      INSERT INTO sessions (
        id, project_id, title, model_id, thinking_level, status, settled, branch,
        last_user_message_at, last_user_message_sequence, last_activity_sequence, last_terminal_sequence, last_terminal_outcome,
        read_through_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.projectId,
      session.title,
      session.modelId,
      session.thinkingLevel,
      session.status,
      session.settled ? 1 : 0,
      session.branch ?? null,
      session.lastUserMessageAt ?? null,
      session.lastUserMessageSequence ?? null,
      session.lastActivitySequence ?? 0,
      session.lastTerminalSequence ?? null,
      session.lastTerminalOutcome ?? null,
      session.readThroughSequence ?? 0,
      session.updatedAt,
      session.updatedAt,
    );
  }

  private insertEvents(events: readonly UnsequencedAnvilEvent[]): AnvilEvent[] {
    const insert = this.database.prepare(`
      INSERT INTO events (id, session_id, timestamp, type, payload_json, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const committed: AnvilEvent[] = [];
    for (const event of events) {
      const id = randomUUID();
      const payloadJson = JSON.stringify(event.payload);
      const rawJson = event.raw === undefined ? null : JSON.stringify(event.raw);
      if (typeof payloadJson !== "string" || (event.raw !== undefined && typeof rawJson !== "string")) {
        throw new Error(`Event ${event.type} is not JSON serializable`);
      }
      const result = insert.run(
        id,
        event.sessionId,
        event.timestamp,
        event.type,
        payloadJson,
        rawJson,
      );
      const sequence = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error("SQLite returned an invalid event sequence");
      }
      const candidate = {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id,
        sequence,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        type: event.type,
        payload: parseJson(payloadJson),
        ...(rawJson === null ? {} : { raw: parseJson(rawJson) }),
      };
      if (!isAnvilEvent(candidate)) {
        throw new Error(`Refusing to persist invalid event type ${event.type}`);
      }
      committed.push(candidate);

      if (candidate.type === "interaction.requested") {
        const request = candidate.payload.request;
        const timeoutAt = request.timeoutMs === undefined
          ? null
          : new Date(new Date(request.requestedAt).getTime() + request.timeoutMs).toISOString();
        this.database.prepare(`
          INSERT INTO pending_interactions (id, session_id, requested_at, timeout_at, request_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id,
            requested_at = excluded.requested_at,
            timeout_at = excluded.timeout_at,
            request_json = excluded.request_json
        `).run(request.id, request.sessionId, request.requestedAt, timeoutAt, JSON.stringify(request));
      } else if (candidate.type === "interaction.resolved") {
        this.database.prepare("DELETE FROM pending_interactions WHERE id = ?").run(candidate.payload.requestId);
      }
    }
    return committed;
  }

  private migrate(): void {
    const version = Number((this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Forge database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (version === SCHEMA_VERSION) return;

    if (version === 0) this.database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        pi_session_id TEXT,
        pi_session_file TEXT,
        title TEXT NOT NULL,
        model_id TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        status TEXT NOT NULL,
        recovery_state TEXT NOT NULL DEFAULT 'ready',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS snapshots (
        cursor INTEGER PRIMARY KEY,
        captured_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        requested_at TEXT NOT NULL,
        timeout_at TEXT,
        request_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        response_json TEXT
      );

      PRAGMA user_version = 1;
      COMMIT;
    `);

    if (version < 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN last_activity_sequence INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN last_terminal_sequence INTEGER;
        ALTER TABLE sessions ADD COLUMN last_terminal_outcome TEXT;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }

    if (version < 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          media_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          name TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX artifacts_session_id ON artifacts(session_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }

    if (version < 4) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE artifacts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'output';
        CREATE INDEX artifacts_pending_uploads ON artifacts(purpose, created_at);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }

    if (version < 5) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }

    if (version < 6) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN branch TEXT;
        PRAGMA user_version = 6;
        COMMIT;
      `);
    }

    if (version < 7) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE runtime_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        PRAGMA user_version = 7;
        COMMIT;
      `);
    }

    if (version < 8) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE terminal_records (
          project_id TEXT NOT NULL REFERENCES projects(id),
          terminal_id TEXT NOT NULL,
          label TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          rows INTEGER NOT NULL,
          cols INTEGER NOT NULL,
          pid INTEGER,
          exit_code INTEGER,
          exit_signal INTEGER,
          history_file TEXT NOT NULL,
          history_version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (project_id, terminal_id)
        );
        CREATE INDEX terminal_records_project_updated ON terminal_records(project_id, updated_at);
        PRAGMA user_version = 8;
        COMMIT;
      `);
    }

    if (version < 9) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN last_user_message_at TEXT;
        ALTER TABLE sessions ADD COLUMN last_user_message_sequence INTEGER;
        PRAGMA user_version = 9;
        COMMIT;
      `);
    }

    if (version < 10) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE sessions ADD COLUMN read_through_sequence INTEGER NOT NULL DEFAULT 0;
        UPDATE sessions
        SET read_through_sequence = COALESCE(last_terminal_sequence, 0);
        PRAGMA user_version = 10;
        COMMIT;
      `);
    }
  }
}
