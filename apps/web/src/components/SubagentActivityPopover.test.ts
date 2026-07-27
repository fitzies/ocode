import type { ToolEntry } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { formatSubagentDuration, subagentResponse } from "./SubagentActivityPopover";

function subagent(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: "subagent-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "subagent",
    summary: "researcher agent",
    status: "running",
    arguments: { agent: "researcher", task: "Review the protocol" },
    output: [],
    createdAt: "2026-07-21T08:00:00.000Z",
    startedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

describe("subagent activity detail", () => {
  it("combines text output blocks into the Markdown response", () => {
    expect(subagentResponse(subagent({
      output: [
        { id: "one", type: "text", text: "## Result" },
        { id: "artifact", type: "artifact", artifactId: "artifact-1", mediaType: "text/plain", byteLength: 1, url: "/artifact" },
        { id: "two", type: "text", text: "- First\n- Second" },
      ],
    }))).toBe("## Result\n\n- First\n- Second");
  });

  it("formats live and completed durations", () => {
    expect(formatSubagentDuration(subagent(), Date.parse("2026-07-21T08:01:42.000Z"))).toBe("1m 42s");
    expect(formatSubagentDuration(subagent({
      status: "completed",
      endedAt: "2026-07-21T08:00:18.900Z",
    }), Date.parse("2026-07-21T09:00:00.000Z"))).toBe("18s");
    expect(formatSubagentDuration(subagent({
      status: "completed",
      endedAt: undefined,
    }), Date.parse("2026-07-21T09:00:00.000Z"))).toBeUndefined();
  });
});
