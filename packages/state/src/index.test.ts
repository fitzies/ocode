import { ANVIL_PROTOCOL_VERSION, isAnvilSnapshot, type AnvilEvent, type SessionSummary } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { applyAnvilEvent, createEmptySnapshot, reconcileSnapshotAndTail } from "./index";

const session: SessionSummary = {
  id: "session-1",
  projectId: "project-1",
  title: "Reducer test",
  updatedAt: "2026-07-21T09:00:00.000Z",
  status: "idle",
  modelId: "openai/test",
  thinkingLevel: "medium",
};

function event<T extends AnvilEvent["type"]>(
  sequence: number,
  type: T,
  payload: Extract<AnvilEvent, { type: T }>["payload"],
): AnvilEvent {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: `event-${sequence}`,
    sequence,
    sessionId: session.id,
    timestamp: `2026-07-21T09:00:0${sequence}.000Z`,
    type,
    payload,
  } as AnvilEvent;
}

describe("Anvil event reducer", () => {
  it("reconciles streaming deltas and ignores replayed sequences", () => {
    let snapshot = createEmptySnapshot({ sessions: [session] });
    snapshot = applyAnvilEvent(
      snapshot,
      event(1, "message.started", {
        message: {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          content: [],
          status: "streaming",
          createdAt: "2026-07-21T09:00:01.000Z",
        },
      }),
    );
    snapshot = applyAnvilEvent(snapshot, event(2, "message.delta", { messageId: "assistant-1", blockId: "text-1", delta: "Hello" }));
    const afterDelta = snapshot;
    snapshot = applyAnvilEvent(snapshot, event(2, "message.delta", { messageId: "assistant-1", blockId: "text-1", delta: " duplicated" }));
    snapshot = applyAnvilEvent(snapshot, event(3, "message.completed", { messageId: "assistant-1" }));

    expect(snapshot.timelines[session.id]).toHaveLength(1);
    expect(snapshot.timelines[session.id][0]).toMatchObject({ status: "complete", content: [{ text: "Hello" }] });
    expect(afterDelta.lastSequence).toBe(2);
    expect(isAnvilSnapshot(snapshot)).toBe(true);
  });

  it("signals sequence gaps instead of discarding late events", () => {
    let snapshot = createEmptySnapshot({ sessions: [session] });
    const delta = event(2, "message.delta", { messageId: "assistant-1", blockId: "text-1", delta: "late" });
    snapshot = applyAnvilEvent(snapshot, delta);
    expect(snapshot.sequenceGap).toEqual({ expected: 1, received: 2, detectedAt: delta.timestamp });
    expect(snapshot.timelines[session.id]).toHaveLength(0);

    snapshot = applyAnvilEvent(snapshot, event(1, "message.started", {
      message: { id: "assistant-1", kind: "message", role: "assistant", content: [], status: "streaming", createdAt: "2026-07-21T09:00:01.000Z" },
    }));
    expect(snapshot.sequenceGap?.expected).toBe(2);
    snapshot = applyAnvilEvent(snapshot, delta);
    expect(snapshot.sequenceGap).toBeNull();
    expect(snapshot.timelines[session.id][0]).toMatchObject({ content: [{ text: "late" }] });
  });

  it("keeps capability catalogs scoped to their Pi sessions", () => {
    const otherSession = { ...session, id: "session-2", modelId: "other/model" };
    let snapshot = createEmptySnapshot({ sessions: [session, otherSession] });
    snapshot = applyAnvilEvent(snapshot, event(1, "catalog.updated", {
      catalog: {
        models: [{
          id: "openai/test",
          provider: "openai",
          name: "Test",
          reasoning: true,
          input: ["text"],
          supportedThinkingLevels: ["off", "medium"],
        }],
        commands: [{ name: "project-one", source: "prompt", location: "project" }],
        skills: [],
      },
    }));
    snapshot = applyAnvilEvent(snapshot, {
      ...event(2, "catalog.updated", {
        catalog: {
          models: [],
          commands: [{ name: "project-two", source: "prompt", location: "project" }],
          skills: [],
        },
      }),
      sessionId: otherSession.id,
    });

    expect(snapshot.catalogs[session.id].commands.map((command) => command.name)).toEqual(["project-one"]);
    expect(snapshot.catalogs[otherSession.id].commands.map((command) => command.name)).toEqual(["project-two"]);
  });

  it("restores the underlying run state after the last pending dialog resolves", () => {
    let incoming = createEmptySnapshot({ sessions: [session] });
    incoming = applyAnvilEvent(incoming, event(1, "run.status", { status: "running" }));
    incoming = applyAnvilEvent(incoming, event(2, "interaction.requested", {
      request: { id: "request-1", sessionId: session.id, method: "confirm", title: "Continue?", requestedAt: "2026-07-21T09:00:02.000Z" },
    }));
    const restored = reconcileSnapshotAndTail(createEmptySnapshot(), incoming, [
      event(3, "interaction.resolved", { requestId: "request-1", status: "answered", response: { requestId: "request-1", confirmed: true } }),
    ]);

    expect(restored.pendingInteractions).toHaveLength(0);
    expect(restored.runStates[session.id]).toBe("running");
    expect(restored.sessions[0]?.status).toBe("running");
  });

  it("correlates parallel tool updates by tool call id", () => {
    let snapshot = createEmptySnapshot({ sessions: [session] });
    for (const [sequence, toolCallId] of [[1, "a"], [2, "b"]] as const) {
      snapshot = applyAnvilEvent(snapshot, event(sequence, "tool.started", {
        tool: {
          id: `tool-${toolCallId}`,
          kind: "tool",
          toolCallId,
          name: "unknown_tool",
          summary: `Tool ${toolCallId}`,
          status: "running",
          arguments: {},
          output: [],
          batchId: "assistant-1",
          createdAt: "2026-07-21T09:00:00.000Z",
        },
      }));
    }
    snapshot = applyAnvilEvent(snapshot, event(3, "tool.completed", { toolCallId: "b", output: [{ id: "b-result", type: "text", text: "B done" }], status: "completed" }));
    snapshot = applyAnvilEvent(snapshot, event(4, "tool.updated", { toolCallId: "a", output: [{ id: "a-progress", type: "text", text: "A running" }] }));

    const tools = snapshot.timelines[session.id].filter((entry) => entry.kind === "tool");
    expect(tools.find((tool) => tool.toolCallId === "a")?.status).toBe("running");
    expect(tools.find((tool) => tool.toolCallId === "b")?.status).toBe("completed");
  });
});
