import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import type { ProjectWorkspaceKind } from "@anvil/protocol";

export function workspaceKindFromGitPaths(
  insideWorkTree: string,
  gitDirectory: string,
  commonDirectory: string,
): ProjectWorkspaceKind {
  if (insideWorkTree.trim() !== "true") return "folder";
  return realpathSync(gitDirectory.trim()) === realpathSync(commonDirectory.trim())
    ? "main"
    : "worktree";
}

export function detectProjectWorkspaceKind(cwd: string): ProjectWorkspaceKind {
  try {
    const [insideWorkTree = "", gitDirectory = "", commonDirectory = ""] = execFileSync(
      "git",
      ["rev-parse", "--is-inside-work-tree", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim().split(/\r?\n/);
    if (!gitDirectory || !commonDirectory) return "folder";
    return workspaceKindFromGitPaths(insideWorkTree, gitDirectory, commonDirectory);
  } catch {
    return "folder";
  }
}
