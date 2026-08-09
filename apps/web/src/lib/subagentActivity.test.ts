import type { SubagentRun, TimelineEntry, ToolStatus } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { subagentActivityForSession } from "./subagentActivity";

const createdAt = "2026-07-21T08:00:00.000Z";

function tool(id: string, name: string, status: ToolStatus): TimelineEntry {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    name,
    summary: `${name} task`,
    status,
    arguments: { agent: "third-party", task: `Legacy ${id}` },
    output: [{ id: `${id}-output`, type: "text", text: `Result ${id}` }],
    createdAt,
  };
}

function run(id: string, status: SubagentRun["status"], parentToolCallId = `call-${id}`): SubagentRun {
  return {
    id,
    parentSessionId: "parent",
    parentToolCallId,
    childSessionId: `child-${id}`,
    role: "scout",
    status,
    taskPreview: `Durable ${id}`,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("subagentActivityForSession", () => {
  it("uses durable runs for counts and retains only unlinked generic legacy tools", () => {
    const runs = [
      run("running", "running", "linked-tool"),
      run("starting", "starting"),
      run("completed", "completed"),
      run("failed", "failed"),
      run("interrupted", "interrupted"),
      run("attention", "needs_attention"),
      run("cancelled", "cancelled"),
    ];
    const activity = subagentActivityForSession(runs, [
      tool("linked-tool", "subagent", "running"),
      tool("legacy-tool", "SUBAGENT", "completed"),
      tool("other", "bash", "completed"),
    ]);

    expect({
      active: activity.active,
      finished: activity.finished,
      failed: activity.failed,
      needsAttention: activity.needsAttention,
    }).toEqual({ active: 2, finished: 3, failed: 2, needsAttention: 1 });
    expect(activity.items.filter((item) => item.source === "legacy")).toEqual([
      expect.objectContaining({ id: "legacy:legacy-tool", result: "Result legacy-tool" }),
    ]);
    expect(activity.items.some((item) => item.id === "legacy:linked-tool")).toBe(false);
  });

  it("bounds fallback output instead of joining a full third-party child result", () => {
    const legacy = tool("legacy", "subagent", "completed");
    if (legacy.kind !== "tool") throw new Error("expected tool");
    legacy.output = [
      { id: "large", type: "text", text: "x".repeat(10_000) },
      { id: "never-needed", type: "text", text: "not included" },
    ];

    const item = subagentActivityForSession([], [legacy]).items[0];
    expect(item?.result?.length).toBeLessThanOrEqual(1_000);
    expect(item?.result).not.toContain("not included");
  });

  it("stays empty when the thread has no durable or generic subagent activity", () => {
    expect(subagentActivityForSession([], [tool("other", "bash", "completed")]))
      .toEqual({ active: 0, finished: 0, failed: 0, needsAttention: 0, items: [] });
  });
});
