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
  subagentRuns: [{
    id: "run-cached",
    parentSessionId: "session-1",
    parentToolCallId: "tool-cached",
    childSessionId: "child-cached",
    role: "reviewer",
    status: "needs_attention",
    taskPreview: "Review cached projection",
    createdAt: "2026-07-23T01:00:00.000Z",
    updatedAt: "2026-07-23T01:01:00.000Z",
  }],
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

function seedLegacyCache(records: { details?: unknown[]; metadata?: unknown[] }): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("anvil-thread-cache", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("details", { keyPath: "sessionId" });
      request.result.createObjectStore("meta", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["details", "meta"], "readwrite");
      for (const record of records.details ?? []) transaction.objectStore("details").put(record);
      for (const record of records.metadata ?? []) transaction.objectStore("meta").put(record);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("ThreadCache", () => {
  it("migrates details, shell metadata, and the prompt outbox from the legacy database", async () => {
    const command = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "legacy-command",
      sessionId: detail.sessionId,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "prompt.send" as const,
      payload: { content: "Continue", delivery: "prompt" as const },
    };
    await seedLegacyCache({
      details: [{ sessionId: detail.sessionId, detail, persistedAt: 1, lastAccessedAt: 1, bytes: 1 }],
      metadata: [
        { key: "shell", bootstrap: summary, activeSessionId: detail.sessionId, persistedAt: 1 },
        { key: "prompt-outbox", prompts: [{ command, content: "Continue" }] },
      ],
    });

    const cache = new ThreadCache();
    expect(await cache.readDetail(detail.sessionId)).toEqual(detail);
    expect(await cache.readShell()).toMatchObject({ bootstrap: summary, activeSessionId: detail.sessionId });
    expect(await cache.readPromptOutbox()).toEqual([{ command, content: "Continue" }]);
  });

  it("does not replace canonical data when both databases exist", async () => {
    const canonical = new ThreadCache();
    await canonical.writeDetail(detail);
    await seedLegacyCache({
      details: [{
        sessionId: detail.sessionId,
        detail: { ...detail, throughSequence: 99, timeline: [] },
        persistedAt: 2,
        lastAccessedAt: 2,
        bytes: 1,
      }],
    });

    expect(await new ThreadCache().readDetail(detail.sessionId)).toEqual(detail);
  });

  it("persists shell and detail across cache instances", async () => {
    const writer = new ThreadCache();
    const workspaceLocation = { projectId: "anvil", sessionId: detail.sessionId };
    await writer.writeShell(summary, detail.sessionId, workspaceLocation);
    await writer.writeDetail(detail);

    const reader = new ThreadCache();
    expect(await reader.readShell()).toEqual({
      bootstrap: summary,
      activeSessionId: detail.sessionId,
      workspaceLocation,
    });
    expect(await reader.readDetail(detail.sessionId)).toEqual(detail);
  });

  it("persists a project-only workspace location", async () => {
    const writer = new ThreadCache();
    const workspaceLocation = { projectId: "anvil", sessionId: null };
    await writer.writeShell(summary, null, workspaceLocation);

    expect(await new ThreadCache().readShell()).toMatchObject({
      activeSessionId: null,
      workspaceLocation,
    });
  });

  it("does not replace the last settled entry with a streaming snapshot", async () => {
    const writer = new ThreadCache();
    await writer.writeDetail(detail);
    await writer.writeDetail({ ...detail, throughSequence: 43, runState: "running", timeline: [] });

    expect(await new ThreadCache().readDetail(detail.sessionId)).toEqual(detail);
  });

  it("persists unresolved prompt IDs and purges session detail", async () => {
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
    await cache.writePromptOutbox([{ command, content: "Continue" }]);

    expect(await new ThreadCache().readPromptOutbox()).toEqual([{ command, content: "Continue" }]);
    await cache.deleteSession(detail.sessionId);
    expect(await new ThreadCache().readDetail(detail.sessionId)).toBeUndefined();
  });
});
