import { describe, expect, it } from "vitest";

import { cycledThreadTarget, numberedThreadTarget, type NavigableThread } from "./threadNavigation";

const threads: NavigableThread[] = [
  { id: "recent-a", projectId: "a", settled: false },
  { id: "settled-a", projectId: "a", settled: true },
  { id: "recent-b", projectId: "b", settled: false },
  { id: "older-a", projectId: "a", settled: false },
];

describe("numbered thread navigation", () => {
  it("indexes the activity-ordered unsettled threads", () => {
    expect(numberedThreadTarget(threads, 0)?.id).toBe("recent-a");
    expect(numberedThreadTarget(threads, 1)?.id).toBe("recent-b");
    expect(numberedThreadTarget(threads, 2)?.id).toBe("older-a");
    expect(numberedThreadTarget(threads, 3)).toBeUndefined();
  });
});

describe("cyclic thread navigation", () => {
  it("cycles and wraps within the active project", () => {
    expect(cycledThreadTarget(threads, "a", "recent-a", "next")?.id).toBe("older-a");
    expect(cycledThreadTarget(threads, "a", "older-a", "next")?.id).toBe("recent-a");
    expect(cycledThreadTarget(threads, "a", "recent-a", "previous")?.id).toBe("older-a");
  });

  it("starts at the corresponding edge when the active thread is outside the project", () => {
    expect(cycledThreadTarget(threads, "a", "recent-b", "next")?.id).toBe("recent-a");
    expect(cycledThreadTarget(threads, "a", "recent-b", "previous")?.id).toBe("older-a");
  });

  it("does nothing without an active project or eligible thread", () => {
    expect(cycledThreadTarget(threads, undefined, "recent-a", "next")).toBeUndefined();
    expect(cycledThreadTarget(threads, "missing", "recent-a", "next")).toBeUndefined();
  });
});
