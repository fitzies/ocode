import type { ProjectGitStatus } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { projectGitCheckSummary, projectGitPresentation } from "./projectGitPresentation";

const clean: ProjectGitStatus = {
  action: "up-to-date",
  branch: "main",
  upstream: "origin/main",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  ahead: 0,
  repositoryState: "connected",
};

describe("project Git presentation", () => {
  it("presents local setup and publishing actions", () => {
    expect(projectGitPresentation({ ...clean, action: "unavailable", branch: null, repositoryState: "not-a-repository" }))
      .toMatchObject({ label: "Repository not connected", tone: "warning", action: "connect" });
    expect(projectGitPresentation({ ...clean, action: "commit-and-push", changedFiles: 4 }))
      .toMatchObject({ label: "main · 4 changed", action: "commit" });
    expect(projectGitPresentation({ ...clean, action: "push", ahead: 2 }))
      .toMatchObject({ label: "main · 2 ahead", action: "push" });
  });

  it("prioritizes pull request delivery status", () => {
    expect(projectGitPresentation({
      ...clean,
      github: {
        pullRequest: {
          number: 42,
          title: "Repository connection UI",
          url: "https://github.com/example/repo/pull/42",
          state: "open",
          status: "running",
          isDraft: false,
          mergeable: "mergeable",
          baseBranch: "main",
          updatedAt: "2026-01-01T00:00:00.000Z",
          checks: [],
        },
      },
    })).toMatchObject({ label: "PR #42 · Building", tone: "info", busy: true });

    expect(projectGitPresentation({
      ...clean,
      action: "commit-and-push",
      changedFiles: 2,
      github: {
        pullRequest: {
          number: 42,
          title: "Repository connection UI",
          url: "https://github.com/example/repo/pull/42",
          state: "open",
          status: "running",
          isDraft: false,
          mergeable: "mergeable",
          baseBranch: "develop",
          updatedAt: "2026-01-01T00:00:00.000Z",
          checks: [],
        },
      },
    })).toMatchObject({ label: "PR #42 · Building", action: "commit", actionLabel: "Commit & push" });
  });

  it("summarizes completed, active, and failed checks", () => {
    expect(projectGitCheckSummary([
      { name: "Lint", kind: "check", state: "passed" },
      { name: "Deploy", kind: "deployment", state: "running" },
      { name: "Tests", kind: "check", state: "failed" },
      { name: "Skipped", kind: "check", state: "skipped" },
    ])).toEqual({ passed: 2, running: 1, failed: 1, total: 4 });
  });
});
