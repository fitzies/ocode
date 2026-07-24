import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilSessionDetail,
  type AnvilSummaryBootstrap,
} from "@anvil/protocol";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadCache } from "./threadCache";

const detail: AnvilSessionDetail = {
  protocolVersion: ANVIL_PROTOCOL_VERSION,
  sessionId: "session-1",
  throughSequence: 42,
  timeline: [{
    id: "message-1",
    kind: "message",
    role: "assistant",
    content: [{ id: "text-1", type: "text", text: "Cached" }],
    status: "complete",
    createdAt: "2026-07-23T01:00:00.000Z",
  }],
  catalog: { models: [], commands: [], skills: [] },
  pendingInteractions: [],
  extensionStatuses: [],
  widgets: [],
  queue: { steering: [], followUp: [] },
  composerDraft: "",
  runState: "idle",
};

const summary: AnvilSummaryBootstrap = {
  protocolVersion: ANVIL_PROTOCOL_VERSION,
  capturedAt: "2026-07-23T01:00:00.000Z",
  connection: "connected",
  projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
  sessions: [{
    id: detail.sessionId,
    projectId: "anvil",
    title: "Cached",
    updatedAt: "2026-07-23T01:00:00.000Z",
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "medium",
  }],
  cursor: detail.throughSequence,
};

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("ThreadCache", () => {
  it("persists shell, detail, and local read state across cache instances", async () => {
    const writer = new ThreadCache();
    await writer.writeShell(summary, detail.sessionId);
    await writer.writeDetail(detail);
    await writer.writeReadThrough(detail.sessionId, 41);

    const reader = new ThreadCache();
    expect(await reader.readShell()).toEqual({ bootstrap: summary, activeSessionId: detail.sessionId });
    expect(await reader.readDetail(detail.sessionId)).toEqual(detail);
    expect(await reader.readThrough(detail.sessionId)).toBe(41);
  });

  it("does not replace the last settled entry with a streaming snapshot", async () => {
    const writer = new ThreadCache();
    await writer.writeDetail(detail);
    await writer.writeDetail({ ...detail, throughSequence: 43, runState: "running", timeline: [] });

    expect(await new ThreadCache().readDetail(detail.sessionId)).toEqual(detail);
  });

  it("persists unresolved prompt IDs and purges all session-local state", async () => {
    const command = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "command-1",
      sessionId: detail.sessionId,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "prompt.send" as const,
      payload: { content: "Continue", delivery: "prompt" as const },
    };
    const cache = new ThreadCache();
    await cache.writeDetail(detail);
    await cache.writeReadThrough(detail.sessionId, 0);
    await cache.writePromptOutbox([{ command, content: "Continue" }]);

    expect(await new ThreadCache().readPromptOutbox()).toEqual([{ command, content: "Continue" }]);
    await cache.deleteSession(detail.sessionId);
    expect(await new ThreadCache().readDetail(detail.sessionId)).toBeUndefined();
    expect(await new ThreadCache().readThrough(detail.sessionId)).toBeUndefined();
  });
});
