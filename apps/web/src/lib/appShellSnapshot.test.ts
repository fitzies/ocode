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
    replay: { fixtureId: "test", playing: false, cursor: 0, total: 0, speed: 1 },
    readThroughSequences: {},
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
      readThroughSequences: initial.readThroughSequences,
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
      readThroughSequences: initial.readThroughSequences,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;

    expect(equalAppShellSnapshots(backgroundSelection, selectAppShellSnapshot(activeUpdated))).toBe(false);
  });

  it("still exposes background summary changes to the sidebar", () => {
    const initial = snapshot();
    const updated = {
      ...applyAnvilEvent(initial, event(1, "session-background", "run.status", { status: "running" })),
      replay: initial.replay,
      readThroughSequences: initial.readThroughSequences,
      hydratingSessionIds: initial.hydratingSessionIds,
    } as AnvilClientSnapshot;

    expect(equalAppShellSnapshots(
      selectAppShellSnapshot(initial),
      selectAppShellSnapshot(updated),
    )).toBe(false);
  });
});
