import type { SessionSummary } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import {
  projectRemovalConfirmationMatches,
  projectRemovalWarning,
  projectThreadCount,
} from "./WorkspaceDialogs";

const sessions: SessionSummary[] = [
  {
    id: "session-1",
    projectId: "project-remove",
    title: "First",
    updatedAt: "2026-07-23T01:00:00.000Z",
    status: "running",
    modelId: "test/model",
    thinkingLevel: "medium",
  },
  {
    id: "session-2",
    projectId: "project-keep",
    title: "Second",
    updatedAt: "2026-07-23T01:00:00.000Z",
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "off",
  },
];

describe("project removal dialog copy", () => {
  it("shows the real project thread count and distinguishes ocode data from workspace files", () => {
    const count = projectThreadCount("project-remove", sessions);
    const warning = projectRemovalWarning(count, 2);

    expect(count).toBe(1);
    expect(warning).toContain("Active work will be stopped");
    expect(warning).toContain("1 thread");
    expect(warning).toContain("2 terminals and their history");
    expect(warning).toContain("Workspace files remain untouched on disk");
  });

  it("requires an exact project name when threads will be removed", () => {
    expect(projectRemovalConfirmationMatches("ocode", 2, "")).toBe(false);
    expect(projectRemovalConfirmationMatches("ocode", 2, "Ocode")).toBe(false);
    expect(projectRemovalConfirmationMatches("ocode", 2, "ocode")).toBe(true);
    expect(projectRemovalConfirmationMatches("ocode", 0, "")).toBe(true);
  });
});
