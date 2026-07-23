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
