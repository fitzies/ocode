import { describe, expect, it } from "vitest";

import { ANVIL_PROTOCOL_VERSION, decodeAnvilEvent, isAnvilEvent } from "./index";
import {
  isProjectResourceContentBlock,
  normalizeProjectResourcePath,
  resolveProjectResourceReference,
} from "./resources";

const block = {
  id: "resource-1",
  type: "projectResource" as const,
  path: "src/main.ts",
  view: "source" as const,
  line: 12,
  column: 4,
};

function completion(output: unknown[]) {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: "event-1",
    sequence: 1,
    sessionId: "session-1",
    timestamp: "2026-07-23T01:00:00.000Z",
    type: "tool.completed",
    payload: { toolCallId: "call-1", status: "completed", output },
  };
}

describe("project resource protocol", () => {
  it("validates durable blocks and enriches project identity only at the client boundary", () => {
    expect(isProjectResourceContentBlock(block)).toBe(true);
    expect(isAnvilEvent(completion([block]))).toBe(true);
    expect(resolveProjectResourceReference(block, { projectId: "project-1" })).toEqual({
      projectId: "project-1",
      path: "src/main.ts",
      view: "source",
      line: 12,
      column: 4,
    });
    expect(block).not.toHaveProperty("projectId");
    expect(isProjectResourceContentBlock({ ...block, projectId: "project-1" })).toBe(false);
  });

  it.each([
    "",
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src//main.ts",
    "C:/Windows/file.txt",
    "C:\\Windows\\file.txt",
    "bad\0path",
  ])("rejects unsafe paths: %s", (path) => {
    expect(normalizeProjectResourcePath(path)).toBeUndefined();
    expect(isProjectResourceContentBlock({ ...block, path })).toBe(false);
  });

  it.each([
    { view: "execute" },
    { line: 0 },
    { line: 1.5 },
    { column: -1 },
  ])("rejects malformed optional fields: %o", (patch) => {
    expect(isProjectResourceContentBlock({ ...block, ...patch })).toBe(false);
  });

  it("decodes malformed typed results through the generic unknown-event fallback", () => {
    const event = completion([{ ...block, line: 0 }]);
    expect(isAnvilEvent(event)).toBe(false);
    expect(decodeAnvilEvent(event)).toMatchObject({
      type: "unknown",
      payload: { eventType: "tool.completed" },
    });
  });
});
