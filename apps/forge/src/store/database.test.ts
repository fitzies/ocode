import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import { ANVIL_PROTOCOL_VERSION } from "@anvil/protocol";
import { applyAnvilEvents, createEmptySnapshot } from "@anvil/state";
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
        INSERT INTO sessions (id, project_id, title, model_id, thinking_level, status, last_terminal_sequence, last_terminal_outcome, created_at, updated_at) VALUES ('session-1', 'project-1', 'Legacy', 'test/model', 'off', 'idle', 44, 'completed', '2026-07-23T01:00:00.000Z', '2026-07-23T01:00:00.000Z');
      `);
      legacy.close();

      const migrated = new ForgeDatabase(path);
      expect(migrated.getSession("session-1")?.session).toMatchObject({
        title: "Legacy",
        settled: false,
        lastTerminalSequence: 44,
        readThroughSequence: 44,
      });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes legacy speech usage data during migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocode-schema-v12-"));
    const path = join(directory, "forge.sqlite");
    try {
      const database = new ForgeDatabase(path);
      database.close();

      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE speech_daily_usage (
          date TEXT PRIMARY KEY,
          requests INTEGER NOT NULL,
          characters INTEGER NOT NULL
        );
        INSERT INTO speech_daily_usage VALUES ('2026-07-23', 1, 100);
        PRAGMA user_version = 12;
      `);
      legacy.close();

      const migrated = new ForgeDatabase(path);
      migrated.close();
      const raw = new DatabaseSync(path);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'speech_daily_usage'").get()).toBeUndefined();
      expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
      raw.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a session rename with its configuration event", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    const session = {
      id: "session-renamed",
      projectId: "project-1",
      title: "Original title",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle" as const,
      modelId: "test/model",
      thinkingLevel: "off" as const,
    };
    database.createSession(session);
    database.renameSessionWithEvent(session.id, "Renamed thread", {
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.configured",
      payload: { title: "Renamed thread" },
    });

    expect(database.getSession(session.id)?.session).toMatchObject({
      title: "Renamed thread",
      updatedAt: "2026-07-23T01:00:01.000Z",
    });
    expect(database.readEventsAfter(0)).toMatchObject([
      { type: "session.configured", payload: { title: "Renamed thread" } },
    ]);
    database.close();
  });

  it("persists context usage only when it changes", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    database.createSession({
      id: "session-context",
      projectId: "project-1",
      title: "Context thread",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "off",
    });
    const context = { tokens: 12_345, contextWindow: 200_000, percent: 6.17 };

    expect(database.updateSessionContextUsage("session-context", context)).toBe(true);
    expect(database.updateSessionContextUsage("session-context", context)).toBe(false);
    expect(database.getSession("session-context")?.contextUsage).toEqual(context);
    database.close();
  });

  it("persists a session's settled state", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    const session = {
      id: "session-settled",
      projectId: "project-1",
      title: "Resolved thread",
      updatedAt: "2026-07-23T01:00:00.000Z",
      lastUserMessageAt: "2026-07-23T00:59:00.000Z",
      lastUserMessageSequence: 12,
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
      lastUserMessageAt: "2026-07-23T00:59:00.000Z",
      lastUserMessageSequence: 12,
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

  it("transactionally clamps and persists idempotent session read state", () => {
    const database = new ForgeDatabase(":memory:");
    database.syncProjects([{ id: "project-1", name: "Project", path: "/repo" }]);
    database.createSession({
      id: "session-read-state",
      projectId: "project-1",
      title: "Read state",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "off",
      lastTerminalSequence: 50,
      lastTerminalOutcome: "failed",
      readThroughSequence: 0,
    });

    expect(database.markSessionReadWithEvent("session-read-state", 100, "2026-07-23T01:00:01.000Z"))
      .toMatchObject({ type: "session.readState", payload: { readThroughSequence: 50 } });
    expect(database.markSessionReadWithEvent("session-read-state", 40, "2026-07-23T01:00:02.000Z"))
      .toBeUndefined();
    expect(database.getSession("session-read-state")?.session.readThroughSequence).toBe(50);

    expect(database.markSessionUnreadWithEvent("session-read-state", "2026-07-23T01:00:03.000Z"))
      .toMatchObject({ type: "session.readState", payload: { readThroughSequence: 49 } });
    expect(database.markSessionUnreadWithEvent("session-read-state", "2026-07-23T01:00:04.000Z"))
      .toBeUndefined();
    expect(database.readEventsAfter(0)).toHaveLength(2);

    database.createSession({
      id: "session-without-terminal",
      projectId: "project-1",
      title: "No terminal event",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "off",
      readThroughSequence: 0,
    });
    expect(database.markSessionUnreadWithEvent("session-without-terminal", "2026-07-23T01:00:05.000Z"))
      .toBeUndefined();
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

  it("compacts a checkpointed journal prefix without reusing global sequences", () => {
    const database = new ForgeDatabase(":memory:");
    const committed = database.appendEvents(Array.from({ length: 5 }, (_, index) =>
      event(null, `2026-07-23T01:00:0${index}.000Z`),
    ));
    const snapshot = applyAnvilEvents(createEmptySnapshot(), committed);

    database.saveSnapshot(snapshot, { retainedEventCount: 2, maxCompactionRows: 10 });

    expect(database.compactedThrough()).toBe(3);
    expect(database.readEventsAfter(0).map((item) => item.sequence)).toEqual([4, 5]);
    expect(database.appendEvents([
      event(null, "2026-07-23T01:00:06.000Z"),
    ])[0]?.sequence).toBe(6);
    database.close();
  });

  it.each([5, 6, 7])("upgrades structurally compatible protocol %i snapshots", (legacyVersion) => {
    const directory = mkdtempSync(join(tmpdir(), `anvil-store-v${legacyVersion}-snapshot-`));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      first.saveSnapshot({ ...createEmptySnapshot(), connection: "offline" });
      first.close();

      const raw = new DatabaseSync(path);
      const row = raw.prepare("SELECT snapshot_json FROM snapshots WHERE cursor = 0").get() as { snapshot_json: string };
      const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      snapshot.protocolVersion = legacyVersion;
      snapshot.projects = [{ id: "project-1", name: "Project", path: "/repo" }];
      snapshot.sessions = [{
        id: "session-1",
        projectId: "project-1",
        title: "Legacy resource",
        updatedAt: "2026-07-23T01:00:00.000Z",
        status: "idle",
        modelId: "test/model",
        thinkingLevel: "off",
      }];
      snapshot.timelines = {
        "session-1": [{
          id: "tool-legacy",
          kind: "tool",
          toolCallId: "call-legacy",
          name: "anvil_open_file",
          summary: "Open file",
          status: "completed",
          arguments: { path: "README.md" },
          output: [{ id: "resource-legacy", type: "projectResource", projectId: "project-1", path: "README.md" }],
          createdAt: "2026-07-23T01:00:00.000Z",
        }],
      };
      raw.prepare("UPDATE snapshots SET snapshot_json = ? WHERE cursor = 0").run(JSON.stringify(snapshot));
      raw.close();

      const reopened = new ForgeDatabase(path);
      const restored = reopened.latestSnapshot()?.snapshot;
      expect(restored).toMatchObject({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        connection: "offline",
        lastSequence: 0,
        sessions: [{ readThroughSequence: 0 }],
        timelines: { "session-1": [{ output: [{ type: "projectResource", path: "README.md" }] }] },
      });
      const entry = restored?.timelines["session-1"]?.[0];
      expect(entry?.kind === "tool" ? entry.output[0] : undefined).not.toHaveProperty("projectId");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades legacy project resource blocks in persisted journal events", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-store-resource-event-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      first.appendEvents([{
        sessionId: "session-1",
        timestamp: "2026-07-23T01:00:00.000Z",
        type: "tool.completed",
        payload: {
          toolCallId: "call-1",
          status: "completed",
          output: [{ id: "resource-1", type: "projectResource", path: "README.md" }],
        },
      }]);
      first.close();

      const raw = new DatabaseSync(path);
      const row = raw.prepare("SELECT payload_json FROM events WHERE sequence = 1").get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as { output: Array<Record<string, unknown>> };
      payload.output[0]!.projectId = "project-1";
      raw.prepare("UPDATE events SET payload_json = ? WHERE sequence = 1").run(JSON.stringify(payload));
      raw.close();

      const reopened = new ForgeDatabase(path);
      const restored = reopened.readEventsAfter(0)[0];
      expect(restored).toMatchObject({ payload: { output: [{ type: "projectResource", path: "README.md" }] } });
      expect(restored?.type === "tool.completed" ? restored.payload.output[0] : undefined).not.toHaveProperty("projectId");
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

  it("imports every configured project exactly once during the database-authority migration", () => {
    const database = new ForgeDatabase(":memory:");
    const existing = { id: "project-existing", name: "Existing", path: "/repo/existing" };
    const configured = { id: "project-configured", name: "Configured", path: "/repo/configured" };
    database.syncProjects([existing]);

    database.seedConfigProjectsOnce([configured]);
    expect(database.listProjects().map((project) => project.id).sort()).toEqual([
      existing.id,
      configured.id,
    ].sort());

    database.seedConfigProjectsOnce([{ id: "project-late", name: "Late", path: "/repo/late" }]);
    expect(database.listProjects().some((project) => project.id === "project-late")).toBe(false);
    database.close();
  });

  it("transactionally removes a project cascade and redacts its durable content", () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project-remove", name: "Private Project", path: "/repo/private-project" };
    const session = {
      id: "session-remove",
      projectId: project.id,
      title: "Private thread title",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "waiting" as const,
      modelId: "test/model",
      thinkingLevel: "off" as const,
    };
    const committed = [database.createProjectWithEvent(project, {
      sessionId: null,
      timestamp: session.updatedAt,
      type: "project.upserted",
      payload: { project },
    }), database.createSessionWithEvent(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    })];
    database.appendEvents([{
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "interaction.requested",
      payload: { request: {
        id: "private-request", sessionId: session.id, method: "confirm", title: "Private question", requestedAt: session.updatedAt,
      } },
    }], [{
      id: "01959f7e-7d64-7000-8000-000000000099",
      sessionId: session.id,
      mediaType: "text/plain",
      byteLength: 7,
      name: "private.txt",
      purpose: "output",
      createdAt: session.updatedAt,
    }]);
    database.upsertTerminalRecord({
      metadata: {
        projectId: project.id,
        terminalId: "terminal-private",
        label: "Private shell",
        status: "interrupted",
        createdAt: session.updatedAt,
        updatedAt: session.updatedAt,
        sequence: 0,
        rows: 24,
        cols: 80,
      },
      historyFile: "private/history.log",
      historyVersion: 1,
    });
    database.beginCommand({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "private-command",
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "run.cancel",
      payload: {},
    });
    const beforeDelete = applyAnvilEvents(createEmptySnapshot(), [
      ...committed,
      ...database.readEventsAfter(2),
    ]);
    database.saveSnapshot(beforeDelete);

    const deleted = database.deleteProjectWithEvent(project.id, {
      sessionId: null,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "project.deleted",
      payload: { projectId: project.id },
    });

    expect(deleted.sessionIds).toEqual([session.id]);
    expect(deleted.artifactIds).toEqual(["01959f7e-7d64-7000-8000-000000000099"]);
    expect(database.listProjects()).toEqual([]);
    expect(database.getSession(session.id)).toBeUndefined();
    expect(database.listArtifacts()).toEqual([]);
    expect(database.listPendingInteractions()).toEqual([]);
    expect(database.listTerminalRecords(project.id)).toEqual([]);
    expect(database.commandOutcome("private-command")).toBeUndefined();
    const redactedSnapshot = database.latestSnapshot()?.snapshot;
    expect(redactedSnapshot?.projects).toEqual([]);
    expect(redactedSnapshot?.sessions).toEqual([]);
    expect(JSON.stringify(redactedSnapshot)).not.toContain("Private");
    expect(JSON.stringify(redactedSnapshot)).not.toContain(project.path);
    const journal = database.readEventsAfter(0);
    expect(journal.map((item) => item.type)).toEqual(["unknown", "unknown", "unknown", "project.deleted"]);
    expect(JSON.stringify(journal)).not.toContain("Private");
    expect(JSON.stringify(journal)).not.toContain(project.path);
    database.close();
  });

  it("rolls back every project removal mutation when the event is invalid", () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project-rollback", name: "Rollback", path: "/repo/rollback" };
    database.syncProjects([project]);
    database.createSession({
      id: "session-rollback",
      projectId: project.id,
      title: "Keep me",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "off",
    });

    expect(() => database.deleteProjectWithEvent(project.id, {
      sessionId: null,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "project.deleted",
      payload: {},
    } as never)).toThrow("Refusing to persist invalid event");
    expect(database.listProjects()).toEqual([project]);
    expect(database.getSession("session-rollback")).toBeDefined();
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
