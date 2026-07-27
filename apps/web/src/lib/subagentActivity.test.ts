import type { TimelineEntry, ToolStatus } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { subagentActivityForSession } from "./subagentActivity";

const createdAt = "2026-07-21T08:00:00.000Z";

function user(id: string): TimelineEntry {
  return { id, kind: "message", role: "user", content: [], status: "complete", createdAt };
}

function tool(id: string, name: string, status: ToolStatus): TimelineEntry {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    name,
    summary: name,
    status,
    arguments: {},
    output: [],
    createdAt,
  };
}

describe("subagentActivityForSession", () => {
  it("counts active and terminal subagents across the selected thread", () => {
    const entries = [
      user("old-user"),
      tool("old-subagent", "subagent", "completed"),
      user("latest-user"),
      tool("running", "subagent", "running"),
      tool("queued", "SUBAGENT", "queued"),
      tool("completed", "subagent", "completed"),
      tool("failed", "subagent", "failed"),
      tool("other", "bash", "completed"),
    ];

    const activity = subagentActivityForSession(entries);

    expect({ active: activity.active, finished: activity.finished }).toEqual({ active: 2, finished: 3 });
    expect(activity.items.map((entry) => entry.id)).toEqual([
      "running",
      "queued",
      "old-subagent",
      "completed",
      "failed",
    ]);
  });

  it("stays at zero when the thread has not used subagents", () => {
    expect(subagentActivityForSession([user("user"), tool("other", "bash", "completed")]))
      .toEqual({ active: 0, finished: 0, items: [] });
  });
});
