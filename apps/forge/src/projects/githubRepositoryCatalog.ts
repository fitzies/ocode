import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  isGitHubRepositorySummary,
  type GitHubRepositoryPage,
  type GitHubRepositorySummary,
} from "@anvil/protocol";

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BUFFER = 8 * 1024 * 1024;
export const GITHUB_REPOSITORY_PAGE_SIZE = 100;
export const GITHUB_REPOSITORY_MAX_PAGE = 10_000;
export const GITHUB_REPOSITORY_PAGE_ERROR =
  `GitHub repository page must be an integer between 1 and ${GITHUB_REPOSITORY_MAX_PAGE}.`;

export function isValidGitHubRepositoryPageNumber(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= GITHUB_REPOSITORY_MAX_PAGE;
}

export function githubRepositoryApiArgs(page: number): string[] {
  if (!isValidGitHubRepositoryPageNumber(page)) throw new RangeError(GITHUB_REPOSITORY_PAGE_ERROR);
  return [
    "api",
    "--method",
    "GET",
    "user/repos",
    "-f",
    `per_page=${GITHUB_REPOSITORY_PAGE_SIZE}`,
    "-f",
    `page=${page}`,
    "-f",
    "sort=updated",
    "-f",
    "affiliation=owner,collaborator,organization_member",
  ];
}

export interface GitHubRepositoryCommandOptions {
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  killSignal: "SIGKILL";
  env: NodeJS.ProcessEnv;
}

export type GitHubRepositoryCommandRunner = (
  executable: string,
  args: string[],
  options: GitHubRepositoryCommandOptions,
) => Promise<{ stdout: string; stderr?: string }>;

const runCommand: GitHubRepositoryCommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, options);
  return { stdout: result.stdout, stderr: result.stderr };
};

export type GitHubRepositoryCatalogErrorCode =
  | "gh_missing"
  | "gh_unauthenticated"
  | "github_timeout"
  | "github_failed";

export class GitHubRepositoryCatalogError extends Error {
  constructor(
    readonly code: GitHubRepositoryCatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function commandFailureText(error: unknown): string {
  const failure = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [failure?.stderr, failure?.stdout, failure?.message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

/** Classify gh failures without returning command output or credentials to clients. */
export function classifyGitHubRepositoryCatalogError(error: unknown): GitHubRepositoryCatalogError {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
  const text = commandFailureText(error);
  if (failure?.code === "ENOENT") {
    return new GitHubRepositoryCatalogError(
      "gh_missing",
      "GitHub CLI is not installed on Forge. Install gh and try again.",
    );
  }
  if (
    failure?.code === "ETIMEDOUT" ||
    (failure?.killed === true && failure?.signal === "SIGKILL") ||
    /timed?\s*out/i.test(text)
  ) {
    return new GitHubRepositoryCatalogError(
      "github_timeout",
      "The GitHub repository request timed out. Try again.",
    );
  }
  if (/auth|not logged|login required|http 401|bad credentials|authentication token/i.test(text)) {
    return new GitHubRepositoryCatalogError(
      "gh_unauthenticated",
      "Forge's GitHub CLI is not authenticated. Run gh auth login on Forge and try again.",
    );
  }
  return new GitHubRepositoryCatalogError(
    "github_failed",
    "Forge could not load GitHub repositories. Try again.",
  );
}

function parseRecord(value: unknown): GitHubRepositorySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ownerRecord = record.owner;
  if (!ownerRecord || typeof ownerRecord !== "object" || Array.isArray(ownerRecord)) return undefined;
  const repository = {
    nameWithOwner: record.full_name,
    name: record.name,
    owner: (ownerRecord as Record<string, unknown>).login,
    private: record.private,
    updatedAt: record.updated_at,
  };
  return isGitHubRepositorySummary(repository) ? repository : undefined;
}

/** Parse one gh API page, ignoring malformed repository records. */
export function parseGitHubRepositoryPage(output: string, page: number): GitHubRepositoryPage {
  if (!isValidGitHubRepositoryPageNumber(page)) throw new RangeError(GITHUB_REPOSITORY_PAGE_ERROR);
  let values: unknown;
  try {
    values = JSON.parse(output);
  } catch {
    throw new Error("invalid github response");
  }
  if (!Array.isArray(values)) throw new Error("invalid github response");

  const repositories = new Map<string, GitHubRepositorySummary>();
  for (const value of values) {
    const repository = parseRecord(value);
    if (!repository) continue;
    const key = repository.nameWithOwner.toLowerCase();
    const existing = repositories.get(key);
    if (!existing || Date.parse(repository.updatedAt) > Date.parse(existing.updatedAt)) {
      repositories.set(key, repository);
    }
  }

  return {
    repositories: [...repositories.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.nameWithOwner.localeCompare(right.nameWithOwner),
    ),
    page,
    hasMore: values.length === GITHUB_REPOSITORY_PAGE_SIZE,
  };
}

export class GitHubRepositoryCatalog {
  constructor(private readonly run: GitHubRepositoryCommandRunner = runCommand) {}

  list = async (page = 1): Promise<GitHubRepositoryPage> => {
    const args = githubRepositoryApiArgs(page);
    try {
      const { stdout } = await this.run("gh", args, {
        timeout: CATALOG_TIMEOUT_MS,
        maxBuffer: CATALOG_MAX_BUFFER,
        encoding: "utf8",
        killSignal: "SIGKILL",
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      return parseGitHubRepositoryPage(stdout, page);
    } catch (error) {
      if (error instanceof GitHubRepositoryCatalogError) throw error;
      throw classifyGitHubRepositoryCatalogError(error);
    }
  };
}
