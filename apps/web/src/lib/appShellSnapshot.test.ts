import { ANVIL_PROTOCOL_VERSION, type AnvilEvent, type SessionSummary } from "@anvil/protocol";
import { applyAnvilEvent, createEmptySnapshot } from "@anvil/state";
import { describe, expect, it } from "vitest";

import type { AnvilClientSnapshot } from "./anvilClient";
import { equalAppShellSnapshots, selectAppShellSnapshot } from "./appShellSnapshot";

const sessions: SessionSummary[] = [
  {
    id: "session-active",
    projectId: "project-1",
    title: "Active",
    updatedAt: "2026-07-24T10:00:00.000Z",
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "off",
    settled: false,
  },
  {
    id: "session-background",
    projectId: "project-1",
    title: "Background",
    updatedAt: "2026-07-24T09:00:00.000Z",
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "off",
    settled: false,
  },
];

function snapshot(): AnvilClientSnapshot {
  return {
    ...createEmptySnapshot({ sessions, activeSessionId: "session-active" }),
    workspaceLocation: { projectId: "project-1", sessionId: "session-active" },
    replay: { fixtureId: "test", playing: false, cursor: 0, total: 0, speed: 1 },
    hydratingSessionIds: [],
  };
}

function event(
  sequence: number,
  sessionId: string,
  type: AnvilEvent["type"],
  payload: unknown,
): AnvilEvent {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: `event-${sequence}`,
    sequence,
    sessionId,
    timestamp: "2026-07-24T10:00:00.000Z",
    type,
    payload,
  } as AnvilEvent;
}

describe("app shell snapshot selection", () => {
  it("ignores background detail updates while retaining active detail updates", () => {
    const initial = snapshot();
    const selected = selectAppShellSnapshot(initial);
    const backgroundUpdated = {
      ...applyAnvilEvent(initial, event(1, "session-background", "message.delta", {
        messageId: "assistant-background",
        blockId: "assistant-background-text-0",
        delta: "background output",
      })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;
    const backgroundSelection = selectAppShellSnapshot(backgroundUpdated);

    expect(backgroundUpdated.lastSequence).toBe(1);
    expect(backgroundUpdated.timelines["session-background"]).toHaveLength(1);
    expect(equalAppShellSnapshots(selected, backgroundSelection)).toBe(true);

    const activeUpdated = {
      ...applyAnvilEvent(backgroundUpdated, event(2, "session-active", "message.delta", {
        messageId: "assistant-active",
        blockId: "assistant-active-text-0",
        delta: "visible output",
      })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;

    expect(equalAppShellSnapshots(backgroundSelection, selectAppShellSnapshot(activeUpdated))).toBe(false);
  });

  it("retains loaded child timelines for the selected parent without selecting the child", () => {
    const child: SessionSummary = {
      ...sessions[0]!,
      id: "child-active",
      title: "Builder child",
      internal: true,
      parentSessionId: "session-active",
    };
    const initial = {
      ...snapshot(),
      sessions: [...sessions, child],
      timelines: { "child-active": [] },
    } as AnvilClientSnapshot;
    const selected = selectAppShellSnapshot(initial);
    const childUpdated = {
      ...applyAnvilEvent(initial, event(1, child.id, "message.delta", {
        messageId: "assistant-child",
        blockId: "assistant-child-text-0",
        delta: "visible in the side pane",
      })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;

    expect(selected.timelines[child.id]).toEqual([]);
    expect(equalAppShellSnapshots(selected, selectAppShellSnapshot(childUpdated))).toBe(false);
    expect(childUpdated.activeSessionId).toBe("session-active");
  });

  it("reacts to the selected durable subagent projection but ignores background runs", () => {
    const initial = snapshot();
    const run = {
      id: "run-1",
      parentSessionId: "session-background",
      parentToolCallId: "tool-1",
      childSessionId: "child-1",
      role: "scout" as const,
      status: "running" as const,
      taskPreview: "Inspect state",
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    const selected = selectAppShellSnapshot(initial);
    const background = {
      ...applyAnvilEvent(initial, event(1, "session-background", "subagent.updated", { run })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;
    expect(equalAppShellSnapshots(selected, selectAppShellSnapshot(background))).toBe(true);

    const active = {
      ...applyAnvilEvent(background, event(2, "session-active", "subagent.updated", {
        run: { ...run, id: "run-active", parentSessionId: "session-active", childSessionId: "child-active" },
      })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;
    expect(equalAppShellSnapshots(selectAppShellSnapshot(background), selectAppShellSnapshot(active))).toBe(false);
  });

  it("still exposes background summary changes to the sidebar", () => {
    const initial = snapshot();
    const updated = {
      ...applyAnvilEvent(initial, event(1, "session-background", "run.status", { status: "running" })),
      replay: initial.replay,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;

    expect(equalAppShellSnapshots(
      selectAppShellSnapshot(initial),
      selectAppShellSnapshot(updated),
    )).toBe(false);
  });
});
