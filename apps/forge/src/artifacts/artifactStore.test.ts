import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiRpcAdapterState, normalizePiRpcRecord } from "@anvil/pi-rpc";
import { ANVIL_PROTOCOL_VERSION, isAnvilEvent, type ArtifactContentBlock, type ArtifactReference, type SessionSummary } from "@anvil/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ArtifactStore } from "./artifactStore.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  it("keeps normalized image messages valid when externalizing inline data", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-artifacts-"));
    directories.push(directory);
    const state = createPiRpcAdapterState({
      sessionId: "session-1",
      fixtureId: "image-message",
      baseTimestamp: "2026-07-24T00:00:00.000Z",
    });
    const [event] = normalizePiRpcRecord(state, {
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Review this image" },
          { type: "image", data: "a".repeat(301_776), mimeType: "image/png" },
        ],
      },
    }, 0);
    const [prepared] = new ArtifactStore(directory).externalize([event!]).events;

    expect(isAnvilEvent({ ...prepared, protocolVersion: ANVIL_PROTOCOL_VERSION, id: "event-1", sequence: 1 })).toBe(true);
  });

  it("externalizes oversized tool output and raw records before journaling", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-artifacts-"));
    directories.push(directory);
    const database = new ForgeDatabase(":memory:");
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const store = new ArtifactStore(directory, 64);
    const events = new ForgeEventService(database, [project], store);
    const session: SessionSummary = {
      id: "session-1",
      projectId: project.id,
      title: "Artifacts",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "medium",
    };
    events.createSession(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });

    const output = `${"a".repeat(5_000)}SECRET-END`;
    const [committed] = events.append([{
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "tool.started",
      payload: {
        tool: {
          id: "tool-1",
          kind: "tool",
          toolCallId: "call-1",
          name: "bash",
          summary: "Large output",
          status: "running",
          arguments: {},
          output: [{ id: "output-1", type: "text", text: output }],
          createdAt: "2026-07-23T01:00:01.000Z",
        },
      },
      raw: { type: "tool_execution_start", payload: output },
    }]);

    expect(committed?.type).toBe("tool.started");
    if (committed?.type !== "tool.started") throw new Error("Expected tool event");
    const block = committed.payload.tool.output[0] as ArtifactContentBlock;
    expect(block).toMatchObject({
      type: "artifact",
      mediaType: "text/plain; charset=utf-8",
      byteLength: Buffer.byteLength(output),
      url: expect.stringContaining("/api/v1/artifacts/"),
    });
    expect(block.preview).not.toContain("SECRET-END");
    const raw = committed.raw as unknown as ArtifactReference;
    expect(raw.type).toBe("artifactReference");

    const metadata = database.getArtifact(block.artifactId);
    expect(metadata).toMatchObject({ sessionId: session.id, byteLength: Buffer.byteLength(output) });
    const path = store.pathFor(block.artifactId)!;
    expect(readFileSync(path, "utf8")).toBe(output);

    events.deleteSession(session.id, {
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.deleted",
      payload: { sessionId: session.id },
    });
    expect(database.getArtifact(block.artifactId)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    database.close();
  });

  it("externalizes oversized message deltas and rejects untrusted references or residual huge events", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-artifacts-"));
    directories.push(directory);
    const store = new ArtifactStore(directory, 32);
    const prepared = store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "message.delta",
      payload: { messageId: "message-1", blockId: "text-1", delta: "delta".repeat(100) },
    }]);
    const delta = prepared.events[0];
    expect(delta?.type).toBe("message.delta");
    if (delta?.type !== "message.delta") throw new Error("Expected delta event");
    expect(delta.payload).toMatchObject({
    delta: "",
    artifact: { type: "artifact", preview: expect.stringContaining("delta") },
  });

    expect(() => store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          content: [{
            id: "artifact-1",
            type: "artifact",
            artifactId: prepared.artifacts[0]!.id,
            url: `/api/v1/artifacts/${prepared.artifacts[0]!.id}`,
            mediaType: "text/plain",
            byteLength: 100,
          }],
          status: "complete",
          createdAt: "2026-07-23T01:00:00.000Z",
        },
      },
    }])).toThrow("untrusted artifact reference");

    expect(() => store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "timeline.event",
      payload: {
        entry: {
          id: "event-1",
          kind: "event",
          category: "unknown",
          tone: "neutral",
          title: "x".repeat(1024 * 1024 + 1),
          createdAt: "2026-07-23T01:00:00.000Z",
        },
      },
    }])).toThrow("remains too large");
  });

  it("omits undefined optional fields instead of failing the Pi runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-artifacts-"));
    directories.push(directory);
    const store = new ArtifactStore(directory, 64);
    const { events: [prepared] } = store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "tool.updated",
      payload: {
        toolCallId: "call-1",
        output: [],
        details: undefined,
      },
      raw: { type: "tool_execution_update", optional: undefined },
    } as unknown as Parameters<ArtifactStore["externalize"]>[0][number]]);

    expect(prepared).toEqual({
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "tool.updated",
      payload: { toolCallId: "call-1", output: [] },
      raw: { type: "tool_execution_update" },
    });
  });

  it("garbage-collects files that have no durable metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-artifacts-"));
    directories.push(directory);
    const store = new ArtifactStore(directory, 1);
    const prepared = store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "timeline.event",
      payload: {
        entry: {
          id: "event-1",
          kind: "event",
          category: "unknown",
          tone: "neutral",
          title: "Large",
          details: { value: "large" },
          createdAt: "2026-07-23T01:00:00.000Z",
        },
      },
    }]);
    const artifact = prepared.artifacts[0]!;
    const id = artifact.id;
    expect(existsSync(store.pathFor(id)!)).toBe(true);
    expect(store.reconcile([artifact])).toEqual([]);
    rmSync(store.pathFor(id)!);
    expect(store.reconcile([artifact])).toEqual([id]);

    const orphan = store.externalize([{
      sessionId: "session-1",
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "timeline.event",
      payload: {
        entry: {
          id: "event-2",
          kind: "event",
          category: "unknown",
          tone: "neutral",
          title: "Large",
          details: { value: "orphan" },
          createdAt: "2026-07-23T01:00:01.000Z",
        },
      },
    }]).artifacts[0]!;
    expect(existsSync(store.pathFor(orphan.id)!)).toBe(true);
    store.removeUnknown(new Set());
    expect(existsSync(store.pathFor(orphan.id)!)).toBe(false);
  });
});
