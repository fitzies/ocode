import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import { describe, expect, it } from "vitest";

import { ForgeDatabase } from "./database.ts";

function event(sessionId: string | null, timestamp: string): UnsequencedAnvilEvent {
  return {
    sessionId,
    timestamp,
    type: "connection.changed",
    payload: { connection: "connected" },
  };
}

describe("ForgeDatabase event journal", () => {
  it("migrates v4 sessions to unsettled without losing them", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-store-v4-"));
    const path = join(directory, "forge.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pi_session_id TEXT, pi_session_file TEXT, title TEXT NOT NULL, model_id TEXT NOT NULL, thinking_level TEXT NOT NULL, status TEXT NOT NULL, recovery_state TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_sequence INTEGER NOT NULL DEFAULT 0, last_terminal_sequence INTEGER, last_terminal_outcome TEXT);
        CREATE TABLE commands (id TEXT PRIMARY KEY, session_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, response_json TEXT);
        PRAGMA user_version = 4;
        INSERT INTO projects VALUES ('project-1', 'Project', '/repo', '2026-07-23T01:00:00.000Z', '2026-07-23T01:00:00.000Z');
        INSERT INTO sessions (id, project_id, title, model_id, thinking_level, status, created_at, updated_at) VALUES ('session-1', 'project-1', 'Legacy', 'test/model', 'off', 'idle', '2026-07-23T01:00:00.000Z', '2026-07-23T01:00:00.000Z');
      `);
      legacy.close();

      const migrated = new ForgeDatabase(path);
      expect(migrated.getSession("session-1")?.session).toMatchObject({ title: "Legacy", settled: false });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a session's settled state", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    const session = {
      id: "session-settled",
      projectId: "project-1",
      title: "Resolved thread",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle" as const,
      modelId: "test/model",
      thinkingLevel: "off" as const,
      settled: false,
      branch: "feature/sidebar",
    };
    database.createSession(session);
    database.setSessionSettledWithEvent(session.id, true, {
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.settled",
      payload: { settled: true },
    });

    expect(database.getSession(session.id)?.session).toMatchObject({
      settled: true,
      branch: "feature/sidebar",
    });
    expect(database.readEventsAfter(0)).toMatchObject([{ type: "session.settled", payload: { settled: true } }]);

    expect(() => database.setSessionSettledWithEvent(session.id, false, {
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.settled",
      payload: { settled: "invalid" },
    } as never)).toThrow("Refusing to persist invalid event");
    expect(database.getSession(session.id)?.session.settled).toBe(true);
    database.close();
  });

  it("assigns one durable global sequence across sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-store-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      expect(first.appendEvents([
        event("session-a", "2026-07-23T01:00:00.000Z"),
        event("session-b", "2026-07-23T01:00:01.000Z"),
      ]).map((item) => item.sequence)).toEqual([1, 2]);
      first.close();

      const reopened = new ForgeDatabase(path);
      expect(reopened.appendEvents([
        event(null, "2026-07-23T01:00:02.000Z"),
      ])[0]?.sequence).toBe(3);
      expect(reopened.readEventsAfter(1).map((item) => [item.sequence, item.sessionId])).toEqual([
        [2, "session-b"],
        [3, null],
      ]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back session creation when its initial event is invalid", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    const session = {
      id: "session-invalid",
      projectId: "project-1",
      title: "Session",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle" as const,
      modelId: "test/model",
      thinkingLevel: "off" as const,
    };
    expect(() => database.createSessionWithEvent(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "run.status",
      payload: { status: "not-a-run-state" },
    } as never)).toThrow("Refusing to persist invalid event");
    expect(database.getSession(session.id)).toBeUndefined();
    expect(database.latestSequence()).toBe(0);
    database.close();
  });

  it("commits artifact metadata transactionally with its referencing event", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    database.createSession({
      id: "session-1",
      projectId: "project-1",
      title: "Session",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "off",
    });
    const artifact = {
      id: "01959f7e-7d64-7000-8000-000000000001",
      sessionId: "session-1",
      mediaType: "text/plain",
      byteLength: 100,
      name: "output.txt",
      purpose: "output" as const,
      createdAt: "2026-07-23T01:00:00.000Z",
    };
    expect(() => database.appendEvents([{
      sessionId: "session-1",
      timestamp: artifact.createdAt,
      type: "run.status",
      payload: { status: "invalid" },
    } as never], [artifact])).toThrow("Refusing to persist invalid event");
    expect(database.getArtifact(artifact.id)).toBeUndefined();

    database.appendEvents([{
      sessionId: "session-1",
      timestamp: artifact.createdAt,
      type: "run.status",
      payload: { status: "idle" },
    }], [artifact]);
    expect(database.getArtifact(artifact.id)).toEqual(artifact);
    database.close();
  });

  it("persists UI-created projects and redacts deleted session history without sequence gaps", () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project-created", name: "Created", path: "/repo/created" };
    database.createProjectWithEvent(project, {
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "project.upserted",
      payload: { project },
    });
    const session = {
      id: "session-delete",
      projectId: project.id,
      title: "Delete me",
      updatedAt: "2026-07-23T01:00:01.000Z",
      status: "idle" as const,
      modelId: "test/model",
      thinkingLevel: "off" as const,
    };
    database.createSessionWithEvent(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });
    database.deleteSessionWithEvent(session.id, {
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.deleted",
      payload: { sessionId: session.id },
    });

    expect(database.listProjects()).toContainEqual(project);
    expect(database.getSession(session.id)).toBeUndefined();
    expect(database.readEventsAfter(0).map((item) => [item.sequence, item.type])).toEqual([
      [1, "project.upserted"],
      [2, "unknown"],
      [3, "session.deleted"],
    ]);
    database.close();
  });

  it("projects pending interactions transactionally with their events", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    database.createSession({
      id: "session-1",
      projectId: "project-1",
      title: "Session",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "waiting",
      modelId: "test/model",
      thinkingLevel: "off",
    });
    database.appendEvents([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "interaction.requested",
      payload: {
        request: {
          id: "request-1",
          sessionId: "session-1",
          method: "confirm",
          title: "Continue?",
          requestedAt: "2026-07-23T01:00:00.000Z",
        },
      },
    }]);
    expect(database.listPendingInteractions()).toHaveLength(1);
    database.appendEvents([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "interaction.resolved",
      payload: { requestId: "request-1", status: "answered" },
    }]);
    expect(database.listPendingInteractions()).toHaveLength(0);
    database.close();
  });

  it("validates event cursors and limits", () => {
    const database = new ForgeDatabase(":memory:");
    expect(() => database.readEventsAfter(-1)).toThrow("Invalid event cursor");
    expect(() => database.readEventsAfter(0, 10_001)).toThrow("Invalid event limit");
    database.close();
  });
});
