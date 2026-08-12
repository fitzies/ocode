import type { ProjectGitStatus } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { projectGitCheckSummary, projectGitDeliveryCompletion, projectGitPresentation } from "./projectGitPresentation";

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
        commit: null,
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
        commit: null,
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
    })).toMatchObject({ label: "main · 2 changed", action: "commit", actionLabel: "Commit & push" });
  });

  it("keeps commit CI status inside the dialog instead of the header", () => {
    expect(projectGitPresentation({
      ...clean,
      github: {
        pullRequest: null,
        commit: {
          hash: "abc123",
          shortHash: "abc123",
          subject: "Ship commit delivery status",
          url: "https://github.com/example/repo/commit/abc123",
          checks: [
            { name: "CI", kind: "check", state: "passed" },
            { name: "Vercel · Production", kind: "deployment", state: "running" },
          ],
          complete: true,
        },
      },
    })).toMatchObject({ label: "main · Clean", tone: "success", busy: false });

    expect(projectGitPresentation({
      ...clean,
      github: {
        pullRequest: null,
        commit: {
          hash: "abc123",
          shortHash: "abc123",
          subject: "Ship commit delivery status",
          url: "https://github.com/example/repo/commit/abc123",
          checks: [{ name: "Railway · Production", kind: "deployment", state: "failed" }],
          complete: true,
        },
      },
    })).toMatchObject({ label: "main · Clean", tone: "success", busy: false });

    expect(projectGitPresentation({
      ...clean,
      github: {
        pullRequest: {
          number: 42,
          title: "Already ready PR",
          url: "https://github.com/example/repo/pull/42",
          state: "open",
          status: "ready",
          isDraft: false,
          mergeable: "mergeable",
          baseBranch: "main",
          updatedAt: "2026-01-01T00:00:00.000Z",
          checks: [],
        },
        commit: {
          hash: "abc123",
          shortHash: "abc123",
          subject: "Newer pushed commit",
          url: "https://github.com/example/repo/commit/abc123",
          checks: [{ name: "CI", kind: "check", state: "failed" }],
          complete: true,
        },
      },
    })).toMatchObject({ label: "main · Clean", tone: "success" });

    expect(projectGitPresentation({
      ...clean,
      github: {
        pullRequest: null,
        commit: {
          hash: "abc123",
          shortHash: "abc123",
          subject: "Skipped-only commit",
          url: "https://github.com/example/repo/commit/abc123",
          checks: [{ name: "Optional", kind: "check", state: "skipped" }],
          complete: true,
        },
      },
    })).toMatchObject({ label: "main · Clean", tone: "success" });
  });

  it("summarizes completed, active, and failed checks", () => {
    expect(projectGitCheckSummary([
      { name: "Lint", kind: "check", state: "passed" },
      { name: "Deploy", kind: "deployment", state: "running" },
      { name: "Tests", kind: "check", state: "failed" },
      { name: "Skipped", kind: "check", state: "skipped" },
    ])).toEqual({ passed: 1, running: 1, failed: 1, total: 4 });
  });

  it("marks partial failures as terminal delivery outcomes", () => {
    expect(projectGitDeliveryCompletion([
      { name: "Build", kind: "check", state: "passed" },
      { name: "Lint", kind: "check", state: "passed" },
      { name: "Deploy", kind: "deployment", state: "passed" },
      { name: "E2E", kind: "check", state: "failed" },
    ])).toEqual({ passed: 3, running: 0, failed: 1, total: 4, terminal: true, hasIssues: true });
    expect(projectGitDeliveryCompletion([
      { name: "Build", kind: "check", state: "passed" },
      { name: "Deploy", kind: "deployment", state: "running" },
    ])).toMatchObject({ passed: 1, total: 2, terminal: false, hasIssues: false });
  });
});
