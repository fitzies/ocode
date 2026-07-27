import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectProjectWorkspaceKind } from "./workspaceKind.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Anvil Test",
      GIT_AUTHOR_EMAIL: "anvil@example.test",
      GIT_COMMITTER_NAME: "Anvil Test",
      GIT_COMMITTER_EMAIL: "anvil@example.test",
    },
  });
}

describe("detectProjectWorkspaceKind", () => {
  it("distinguishes the main workspace, a linked worktree, and a non-Git folder", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-workspace-kind-"));
    const repository = join(directory, "repository");
    const worktree = join(directory, "linked");
    const folder = join(directory, "folder");
    mkdirSync(repository);
    mkdirSync(folder);

    try {
      git(repository, ["init"]);
      git(repository, ["commit", "--allow-empty", "-m", "initial"]);
      git(repository, ["worktree", "add", "--detach", worktree]);

      expect(detectProjectWorkspaceKind(repository)).toBe("main");
      expect(detectProjectWorkspaceKind(worktree)).toBe("worktree");
      expect(detectProjectWorkspaceKind(folder)).toBe("folder");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
