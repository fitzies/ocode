import type { SubagentActivityItem } from "../lib/subagentActivity";
import { describe, expect, it } from "vitest";

import { formatSubagentDuration, subagentStatusLabel } from "./SubagentActivityPopover";

function item(overrides: Partial<SubagentActivityItem> = {}): SubagentActivityItem {
  return {
    id: "run-1",
    source: "durable",
    role: "researcher",
    status: "running",
    task: "Review the protocol",
    parentToolCallId: "call-1",
    childSessionId: "child-1",
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    startedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

describe("subagent activity presentation", () => {
  it("formats live, completed, and long durations", () => {
    expect(formatSubagentDuration(item(), Date.parse("2026-07-21T08:01:42.000Z"))).toBe("1m 42s");
    expect(formatSubagentDuration(item({
      status: "completed",
      endedAt: "2026-07-21T08:00:18.900Z",
    }), Date.parse("2026-07-21T09:00:00.000Z"))).toBe("18s");
    expect(formatSubagentDuration(item({
      status: "completed",
      endedAt: undefined,
    }), Date.parse("2026-07-21T09:00:00.000Z"))).toBeUndefined();
    expect(formatSubagentDuration(item(), Date.parse("2026-07-21T10:05:00.000Z"))).toBe("2h 5m");
  });

  it("provides explicit text for attention and interruption states", () => {
    expect(subagentStatusLabel("needs_attention")).toBe("Needs attention");
    expect(subagentStatusLabel("interrupted")).toBe("Interrupted");
    expect(subagentStatusLabel("cancelled")).toBe("Cancelled");
  });
});
