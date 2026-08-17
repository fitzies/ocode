import { describe, expect, it, vi } from "vitest";

import {
  classifyGitHubRepositoryCatalogError,
  GITHUB_REPOSITORY_MAX_PAGE,
  GitHubRepositoryCatalog,
  parseGitHubRepositoryPage,
  type GitHubRepositoryCommandRunner,
} from "./githubRepositoryCatalog.ts";

const repository = (
  fullName: string,
  updatedAt: string,
  privateRepository = false,
) => {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    private: privateRepository,
    updated_at: updatedAt,
  };
};

describe("GitHubRepositoryCatalog", () => {
  it("fetches one bounded page with non-shell gh arguments and every supported affiliation", async () => {
    const run = vi.fn<GitHubRepositoryCommandRunner>().mockResolvedValue({ stdout: "[]" });
    const catalog = new GitHubRepositoryCatalog(run);

    await expect(catalog.list(7)).resolves.toEqual({ repositories: [], page: 7, hasMore: false });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "user/repos",
        "-f",
        "per_page=100",
        "-f",
        "page=7",
        "-f",
        "sort=updated",
        "-f",
        "affiliation=owner,collaborator,organization_member",
      ],
      expect.objectContaining({
        timeout: expect.any(Number),
        maxBuffer: expect.any(Number),
        encoding: "utf8",
        killSignal: "SIGKILL",
        env: expect.objectContaining({ GH_PROMPT_DISABLED: "1" }),
      }),
    );
    const args = run.mock.calls[0]![1];
    expect(args).not.toContain("--paginate");
    expect(args).not.toContain("--slurp");
  });

  it("parses one array, ignores malformed records, deduplicates, and sorts", () => {
    const output = JSON.stringify([
      repository("owner/older", "2026-01-01T00:00:00Z"),
      repository("team/private", "2026-03-01T00:00:00Z", true),
      { full_name: "missing/fields" },
      repository("wrong/name", "not-a-date"),
      repository("owner/older", "2026-04-01T00:00:00Z"),
      repository("collaborator/recent", "2026-05-01T00:00:00Z"),
      { ...repository("owner/mismatch", "2026-06-01T00:00:00Z"), owner: { login: "someone-else" } },
    ]);

    expect(parseGitHubRepositoryPage(output, 2)).toEqual({
      repositories: [
        {
          nameWithOwner: "collaborator/recent",
          name: "recent",
          owner: "collaborator",
          private: false,
          updatedAt: "2026-05-01T00:00:00Z",
        },
        {
          nameWithOwner: "owner/older",
          name: "older",
          owner: "owner",
          private: false,
          updatedAt: "2026-04-01T00:00:00Z",
        },
        {
          nameWithOwner: "team/private",
          name: "private",
          owner: "team",
          private: true,
          updatedAt: "2026-03-01T00:00:00Z",
        },
      ],
      page: 2,
      hasMore: false,
    });
    expect(() => parseGitHubRepositoryPage("{}", 1)).toThrow("invalid github response");
    expect(() => parseGitHubRepositoryPage("not json", 1)).toThrow("invalid github response");
  });

  it("sets hasMore from the raw API page length, not the filtered result", () => {
    const rawPage = Array.from({ length: 100 }, (_, index) =>
      index === 0
        ? { malformed: true }
        : repository(`owner/repository-${index}`, `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00Z`));

    const page = parseGitHubRepositoryPage(JSON.stringify(rawPage), 1);

    expect(page.repositories).toHaveLength(99);
    expect(page.hasMore).toBe(true);
  });

  it("filters repository names on Forge and limits responses to ten matches", async () => {
    const repositories = Array.from({ length: 14 }, (_, index) =>
      repository(
        index === 13 ? "owner/unrelated" : `owner/ocode-${index}`,
        `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      ));
    const run = vi.fn<GitHubRepositoryCommandRunner>().mockResolvedValue({ stdout: JSON.stringify(repositories) });
    const catalog = new GitHubRepositoryCatalog(run);

    const result = await catalog.list(1, "OCODE");

    expect(result.repositories).toHaveLength(10);
    expect(result.repositories.every((item) => item.nameWithOwner.includes("ocode"))).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it("rejects pages outside the fixed bound before invoking gh", async () => {
    const run = vi.fn<GitHubRepositoryCommandRunner>();
    const catalog = new GitHubRepositoryCatalog(run);

    await expect(catalog.list(0)).rejects.toThrow("GitHub repository page must be an integer");
    await expect(catalog.list(GITHUB_REPOSITORY_MAX_PAGE + 1)).rejects.toThrow("GitHub repository page must be an integer");
    await expect(catalog.list(1.5)).rejects.toThrow("GitHub repository page must be an integer");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns fixed classified failures without leaking subprocess output", async () => {
    const secret = "ghp_private-secret-value";
    const failures = [
      [{ code: "ENOENT", stderr: secret }, "gh_missing", "not installed"],
      [{ code: "ETIMEDOUT", stdout: secret }, "github_timeout", "timed out"],
      [{ stderr: `authentication failed: ${secret}` }, "gh_unauthenticated", "not authenticated"],
      [{ stderr: `unexpected response ${secret}` }, "github_failed", "could not load"],
    ] as const;

    for (const [failure, code, message] of failures) {
      const classified = classifyGitHubRepositoryCatalogError(failure);
      expect(classified).toMatchObject({ code });
      expect(classified.message).toContain(message);
      expect(classified.message).not.toContain(secret);
    }

    const run = vi.fn<GitHubRepositoryCommandRunner>().mockResolvedValue({ stdout: secret });
    await expect(new GitHubRepositoryCatalog(run).list()).rejects.toMatchObject({
      code: "github_failed",
      message: "Forge could not load GitHub repositories. Try again.",
    });
  });
});
