import type { SubagentRun, SubagentRunStatus } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { subagentActivityForSession } from "./subagentActivity";

const createdAt = "2026-07-21T08:00:00.000Z";

function run(id: string, status: SubagentRunStatus, startedAt = createdAt): SubagentRun {
  return {
    id,
    provider: "pi-subagents",
    workflowId: `workflow-${id}`,
    index: 0,
    key: id,
    agent: "researcher",
    status,
    startedAt,
    updatedAt: startedAt,
    transcript: [],
    receipts: [],
    capabilities: { steer: false, interrupt: false, stop: false, resume: false },
  };
}

describe("subagentActivityForSession", () => {
  it("counts active and terminal normalized child runs", () => {
    const activity = subagentActivityForSession([
      run("old", "completed", "2026-07-21T07:59:00.000Z"),
      run("running", "running", "2026-07-21T08:02:00.000Z"),
      run("queued", "queued", "2026-07-21T08:01:00.000Z"),
      run("paused", "paused", "2026-07-21T08:00:30.000Z"),
      run("completed", "completed", "2026-07-21T08:03:00.000Z"),
      run("failed", "failed", "2026-07-21T08:04:00.000Z"),
    ]);

    expect({ active: activity.active, finished: activity.finished }).toEqual({ active: 3, finished: 3 });
    expect(activity.items.map((entry) => entry.id)).toEqual([
      "running",
      "queued",
      "paused",
      "failed",
      "completed",
      "old",
    ]);
  });

  it("stays at zero when no normalized child runs exist", () => {
    expect(subagentActivityForSession([])).toEqual({ active: 0, finished: 0, items: [] });
  });
});
