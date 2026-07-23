import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
