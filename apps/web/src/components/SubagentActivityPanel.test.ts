import type { SubagentRun } from "@anvil/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatSubagentDuration,
  receiptLabel,
  SubagentActivityPanel,
  subagentDisplayNames,
  subagentResponse,
} from "./SubagentActivityPanel";

function subagent(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "subagent-1",
    provider: "pi-subagents",
    workflowId: "workflow-1",
    providerRunId: "child-1",
    index: 0,
    key: "research",
    agent: "researcher",
    task: "Review the protocol",
    status: "running",
    startedAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
    transcript: [],
    receipts: [],
    capabilities: { steer: true, interrupt: true, stop: true, resume: false },
    ...overrides,
  };
}

const controls = {
  onSteer: async () => undefined,
  onInterrupt: async () => undefined,
  onStop: async () => undefined,
  onResume: async () => undefined,
};

describe("subagent activity detail", () => {
  it("renders the scalable roster with active and completed groups", () => {
    const running = subagent({ id: "running" });
    const completed = subagent({
      id: "completed",
      status: "completed",
      endedAt: "2026-07-21T08:00:18.900Z",
      response: "Reviewed.",
      capabilities: { steer: false, interrupt: false, stop: false, resume: true },
    });
    const html = renderToStaticMarkup(createElement(SubagentActivityPanel, {
      activity: { active: 1, finished: 1, items: [running, completed] },
      controls,
    }));

    expect(html).toContain("Active");
    expect(html).toContain("Completed");
    expect(html).toContain("Researcher 1");
    expect(html).toContain("Researcher 2");
  });

  it("returns the normalized response", () => {
    expect(subagentResponse(subagent({ response: "## Result\n\n- First\n- Second" })))
      .toBe("## Result\n\n- First\n- Second");
  });

  it("keeps duplicate role labels stable by launch order", () => {
    const names = subagentDisplayNames([
      subagent({ id: "later", startedAt: "2026-07-21T08:00:03.000Z" }),
      subagent({ id: "earlier", startedAt: "2026-07-21T08:00:01.000Z" }),
    ]);

    expect(names.get("earlier")).toBe("Researcher 1");
    expect(names.get("later")).toBe("Researcher 2");
    expect(subagentDisplayNames([subagent({ id: "builder", role: "Builder", agent: "worker" })]).get("builder")).toBe("Builder");
  });

  it("describes command receipts according to the action semantics", () => {
    const base = { id: "receipt", requestedAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z" };
    expect(receiptLabel({ ...base, kind: "stop", state: "pending" })).toBe("Stop requested");
    expect(receiptLabel({ ...base, kind: "interrupt", state: "delivered" })).toBe("Agent paused");
    expect(receiptLabel({ ...base, kind: "resume", state: "delivered" })).toBe("Follow-up launched");
    expect(receiptLabel({ ...base, kind: "steer", state: "pending" })).toBe("Waiting for acknowledgement");
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
