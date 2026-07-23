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
} from "@anvil/protocol";

// Keep the specifier indirect until tsup's esbuild recognizes node:sqlite as a built-in.
const sqliteModuleName = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as typeof import("node:sqlite");

const SCHEMA_VERSION = 1;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected persisted JSON text");
  return JSON.parse(value);
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

  updateSession(session: SessionSummary, piState?: { sessionId?: string; sessionFile?: string }): void {
    this.database.prepare(`
      UPDATE sessions SET
        pi_session_id = COALESCE(?, pi_session_id),
        pi_session_file = COALESCE(?, pi_session_file),
        title = ?, model_id = ?, thinking_level = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      piState?.sessionId ?? null,
      piState?.sessionFile ?? null,
      session.title,
      session.modelId,
      session.thinkingLevel,
      session.status,
      session.updatedAt,
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
      this.database.prepare("DELETE FROM snapshots").run();
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
      SELECT id, project_id, title, model_id, thinking_level, status, updated_at,
             pi_session_id, pi_session_file
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
        updatedAt: String(row.updated_at),
      },
      piSessionId: typeof row.pi_session_id === "string" ? row.pi_session_id : undefined,
      piSessionFile: typeof row.pi_session_file === "string" ? row.pi_session_file : undefined,
    };
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

  appendEvents(events: readonly UnsequencedAnvilEvent[]): AnvilEvent[] {
    if (events.length === 0) return [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const committed = this.insertEvents(events);
      this.database.exec("COMMIT");
      return committed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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

    return rows.map((row) => {
      const candidate = {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        sequence: Number(row.sequence),
        id: row.id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        type: row.type,
        payload: parseJson(row.payload_json),
        ...(row.raw_json === null ? {} : { raw: parseJson(row.raw_json) }),
      };
      if (!isAnvilEvent(candidate)) {
        throw new Error(`Persisted event ${String(row.sequence)} failed protocol validation`);
      }
      return candidate;
    });
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

  saveSnapshot(snapshot: AnvilSnapshot): void {
    if (!isAnvilSnapshot(snapshot)) throw new Error("Cannot persist an invalid Anvil snapshot");
    if (snapshot.lastSequence > this.latestSequence()) {
      throw new Error("Snapshot cursor is ahead of the event journal");
    }
    this.database.prepare(`
      INSERT INTO snapshots (cursor, captured_at, snapshot_json)
      VALUES (?, ?, ?)
      ON CONFLICT(cursor) DO UPDATE SET
        captured_at = excluded.captured_at,
        snapshot_json = excluded.snapshot_json
    `).run(snapshot.lastSequence, snapshot.capturedAt, JSON.stringify(snapshot));
  }

  latestSnapshot(): StoredSnapshot | undefined {
    const rows = this.database.prepare(`
      SELECT cursor, snapshot_json
      FROM snapshots
      ORDER BY cursor DESC
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      try {
        const snapshot = parseJson(row.snapshot_json);
        if (isAnvilSnapshot(snapshot)) return { snapshot, cursor: Number(row.cursor) };
      } catch {
        // Ignore corrupt or obsolete snapshots and continue toward a full journal replay.
      }
    }
    return undefined;
  }

  private insertSession(session: SessionSummary): void {
    this.database.prepare(`
      INSERT INTO sessions (
        id, project_id, title, model_id, thinking_level, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.projectId,
      session.title,
      session.modelId,
      session.thinkingLevel,
      session.status,
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

    this.database.exec(`
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
  }
}
