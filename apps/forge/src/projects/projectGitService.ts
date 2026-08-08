import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  ProjectGitCheck,
  ProjectGitCheckState,
  ProjectGitCommitStatus,
  ProjectGitConnectRequest,
  ProjectGitConnectResult,
  ProjectGitGeneratedMessage,
  ProjectGitLastCommit,
  ProjectGitPullRequest,
  ProjectGitPushResult,
  ProjectGitRemote,
  ProjectGitRepositoryState,
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
  remoteName: string | null;
  upstreamBranchRef: string | null;
  conflicted: boolean;
}

function safeErrorMessage(value: string, fallback: string): string {
  const redacted = value
    .replace(/:\/\/[^/@\s]+@/g, "://")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/([?&](?:access_?token|auth|password|token)=)[^&\s]+/gi, "$1[redacted]");
  return redacted.trim().slice(0, 1_000) || fallback;
}

function commandError(error: unknown, fallback: string): ProjectGitError {
  const item = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof item?.stderr === "string" ? item.stderr.trim() : "";
  const stdout = typeof item?.stdout === "string" ? item.stdout.trim() : "";
  const message = stderr || stdout || (typeof item?.message === "string" ? item.message : fallback);
  return new ProjectGitError("git_failed", safeErrorMessage(message, fallback), 500);
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

function validRemoteName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function validatedRemoteUrl(value: string): string {
  if (!value || value !== value.trim() || value.length > 2_048 || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProjectGitError("invalid_remote_url", "Remote URL is malformed");
  }
  if (value.includes("::")) throw new ProjectGitError("invalid_remote_url", "Git remote helpers are not allowed");
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value);
  if (hasScheme) {
    try {
      const url = new URL(value);
      if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) throw new Error("unsupported");
      if (url.protocol !== "file:" && !url.hostname) throw new Error("missing host");
      if (url.protocol === "file:" && !url.pathname.startsWith("/")) throw new Error("invalid file path");
    } catch {
      throw new ProjectGitError("invalid_remote_url", "Remote URL is malformed");
    }
    return value;
  }
  if (/^(?:[^@/:\s]+@)?[^/:\s]+:[^?#\s]+$/.test(value)) return value;
  if (/^(?:\/|\.\.?\/)[^\u0000-\u001f\u007f]*$/.test(value)) return value;
  throw new ProjectGitError("invalid_remote_url", "Use an HTTPS, SSH, SCP-style, or local path remote URL");
}

function safeConfiguredRemoteUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    validatedRemoteUrl(value);
    return true;
  } catch {
    return false;
  }
}

function repositoryParts(pathname: string): { owner?: string; repository?: string } {
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return {};
  const owner = parts.at(-2)!;
  const repository = parts.at(-1)!.replace(/\.git$/i, "");
  return owner && repository ? { owner, repository } : {};
}

function remoteMetadata(name: string, rawUrl: string | undefined): ProjectGitRemote {
  if (!rawUrl) return { name, url: null, provider: "other" };
  let sanitized = rawUrl.trim();
  let host: string | undefined;
  let parts: { owner?: string; repository?: string } = {};
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(sanitized)) {
    try {
      const url = new URL(sanitized);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      sanitized = url.toString();
      host = url.hostname.toLowerCase() || undefined;
      parts = repositoryParts(url.pathname);
    } catch {
      sanitized = "";
    }
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^:/\s]+):([^?#\s]+)(?:[?#].*)?$/.exec(sanitized);
    if (scp) {
      host = scp[1]!.toLowerCase();
      sanitized = `${scp[1]}:${scp[2]}`;
      parts = repositoryParts(scp[2]!);
    } else if (!sanitized.startsWith("/") && !sanitized.startsWith("./") && !sanitized.startsWith("../")) {
      sanitized = "";
    }
  }
  const provider = host === "github.com" ? "github" : "other";
  return {
    name,
    url: sanitized || null,
    provider,
    ...(host ? { host } : {}),
    ...parts,
    ...(provider === "github" && parts.owner && parts.repository
      ? { webUrl: `https://github.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repository)}` }
      : {}),
  };
}

function lastCommit(value: string | undefined): ProjectGitLastCommit | null {
  if (!value) return null;
  const [hash, shortHash, subject, authoredAt] = value.trim().split("\0");
  return hash && shortHash && subject !== undefined && authoredAt
    ? { hash, shortHash, subject, authoredAt }
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function safeWebUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function checkState(item: Record<string, unknown>): ProjectGitCheckState {
  const status = stringValue(item.status)?.toUpperCase();
  const conclusion = stringValue(item.conclusion)?.toUpperCase();
  const state = stringValue(item.state)?.toUpperCase();
  if (["QUEUED", "WAITING", "REQUESTED"].includes(status ?? "") || ["EXPECTED", "QUEUED", "WAITING", "REQUESTED"].includes(state ?? "")) return "queued";
  if (status === "IN_PROGRESS" || status === "PENDING" || state === "PENDING" || state === "IN_PROGRESS") return "running";
  const result = conclusion ?? state;
  if (result === "SUCCESS") return "passed";
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result ?? "")) return "failed";
  if (result === "CANCELLED") return "cancelled";
  if (result === "SKIPPED") return "skipped";
  if (["NEUTRAL", "STALE", "INACTIVE"].includes(result ?? "")) return "neutral";
  return "unknown";
}

function checkKind(category: string): ProjectGitCheck["kind"] {
  if (/agent|copilot|review bot/i.test(category)) return "agent";
  if (/deploy|deployment|preview|vercel|netlify|pages|railway|convex|render|cloudflare|fly\.io/i.test(category)) return "deployment";
  return "check";
}

function normalizedCheck(value: unknown): ProjectGitCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const name = stringValue(item.name) ?? stringValue(item.context);
  if (!name) return undefined;
  const app = item.app && typeof item.app === "object" && !Array.isArray(item.app)
    ? item.app as Record<string, unknown>
    : undefined;
  const workflow = stringValue(item.workflowName) ?? stringValue(app?.name);
  const category = `${workflow ?? ""} ${name}`;
  const url = safeWebUrl(item.detailsUrl) ?? safeWebUrl(item.details_url) ?? safeWebUrl(item.targetUrl) ?? safeWebUrl(item.target_url);
  const startedAt = stringValue(item.startedAt) ?? stringValue(item.started_at) ?? stringValue(item.created_at);
  const completedAt = stringValue(item.completedAt) ?? stringValue(item.completed_at);
  return {
    name,
    kind: checkKind(category),
    state: checkState(item),
    ...(url ? { url } : {}),
    ...(workflow ? { workflow } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function parseArray(output: string, label: string): unknown[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`GitHub returned an invalid ${label} response`);
  return parsed;
}

function deploymentProvider(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const login = stringValue((value as Record<string, unknown>).login)?.replace(/\[bot\]$/i, "").replace(/[-_]bot$/i, "");
  if (!login) return undefined;
  const known = /^(vercel|railway|netlify|render|convex)$/i.exec(login)?.[1];
  return known ? `${known[0]!.toUpperCase()}${known.slice(1).toLowerCase()}` : login;
}

function normalizedDeployment(deploymentValue: unknown, statusValue: unknown): ProjectGitCheck | undefined {
  if (!deploymentValue || typeof deploymentValue !== "object" || Array.isArray(deploymentValue)) return undefined;
  const deployment = deploymentValue as Record<string, unknown>;
  const hasStatus = Boolean(statusValue && typeof statusValue === "object" && !Array.isArray(statusValue));
  const status = hasStatus ? statusValue as Record<string, unknown> : {};
  const environment = stringValue(deployment.environment) ?? "Deployment";
  const provider = deploymentProvider(status.creator) ?? deploymentProvider(deployment.creator);
  const name = provider ? `${provider} · ${environment}` : environment;
  const workflow = stringValue(status.description) ?? stringValue(deployment.description) ?? stringValue(deployment.task);
  const url = safeWebUrl(status.environment_url) ?? safeWebUrl(status.target_url);
  const startedAt = stringValue(deployment.created_at);
  const state = hasStatus ? checkState(status) : "queued";
  const completedAt = ["passed", "failed", "cancelled", "skipped", "neutral"].includes(state)
    ? stringValue(status.updated_at) ?? stringValue(status.created_at)
    : undefined;
  return {
    name,
    kind: "deployment",
    state,
    ...(url ? { url } : {}),
    ...(workflow && workflow !== name ? { workflow } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(!hasStatus ? { awaitingStatus: true } : {}),
  };
}

function consolidateChecks(checks: ProjectGitCheck[]): ProjectGitCheck[] {
  const seen = new Set<string>();
  const unique = checks.filter((check) => {
    const key = `${check.kind}:${check.workflow?.toLowerCase() ?? ""}:${check.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const consumed = new Set<number>();
  const merged = new Map<number, ProjectGitCheck>();
  const priority: Record<ProjectGitCheckState, number> = {
    failed: 7,
    running: 6,
    queued: 5,
    cancelled: 4,
    unknown: 4,
    passed: 3,
    neutral: 2,
    skipped: 1,
  };
  for (const [index, check] of unique.entries()) {
    if (check.kind !== "deployment" || !check.name.includes(" · ")) continue;
    const provider = check.name.split(" · ", 1)[0]!.trim().toLowerCase();
    const matches = unique
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => candidateIndex !== index &&
        candidate.kind === "deployment" &&
        !candidate.name.includes(" · ") &&
        [candidate.name, candidate.workflow].some((value) => value?.trim().toLowerCase() === provider));
    if (matches.length === 0) continue;
    for (const match of matches) consumed.add(match.candidateIndex);
    const signals = [check, ...matches.map(({ candidate }) => candidate)];
    const authoritativeSignals = signals.filter((signal) => !signal.awaitingStatus);
    const stateSignals = authoritativeSignals.length > 0 ? authoritativeSignals : signals;
    const state = stateSignals.reduce((result, signal) => priority[signal.state] > priority[result] ? signal.state : result, stateSignals[0]!.state);
    merged.set(index, {
      ...check,
      state,
      signalCount: signals.reduce((count, signal) => count + (signal.signalCount ?? 1), 0),
      ...(authoritativeSignals.length === 0 ? { awaitingStatus: true } : { awaitingStatus: undefined }),
    });
  }
  return unique.flatMap((check, index) => consumed.has(index) ? [] : [merged.get(index) ?? check]);
}

function normalizedPullRequest(value: unknown): ProjectGitPullRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const number = typeof item.number === "number" ? item.number : undefined;
  const title = stringValue(item.title);
  const url = stringValue(item.url);
  const updatedAt = stringValue(item.updatedAt);
  const baseBranch = stringValue(item.baseRefName);
  const rawState = stringValue(item.state)?.toUpperCase();
  if (number === undefined || !title || !url || !updatedAt || !baseBranch || !["OPEN", "CLOSED", "MERGED"].includes(rawState ?? "")) return undefined;
  const checks = Array.isArray(item.statusCheckRollup)
    ? item.statusCheckRollup.map(normalizedCheck).filter((check): check is ProjectGitCheck => Boolean(check))
    : [];
  const mergeable = item.mergeable === "MERGEABLE" ? "mergeable" : item.mergeable === "CONFLICTING" ? "conflicting" : "unknown";
  const review = stringValue(item.reviewDecision)?.toUpperCase();
  const reviewDecision = review === "APPROVED"
    ? "approved"
    : review === "CHANGES_REQUESTED" ? "changes-requested" : review === "REVIEW_REQUIRED" ? "review-required" : "unknown";
  const state = rawState!.toLowerCase() as "open" | "closed" | "merged";
  const isDraft = item.isDraft === true;
  const states = checks.map((check) => check.state);
  const status = state === "merged"
    ? "merged"
    : state === "closed"
      ? "closed"
      : isDraft
        ? "draft"
        : states.includes("failed")
          ? "failed"
          : states.some((check) => check === "queued" || check === "running")
            ? "running"
            : mergeable === "conflicting" || reviewDecision === "changes-requested"
              ? "blocked"
              : checks.length > 0 && states.every((check) => ["passed", "skipped", "neutral"].includes(check))
                ? "ready"
                : "unknown";
  return { number, title, url, state, status, isDraft, mergeable, reviewDecision, baseBranch, updatedAt, checks };
}

function safeRemoteError(error: unknown): string {
  const item = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const message = (typeof item?.stderr === "string" ? item.stderr.trim() : "")
    || (typeof item?.stdout === "string" ? item.stdout.trim() : "")
    || (typeof item?.message === "string" ? item.message : "GitHub status is unavailable");
  return safeErrorMessage(message, "GitHub status is unavailable").slice(0, 500);
}

export class ProjectGitService {
  private readonly activeOperations = new Set<string>();
  private readonly githubCommitCache = new Map<string, { expiresAt: number; result: { commit: ProjectGitCommitStatus; errors: unknown[] } }>();

  constructor(
    private readonly projects: ProjectResolver,
    private readonly messages: CommitMessageGenerator,
  ) {}

  async status(projectId: string): Promise<ProjectGitStatus> {
    return this.publicStatus(await this.inspect(projectId, true));
  }

  async connect(projectId: string, input: ProjectGitConnectRequest): Promise<ProjectGitConnectResult> {
    return this.exclusive(projectId, async () => {
      const project = this.projects.resolveProject(projectId);
      if (!project) throw new ProjectGitError("project_not_found", "Project not found", 404);
      try {
        const metadata = await stat(project.path);
        if (!metadata.isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ProjectGitError("workspace_missing", "The project workspace is unavailable", 404);
      }

      const remoteName = input.remoteName ?? "origin";
      if (!validRemoteName(remoteName)) throw new ProjectGitError("invalid_remote_name", "Remote name is malformed");
      if (input.mode === "existing") validatedRemoteUrl(input.remoteUrl);
      else if (input.mode === "github") {
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
          throw new ProjectGitError("invalid_github_repository", "GitHub repository must use owner/name format");
        }
        if (input.visibility !== "private" && input.visibility !== "public") {
          throw new ProjectGitError("invalid_github_visibility", "GitHub visibility must be private or public");
        }
      }

      let initialized = false;
      const inside = await this.tryGit(project.path, ["rev-parse", "--is-inside-work-tree"]);
      if (inside?.trim() !== "true") {
        if (input.mode === "select") throw new ProjectGitError("not_a_repository", "The workspace is not a Git repository", 422);
        try {
          await this.git(project.path, ["init", "--initial-branch=main"]);
          initialized = true;
        } catch (error) {
          throw commandError(error, "Git could not initialize the workspace");
        }
      }

      const existingRemotes = (await this.tryGit(project.path, ["remote"]))?.split("\n").map((item) => item.trim()).filter(Boolean) ?? [];
      if (input.mode === "select") {
        if (!existingRemotes.includes(remoteName)) throw new ProjectGitError("remote_not_found", `Git remote '${remoteName}' does not exist`, 404);
        const selectedUrl = (await this.tryGit(project.path, ["remote", "get-url", remoteName]))?.trim();
        if (!safeConfiguredRemoteUrl(selectedUrl)) throw new ProjectGitError("unsafe_remote_url", `Git remote '${remoteName}' uses an unsupported URL`, 422);
        const branch = (await this.tryGit(project.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
        if (!branch) throw new ProjectGitError("detached_head", "Git is in detached HEAD state", 422);
        await this.git(project.path, ["config", `branch.${branch}.remote`, remoteName]);
      } else {
        if (existingRemotes.includes(remoteName)) {
          throw new ProjectGitError("remote_exists", `Git remote '${remoteName}' already exists`, 409);
        }
        if (input.mode === "existing") {
          try {
            await this.git(project.path, ["remote", "add", remoteName, input.remoteUrl]);
          } catch (error) {
            throw commandError(error, "Git could not add the remote");
          }
        } else {
          try {
            await this.gh(project.path, [
              "repo",
              "create",
              input.repository,
              input.visibility === "private" ? "--private" : "--public",
              "--source=.",
              `--remote=${remoteName}`,
            ], 120_000);
          } catch (error) {
            throw new ProjectGitError("github_create_failed", safeRemoteError(error), 502);
          }
        }
      }

      const state = await this.inspect(projectId, true);
      if (state.repositoryState !== "connected" || !state.remote) {
        throw new ProjectGitError("remote_not_connected", "The Git remote was not configured", 500);
      }
      return {
        connected: true,
        initialized,
        remote: state.remote,
        status: this.publicStatus(state),
      };
    });
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

      if (!state.branch || !state.remoteName) {
        throw new ProjectGitError(
          "push_unavailable",
          state.reason ?? "The current branch has no Git remote",
          422,
          committedHash ? { committed: true, commit: committedHash, commitMessage: committedMessage } : undefined,
        );
      }

      try {
        if (state.upstream && state.upstreamBranchRef) {
          await this.git(state.cwd, ["push", state.remoteName, `HEAD:${state.upstreamBranchRef}`], 120_000);
        } else {
          await this.git(state.cwd, ["push", "--set-upstream", state.remoteName, `HEAD:refs/heads/${state.branch}`], 120_000);
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

  private publicStatus(state: GitState): ProjectGitStatus {
    const {
      cwd: _cwd,
      hasChanges: _hasChanges,
      hasHead: _hasHead,
      head: _head,
      remoteName: _remoteName,
      upstreamBranchRef: _upstreamBranchRef,
      conflicted: _conflicted,
      ...status
    } = state;
    return status;
  }

  private async inspect(projectId: string, includeRemoteStatus = false): Promise<GitState> {
    const project = this.projects.resolveProject(projectId);
    if (!project) throw new ProjectGitError("project_not_found", "Project not found", 404);
    const timestamp = new Date().toISOString();
    const unavailable = (
      repositoryState: ProjectGitRepositoryState,
      reason: string,
      values: Partial<GitState> = {},
    ): GitState => ({
      action: "unavailable",
      branch: null,
      upstream: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      repositoryState,
      remote: null,
      lastCommit: null,
      statusUpdatedAt: timestamp,
      reason,
      cwd: project.path,
      hasChanges: false,
      hasHead: false,
      head: null,
      remoteName: null,
      upstreamBranchRef: null,
      conflicted: false,
      ...values,
    });

    try {
      const metadata = await stat(project.path);
      if (!metadata.isDirectory()) return unavailable("workspace-missing", "The project workspace is unavailable");
    } catch (error) {
      return unavailable("workspace-missing", "The project workspace is unavailable", {
        statusError: error instanceof Error ? error.message : "Workspace metadata could not be read",
      });
    }

    const inside = await this.tryGit(project.path, ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true") return unavailable("not-a-repository", "This workspace is not a Git repository");

    const head = (await this.tryGit(project.path, ["rev-parse", "--verify", "HEAD"]))?.trim() || null;
    const hasHead = Boolean(head);
    const latestCommit = hasHead
      ? lastCommit(await this.tryGit(project.path, ["show", "-s", "--format=%H%x00%h%x00%s%x00%aI", "HEAD"]))
      : null;
    const branch = (await this.tryGit(project.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
    if (!branch) {
      return unavailable("detached-head", "Git is in detached HEAD state", {
        hasHead,
        head,
        lastCommit: latestCommit,
      });
    }

    let porcelain: string;
    try {
      porcelain = await this.git(project.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    } catch (error) {
      return unavailable("connected", "Git status could not be read", {
        branch,
        hasHead,
        head,
        lastCommit: latestCommit,
        statusError: commandError(error, "Git status could not be read").message,
      });
    }
    const lines = porcelain.split("\n").filter(Boolean);
    const conflicted = lines.some((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line));
    const hasChanges = lines.length > 0;
    const upstream = hasHead
      ? (await this.tryGit(project.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim() || null
      : null;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = (await this.tryGit(project.path, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]))?.trim().split(/\s+/);
      behind = Number(counts?.[0]) || 0;
      ahead = Number(counts?.[1]) || 0;
    }
    const configuredRemote = (await this.tryGit(project.path, ["config", "--get", `branch.${branch}.remote`]))?.trim() || null;
    const upstreamBranchRef = upstream
      ? (await this.tryGit(project.path, ["config", "--get", `branch.${branch}.merge`]))?.trim() || null
      : null;
    const remotes = (await this.tryGit(project.path, ["remote"]))?.split("\n").map((item) => item.trim()).filter(Boolean) ?? [];
    const remoteEntries = await Promise.all(remotes.map(async (name) => {
      const rawUrl = (await this.tryGit(project.path, ["remote", "get-url", name]))?.trim();
      return { name, rawUrl, safe: safeConfiguredRemoteUrl(rawUrl) };
    }));
    const safeRemoteNames = remoteEntries.filter((item) => item.safe).map((item) => item.name);
    const unsafeRemoteCount = remoteEntries.length - safeRemoteNames.length;
    const remoteName = configuredRemote && configuredRemote !== "." && safeRemoteNames.includes(configuredRemote)
      ? configuredRemote
      : safeRemoteNames.includes("origin") ? "origin" : safeRemoteNames.length === 1 ? safeRemoteNames[0]! : null;
    const ambiguousRemote = !remoteName && safeRemoteNames.length > 1;
    const configuredRemotes = remoteEntries.map(({ name, rawUrl, safe }) => remoteMetadata(name, safe ? rawUrl : undefined));
    const remote = remoteName ? configuredRemotes.find((item) => item.name === remoteName) ?? null : null;
    const numstat = hasHead
      ? await this.tryGit(project.path, ["diff", "HEAD", "--numstat", "--no-ext-diff", "--"])
      : undefined;
    const { additions, deletions } = parseNumstat(numstat ?? "");

    const base: Omit<GitState, "action"> = {
      branch,
      upstream,
      additions,
      deletions,
      changedFiles: lines.length,
      ahead,
      behind,
      repositoryState: conflicted
        ? "conflicted"
        : remoteName && behind > 0 ? ahead > 0 ? "diverged" : "behind"
        : remoteName ? "connected"
        : ambiguousRemote ? "ambiguous-remote" : "no-remote",
      remote,
      remotes: configuredRemotes,
      lastCommit: latestCommit,
      statusUpdatedAt: timestamp,
      cwd: project.path,
      hasChanges,
      hasHead,
      head,
      remoteName,
      upstreamBranchRef,
      conflicted,
    };
    let state: GitState;
    if (conflicted) state = { ...base, action: "unavailable", reason: "Resolve merge conflicts before committing" };
    else if (!remoteName) {
      state = {
        ...base,
        action: "unavailable",
        reason: ambiguousRemote
          ? "Multiple Git remotes are configured and none is selected"
          : unsafeRemoteCount > 0 ? "The configured Git remote uses an unsupported URL" : "No Git remote is configured",
      };
    } else if (behind > 0) {
      state = {
        ...base,
        action: "unavailable",
        reason: ahead > 0 ? "The local and remote branches have diverged" : "Pull remote changes before committing or pushing",
      };
    } else if (hasChanges) state = { ...base, action: "commit-and-push" };
    else if (ahead > 0 || (!upstream && hasHead)) state = { ...base, action: "push" };
    else state = { ...base, action: "up-to-date" };

    if (includeRemoteStatus && remote?.provider === "github" && remote.owner && remote.repository) {
      const repository = `${remote.owner}/${remote.repository}`;
      const pushedCommit = upstream
        ? lastCommit(await this.tryGit(project.path, ["show", "-s", "--format=%H%x00%h%x00%s%x00%aI", upstream]))
        : null;
      const errors: unknown[] = [];
      let pullRequest: ProjectGitPullRequest | null = null;
      const pullRequestResult = await Promise.allSettled([
        this.gh(project.path, [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          branch,
          "--state",
          "open",
          "--limit",
          "1",
          "--json",
          "number,title,url,state,isDraft,mergeable,reviewDecision,baseRefName,updatedAt,statusCheckRollup",
        ]),
        pushedCommit
          ? this.githubCommitStatus(project.path, remote.owner, remote.repository, pushedCommit)
          : Promise.resolve({ commit: null, errors: [] }),
      ]);
      const prResponse = pullRequestResult[0];
      if (prResponse.status === "fulfilled") {
        try {
          const parsed = JSON.parse(prResponse.value) as unknown;
          if (!Array.isArray(parsed)) throw new Error("GitHub returned an invalid pull request response");
          pullRequest = normalizedPullRequest(parsed[0]) ?? null;
        } catch (error) {
          errors.push(error);
        }
      } else errors.push(prResponse.reason);
      const commitResponse = pullRequestResult[1];
      let commit: ProjectGitCommitStatus | null = null;
      if (commitResponse.status === "fulfilled") {
        commit = commitResponse.value.commit;
        errors.push(...commitResponse.value.errors);
      } else errors.push(commitResponse.reason);
      state.github = { pullRequest, commit };
      if (errors.length > 0) state.remoteStatusError = safeRemoteError(errors[0]);
    }
    return state;
  }

  private async githubCommitStatus(
    cwd: string,
    owner: string,
    repository: string,
    commit: ProjectGitLastCommit,
  ): Promise<{ commit: ProjectGitCommitStatus; errors: unknown[] }> {
    const cacheKey = `${owner.toLowerCase()}/${repository.toLowerCase()}:${commit.hash}`;
    const cached = this.githubCommitCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.githubCommitCache.delete(cacheKey);
    const errors: unknown[] = [];
    const apiRepository = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const [checkRunsResult, statusesResult, deploymentsResult] = await Promise.allSettled([
      this.githubApiItems(cwd, `${apiRepository}/commits/${commit.hash}/check-runs?per_page=100`, "check_runs", "check runs"),
      this.githubApiItems(cwd, `${apiRepository}/commits/${commit.hash}/statuses?per_page=100`, undefined, "commit statuses"),
      this.githubApiItems(cwd, `${apiRepository}/deployments?sha=${commit.hash}&per_page=100`, undefined, "deployments"),
    ]);
    const checks: ProjectGitCheck[] = [];
    if (checkRunsResult.status === "fulfilled") {
      checks.push(...checkRunsResult.value
        .map(normalizedCheck)
        .filter((check): check is ProjectGitCheck => Boolean(check)));
    } else errors.push(checkRunsResult.reason);
    if (statusesResult.status === "fulfilled") {
      checks.push(...statusesResult.value
        .map(normalizedCheck)
        .filter((check): check is ProjectGitCheck => Boolean(check)));
    } else errors.push(statusesResult.reason);

    const deployments = deploymentsResult.status === "fulfilled" ? deploymentsResult.value : [];
    if (deploymentsResult.status === "rejected") errors.push(deploymentsResult.reason);
    const latestDeployments = deployments.filter((deployment, index, values) => {
      if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) return true;
      const item = deployment as Record<string, unknown>;
      const environment = stringValue(item.environment) ?? "";
      const creator = item.creator && typeof item.creator === "object" && !Array.isArray(item.creator)
        ? stringValue((item.creator as Record<string, unknown>).login) ?? ""
        : "";
      const key = `${creator.toLowerCase()}:${environment.toLowerCase()}`;
      return values.findIndex((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const candidateItem = candidate as Record<string, unknown>;
        const candidateEnvironment = stringValue(candidateItem.environment) ?? "";
        const candidateCreator = candidateItem.creator && typeof candidateItem.creator === "object" && !Array.isArray(candidateItem.creator)
          ? stringValue((candidateItem.creator as Record<string, unknown>).login) ?? ""
          : "";
        return `${candidateCreator.toLowerCase()}:${candidateEnvironment.toLowerCase()}` === key;
      }) === index;
    });
    const deploymentResults: PromiseSettledResult<ProjectGitCheck | undefined>[] = [];
    for (let index = 0; index < latestDeployments.length; index += 4) {
      const batch = latestDeployments.slice(index, index + 4);
      deploymentResults.push(...await Promise.allSettled(batch.map(async (deployment) => {
        if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
          throw new Error("GitHub returned an invalid deployment response");
        }
        const id = (deployment as Record<string, unknown>).id;
        if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("GitHub returned an invalid deployment response");
        const output = await this.gh(cwd, ["api", `${apiRepository}/deployments/${id}/statuses?per_page=1`]);
        return normalizedDeployment(deployment, parseArray(output, "deployment status")[0]);
      })));
    }
    for (const result of deploymentResults) {
      if (result.status === "fulfilled") {
        if (result.value) checks.push(result.value);
      } else errors.push(result.reason);
    }

    const normalizedChecks = consolidateChecks(checks);
    const result = {
      commit: {
        hash: commit.hash,
        shortHash: commit.shortHash,
        subject: commit.subject,
        url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commit/${commit.hash}`,
        checks: normalizedChecks,
        complete: errors.length === 0,
      },
      errors,
    };
    const active = normalizedChecks.length === 0 || normalizedChecks.some((check) => check.state === "queued" || check.state === "running");
    if (this.githubCommitCache.size >= 100) this.githubCommitCache.delete(this.githubCommitCache.keys().next().value!);
    this.githubCommitCache.set(cacheKey, { expiresAt: Date.now() + (active || errors.length > 0 ? 5_000 : 45_000), result });
    return result;
  }

  private async githubApiItems(
    cwd: string,
    endpoint: string,
    collection: string | undefined,
    label: string,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const output = await this.gh(cwd, ["api", `${endpoint}&page=${page}`]);
      const parsed = JSON.parse(output) as unknown;
      const values = collection && parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[collection]
        : parsed;
      if (!Array.isArray(values)) throw new Error(`GitHub returned an invalid ${label} response`);
      items.push(...values);
      if (values.length < 100) return items;
    }
    throw new Error(`GitHub returned too many ${label} pages`);
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

  private async gh(cwd: string, args: string[], timeout = 15_000): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, {
      cwd,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  }
}
