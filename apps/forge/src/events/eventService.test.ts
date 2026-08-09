import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ANVIL_PROTOCOL_VERSION } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { ForgeDatabase } from "../store/database.ts";
import { ForgeEventService } from "./eventService.ts";

describe("ForgeEventService", () => {
  it("commits before publishing and bootstraps the materialized state", () => {
    const database = new ForgeDatabase(":memory:");
    const service = new ForgeEventService(database, []);
    const published: number[] = [];
    service.on("event", (event) => published.push(event.sequence));

    service.append([{
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "connection.changed",
      payload: { connection: "reconnecting" },
    }]);

    expect(published).toEqual([1]);
    expect(database.latestSequence()).toBe(1);
    expect(service.bootstrap()).toMatchObject({
      cursor: 1,
      events: [],
      snapshot: { connection: "reconnecting", lastSequence: 1 },
    });
    database.close();
  });

  it("restores durable session read state across Forge restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-read-state-"));
    const path = join(directory, "forge.sqlite");
    const project = { id: "project-1", name: "Project", path: "/repo" };
    try {
      const database = new ForgeDatabase(path);
      const service = new ForgeEventService(database, [project]);
      const session = {
        id: "session-read-state",
        projectId: project.id,
        title: "Durable read state",
        updatedAt: "2026-07-23T01:00:00.000Z",
        status: "idle" as const,
        modelId: "test/model",
        thinkingLevel: "off" as const,
        lastTerminalSequence: 8,
        lastTerminalOutcome: "completed" as const,
        readThroughSequence: 0,
      };
      service.createSession(session, {
        sessionId: session.id,
        timestamp: session.updatedAt,
        type: "session.upserted",
        payload: { session },
      });
      service.markSessionRead(session.id, 8);
      expect(service.summaryBootstrap().sessions[0]?.readThroughSequence).toBe(8);
      database.close();

      const reopened = new ForgeDatabase(path);
      const restored = new ForgeEventService(reopened, [project]);
      expect(restored.summaryBootstrap().sessions[0]?.readThroughSequence).toBe(8);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a deletion from a retained snapshot after older events were compacted", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-compacted-delete-"));
    const path = join(directory, "forge.sqlite");
    const project = { id: "project-1", name: "Project", path: "/repo" };
    try {
      const database = new ForgeDatabase(path);
      const service = new ForgeEventService(database, [project]);
      const session = {
        id: "session-1",
        projectId: project.id,
        title: "Deleted later",
        updatedAt: "2026-07-23T01:00:00.000Z",
        status: "idle" as const,
        modelId: "test/model",
        thinkingLevel: "off" as const,
        settled: false,
      };
      service.createSession(session, {
        sessionId: session.id,
        timestamp: session.updatedAt,
        type: "session.upserted",
        payload: { session },
      });
      database.saveSnapshot(service.currentSnapshot(), {
        retainedEventCount: 0,
        maxCompactionRows: 10,
      });
      expect(database.compactedThrough()).toBe(1);
      database.deleteSessionWithEvent(session.id, {
        sessionId: session.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        type: "session.deleted",
        payload: { sessionId: session.id },
      });
      database.close();

      const reopened = new ForgeDatabase(path);
      const restored = new ForgeEventService(reopened, [project]);
      expect(restored.currentSnapshot()).toMatchObject({ sessions: [], lastSequence: 2 });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails fast when an incompatible snapshot is the only recovery point for a compacted journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-compacted-incompatible-snapshot-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      first.appendEvents([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:00.000Z",
        type: "connection.changed",
        payload: { connection: "reconnecting" },
      }]);
      first.saveSnapshot({
        ...new ForgeEventService(first, []).currentSnapshot(),
        lastSequence: 1,
      }, { retainedEventCount: 0, maxCompactionRows: 10 });
      first.close();

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE snapshots SET snapshot_json = ?").run(JSON.stringify({
        protocolVersion: 999,
        lastSequence: 1,
      }));
      raw.close();

      const reopened = new ForgeDatabase(path);
      expect(() => new ForgeEventService(reopened, [])).toThrow(
        "Cannot restore compacted event journal through sequence 1: no compatible snapshot is available",
      );
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a compatible snapshot that predates the compacted journal boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-stale-compatible-snapshot-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      const service = new ForgeEventService(first, []);
      service.append([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:00.000Z",
        type: "connection.changed",
        payload: { connection: "reconnecting" },
      }]);
      first.saveSnapshot(service.currentSnapshot());
      service.append([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:01.000Z",
        type: "connection.changed",
        payload: { connection: "connected" },
      }]);
      first.saveSnapshot(service.currentSnapshot(), { retainedEventCount: 0, maxCompactionRows: 10 });
      first.close();

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE snapshots SET snapshot_json = ? WHERE cursor = 2").run(JSON.stringify({
        protocolVersion: 999,
        lastSequence: 2,
      }));
      raw.close();

      const reopened = new ForgeDatabase(path);
      expect(() => new ForgeEventService(reopened, [])).toThrow(
        "Cannot restore compacted event journal through sequence 2: latest compatible snapshot is at sequence 1",
      );
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores a compacted protocol 11 snapshot on main and replays its retained protocol 10 tail", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-compacted-v11-snapshot-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      const service = new ForgeEventService(first, []);
      service.append([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:00.000Z",
        type: "connection.changed",
        payload: { connection: "reconnecting" },
      }]);
      first.saveSnapshot(service.currentSnapshot(), { retainedEventCount: 0, maxCompactionRows: 10 });
      service.append([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:01.000Z",
        type: "connection.changed",
        payload: { connection: "connected" },
      }]);
      first.close();

      const raw = new DatabaseSync(path);
      const row = raw.prepare("SELECT snapshot_json FROM snapshots WHERE cursor = 1").get() as { snapshot_json: string };
      const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      snapshot.protocolVersion = 11;
      snapshot.subagents = { "session-1": [{ id: "unsupported-wip-state" }] };
      raw.prepare("UPDATE snapshots SET snapshot_json = ? WHERE cursor = 1").run(JSON.stringify(snapshot));
      raw.close();

      const reopened = new ForgeDatabase(path);
      const restored = new ForgeEventService(reopened, []);
      expect(restored.currentSnapshot()).toMatchObject({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        connection: "connected",
        lastSequence: 2,
      });
      expect(restored.currentSnapshot()).not.toHaveProperty("subagents");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to full journal replay when the stored snapshot is obsolete", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-snapshot-fallback-"));
    const path = join(directory, "forge.sqlite");
    try {
      const first = new ForgeDatabase(path);
      first.appendEvents([{
        sessionId: null,
        timestamp: "2026-07-23T01:00:00.000Z",
        type: "connection.changed",
        payload: { connection: "reconnecting" },
      }]);
      first.close();

      const raw = new DatabaseSync(path);
      raw.prepare(`
        INSERT INTO snapshots (cursor, captured_at, snapshot_json)
        VALUES (?, ?, ?)
      `).run(1, "2026-07-23T01:00:00.000Z", JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        capturedAt: "2026-07-23T01:00:00.000Z",
        connection: "connected",
        projects: [],
        sessions: [],
        activeSessionId: null,
        timelines: {},
        catalog: { models: [], commands: [], skills: [] },
        pendingInteractions: [],
        extensionStatuses: [],
        widgets: [],
        queues: {},
        composerDrafts: {},
        runStates: {},
        lastSequence: 1,
        sequenceGap: null,
      }));
      raw.close();

      const reopened = new ForgeDatabase(path);
      const restored = new ForgeEventService(reopened, []);
      expect(restored.currentSnapshot()).toMatchObject({
        connection: "connected",
        lastSequence: 1,
        catalogs: {},
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
