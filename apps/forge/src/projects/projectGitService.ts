import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  ProjectGitGeneratedMessage,
  ProjectGitPushResult,
  ProjectGitStatus,
} from "@anvil/protocol";

import type { CommitMessageGenerator } from "../pi/commitMessageGenerator.ts";
import type { ProjectResolver } from "./projectResolver.ts";

const execFileAsync = promisify(execFile);
const MAX_DIFF_PROMPT_CHARS = 240_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export class ProjectGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: { committed?: boolean; commit?: string; commitMessage?: string },
  ) {
    super(message);
  }
}

interface GitSnapshot {
  fingerprint: string;
  tree: string;
  summary: string;
  changes: string;
}

interface GitState extends ProjectGitStatus {
  cwd: string;
  hasChanges: boolean;
  hasHead: boolean;
  head: string | null;
  remote: string | null;
  upstreamBranchRef: string | null;
  conflicted: boolean;
}

function commandError(error: unknown, fallback: string): ProjectGitError {
  const item = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof item?.stderr === "string" ? item.stderr.trim() : "";
  const stdout = typeof item?.stdout === "string" ? item.stdout.trim() : "";
  const message = stderr || stdout || (typeof item?.message === "string" ? item.message : fallback);
  return new ProjectGitError("git_failed", message || fallback, 500);
}

function parseNumstat(value: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of value.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (added !== "-") additions += Number(added) || 0;
    if (deleted !== "-") deletions += Number(deleted) || 0;
  }
  return { additions, deletions };
}

function commitSubject(value: string): string {
  const message = value.trim();
  if (!message || message.length > 72 || /[\r\n\u0000-\u001f\u007f]/.test(message)) {
    throw new ProjectGitError("invalid_commit_message", "The generated commit message is invalid");
  }
  return message;
}

export class ProjectGitService {
  private readonly activeOperations = new Set<string>();

  constructor(
    private readonly projects: ProjectResolver,
    private readonly messages: CommitMessageGenerator,
  ) {}

  async status(projectId: string): Promise<ProjectGitStatus> {
    const state = await this.inspect(projectId);
    const {
      cwd: _cwd,
      hasChanges: _hasChanges,
      hasHead: _hasHead,
      head: _head,
      remote: _remote,
      upstreamBranchRef: _upstreamBranchRef,
      conflicted: _conflicted,
      ...status
    } = state;
    return status;
  }

  async generateMessage(projectId: string, modelId?: string): Promise<ProjectGitGeneratedMessage> {
    return this.exclusive(projectId, async () => {
      const state = await this.inspect(projectId);
      this.assertCommitable(state);
      const snapshot = await this.snapshot(state);
      let message: string;
      try {
        message = commitSubject(await this.messages.generate({
          cwd: state.cwd,
          modelId,
          branch: state.branch!,
          summary: snapshot.summary,
          changes: snapshot.changes,
        }));
      } catch (error) {
        if (error instanceof ProjectGitError) throw error;
        throw new ProjectGitError(
          "commit_message_generation_failed",
          error instanceof Error ? error.message : "Pi could not generate a commit message",
          502,
        );
      }
      return {
        branch: state.branch!,
        message,
        changeFingerprint: snapshot.fingerprint,
      };
    });
  }

  async commitAndPush(
    projectId: string,
    input: { message?: string; changeFingerprint?: string },
  ): Promise<ProjectGitPushResult> {
    return this.exclusive(projectId, async () => {
      const state = await this.inspect(projectId);
      if (state.action === "unavailable") {
        throw new ProjectGitError("git_action_unavailable", state.reason ?? "Git action is unavailable", 422);
      }
      if (state.action === "up-to-date") {
        throw new ProjectGitError("nothing_to_push", "The current branch is already up to date", 409);
      }

      let committedMessage: string | undefined;
      let committedHash: string | undefined;
      if (state.hasChanges) {
        const message = commitSubject(input.message ?? "");
        if (!input.changeFingerprint) {
          throw new ProjectGitError("missing_change_fingerprint", "Generate a commit message before committing");
        }
        const snapshot = await this.snapshot(state);
        if (snapshot.fingerprint !== input.changeFingerprint) {
          throw new ProjectGitError("workspace_changed", "Project changes changed while the commit message was being generated. Try again.", 409);
        }
        const indexBackup = await this.backupIndex(state.cwd);
        let commitCreated = false;
        try {
          await this.assertRepositoryIdentity(state);
          await this.git(state.cwd, ["add", "-A", "--"]);
          const stagedTree = (await this.git(state.cwd, ["write-tree"])).trim();
          if (stagedTree !== snapshot.tree) {
            throw new ProjectGitError("workspace_changed", "Project changes changed before they could be committed. Try again.", 409);
          }
          await this.assertRepositoryIdentity(state);
          try {
            await this.git(state.cwd, ["commit", "-m", message], 60_000);
            commitCreated = true;
          } catch (error) {
            const nextHead = (await this.tryGit(state.cwd, ["rev-parse", "--verify", "HEAD"]))?.trim() || null;
            if (nextHead && nextHead !== state.head) commitCreated = true;
            else throw commandError(error, "Git could not create the commit");
          }
        } catch (error) {
          if (!commitCreated) await this.restoreIndex(indexBackup);
          throw error;
        }
        committedMessage = message;
        try {
          committedHash = (await this.git(state.cwd, ["rev-parse", "--short", "HEAD"])).trim();
        } catch (error) {
          throw new ProjectGitError(
            "commit_created_but_status_failed",
            commandError(error, "The commit was created, but Forge could not read it").message,
            500,
            { committed: true, commitMessage: committedMessage },
          );
        }
      }

      if (!state.branch || !state.remote) {
        throw new ProjectGitError(
          "push_unavailable",
          state.reason ?? "The current branch has no Git remote",
          422,
          committedHash ? { committed: true, commit: committedHash, commitMessage: committedMessage } : undefined,
        );
      }

      try {
        if (state.upstream && state.upstreamBranchRef) {
          await this.git(state.cwd, ["push", state.remote, `HEAD:${state.upstreamBranchRef}`], 120_000);
        } else {
          await this.git(state.cwd, ["push", "--set-upstream", state.remote, `HEAD:refs/heads/${state.branch}`], 120_000);
        }
      } catch (error) {
        const detail = commandError(error, "Git could not push the current branch");
        throw new ProjectGitError(
          committedHash ? "push_failed_after_commit" : "push_failed",
          detail.message,
          502,
          committedHash ? { committed: true, commit: committedHash, commitMessage: committedMessage } : undefined,
        );
      }

      const commit = committedHash ?? (await this.git(state.cwd, ["rev-parse", "--short", "HEAD"])).trim();
      return {
        branch: state.branch,
        commit,
        ...(committedMessage ? { message: committedMessage } : {}),
        pushed: true,
      };
    });
  }

  private async exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations.has(projectId)) {
      throw new ProjectGitError("git_busy", "Another Git operation is already running for this project", 409);
    }
    this.activeOperations.add(projectId);
    try {
      return await operation();
    } finally {
      this.activeOperations.delete(projectId);
    }
  }

  private async inspect(projectId: string): Promise<GitState> {
    const project = this.projects.resolveProject(projectId);
    if (!project) throw new ProjectGitError("project_not_found", "Project not found", 404);
    const unavailable = (reason: string): GitState => ({
      action: "unavailable",
      branch: null,
      upstream: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      ahead: 0,
      reason,
      cwd: project.path,
      hasChanges: false,
      hasHead: false,
      head: null,
      remote: null,
      upstreamBranchRef: null,
      conflicted: false,
    });

    const inside = await this.tryGit(project.path, ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true") return unavailable("This workspace is not a Git repository");
    const branch = (await this.tryGit(project.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
    if (!branch) return unavailable("Git is in detached HEAD state");

    const porcelain = await this.git(project.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const lines = porcelain.split("\n").filter(Boolean);
    const conflicted = lines.some((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line));
    const hasChanges = lines.length > 0;
    const head = (await this.tryGit(project.path, ["rev-parse", "--verify", "HEAD"]))?.trim() || null;
    const hasHead = Boolean(head);
    const upstream = hasHead
      ? (await this.tryGit(project.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim() || null
      : null;
    let ahead = 0;
    if (upstream) {
      ahead = Number((await this.tryGit(project.path, ["rev-list", "--count", `${upstream}..HEAD`]))?.trim()) || 0;
    }
    const configuredRemote = (await this.tryGit(project.path, ["config", "--get", `branch.${branch}.remote`]))?.trim() || null;
    const upstreamBranchRef = upstream
      ? (await this.tryGit(project.path, ["config", "--get", `branch.${branch}.merge`]))?.trim() || null
      : null;
    const remotes = (await this.tryGit(project.path, ["remote"]))?.split("\n").map((item) => item.trim()).filter(Boolean) ?? [];
    const remote = configuredRemote && configuredRemote !== "." && remotes.includes(configuredRemote)
      ? configuredRemote
      : !upstream && remotes.includes("origin") ? "origin" : !upstream && remotes.length === 1 ? remotes[0]! : null;
    const numstat = hasHead
      ? await this.tryGit(project.path, ["diff", "HEAD", "--numstat", "--no-ext-diff", "--"])
      : undefined;
    const { additions, deletions } = parseNumstat(numstat ?? "");

    const base = {
      branch,
      upstream,
      additions,
      deletions,
      changedFiles: lines.length,
      ahead,
      cwd: project.path,
      hasChanges,
      hasHead,
      head,
      remote,
      upstreamBranchRef,
      conflicted,
    };
    if (conflicted) return { ...base, action: "unavailable", reason: "Resolve merge conflicts before committing" };
    if (!remote) return { ...base, action: "unavailable", reason: "No unambiguous Git remote is configured" };
    if (hasChanges) return { ...base, action: "commit-and-push" };
    if (ahead > 0 || (!upstream && hasHead)) return { ...base, action: "push" };
    return { ...base, action: "up-to-date" };
  }

  private assertCommitable(state: GitState): void {
    if (state.action === "unavailable") {
      throw new ProjectGitError("git_action_unavailable", state.reason ?? "Git action is unavailable", 422);
    }
    if (!state.hasChanges || state.action !== "commit-and-push") {
      throw new ProjectGitError("nothing_to_commit", "There are no project changes to commit", 409);
    }
  }

  private async snapshot(state: GitState): Promise<GitSnapshot> {
    const directory = await mkdtemp(join(tmpdir(), "anvil-git-index-"));
    const index = join(directory, "index");
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(state.cwd, state.hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], 15_000, env);
      await this.git(state.cwd, ["add", "-A", "--"], 30_000, env);
      const tree = (await this.git(state.cwd, ["write-tree"], 15_000, env)).trim();
      const fingerprint = createHash("sha256")
        .update(state.branch ?? "")
        .update("\0")
        .update(state.head ?? "")
        .update("\0")
        .update(tree)
        .digest("hex");
      const stat = await this.git(state.cwd, ["diff", "--cached", "--stat", "--no-ext-diff", "--no-textconv", "--"], 30_000, env);
      const names = await this.git(state.cwd, ["diff", "--cached", "--name-status", "--no-renames", "--no-ext-diff", "--no-textconv", "--"], 30_000, env);
      const patch = await this.git(state.cwd, ["diff", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--"], 30_000, env);
      const truncated = patch.length > MAX_DIFF_PROMPT_CHARS;
      return {
        fingerprint,
        tree,
        summary: `Change summary:\n${stat.trim()}\n\nChanged paths:\n${names.trim()}`,
        changes: `Patch${truncated ? " (truncated)" : ""}:\n${patch.slice(0, MAX_DIFF_PROMPT_CHARS)}`,
      };
    } catch (error) {
      if (error instanceof ProjectGitError) throw error;
      throw commandError(error, "Git could not inspect the proposed commit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async assertRepositoryIdentity(state: GitState): Promise<void> {
    const [branch, head] = await Promise.all([
      this.tryGit(state.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.tryGit(state.cwd, ["rev-parse", "--verify", "HEAD"]),
    ]);
    if ((branch?.trim() || null) !== state.branch || (head?.trim() || null) !== state.head) {
      throw new ProjectGitError("workspace_changed", "The checked-out branch or HEAD changed. Try again.", 409);
    }
  }

  private async backupIndex(cwd: string): Promise<{ path: string; contents?: Buffer; mode?: number }> {
    const path = (await this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    try {
      const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
      return { path, contents, mode: metadata.mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path };
      throw error;
    }
  }

  private async restoreIndex(backup: { path: string; contents?: Buffer; mode?: number }): Promise<void> {
    if (!backup.contents) {
      await rm(backup.path, { force: true });
      return;
    }
    const temporary = `${backup.path}.anvil-restore-${process.pid}-${Date.now()}`;
    await writeFile(temporary, backup.contents, { mode: backup.mode });
    await rename(temporary, backup.path);
  }

  private async tryGit(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      return await this.git(cwd, args);
    } catch {
      return undefined;
    }
  }

  private async git(
    cwd: string,
    args: string[],
    timeout = 15_000,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        ...extraEnv,
      },
    });
    return stdout;
  }
}
