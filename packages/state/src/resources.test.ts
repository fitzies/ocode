import { ANVIL_PROTOCOL_VERSION, type AnvilEvent } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { applyAnvilEvent, createEmptySnapshot } from "./index";

it("preserves project resource blocks through durable tool completion state", () => {
  const started: AnvilEvent = {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: "event-1",
    sequence: 1,
    sessionId: "session-1",
    timestamp: "2026-07-23T01:00:00.000Z",
    type: "tool.started",
    payload: {
      tool: {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        name: "anvil_open_file",
        summary: "Open file",
        status: "running",
        arguments: { path: "src/main.ts" },
        output: [],
        createdAt: "2026-07-23T01:00:00.000Z",
      },
    },
  };
  const completed: AnvilEvent = {
    ...started,
    id: "event-2",
    sequence: 2,
    type: "tool.completed",
    payload: {
      toolCallId: "call-1",
      status: "completed",
      output: [{ id: "resource-1", type: "projectResource", path: "src/main.ts", line: 4 }],
    },
  };
  let snapshot = applyAnvilEvent(createEmptySnapshot(), started);
  snapshot = applyAnvilEvent(snapshot, completed);

  expect(snapshot.timelines["session-1"]).toEqual([
    expect.objectContaining({
      status: "completed",
      output: [{ id: "resource-1", type: "projectResource", path: "src/main.ts", line: 4 }],
    }),
  ]);
});
