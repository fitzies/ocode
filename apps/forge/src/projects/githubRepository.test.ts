import { describe, expect, it } from "vitest";

import { normalizeGitHubRepository } from "./githubRepository.ts";

describe("normalizeGitHubRepository", () => {
  it.each([
    ["owner/repository", "owner/repository"],
    ["owner/repository.git", "owner/repository"],
    ["https://github.com/owner/repository", "owner/repository"],
    ["https://github.com/owner/repository.git", "owner/repository"],
    ["git@github.com:owner/repository.git", "owner/repository"],
    ["ssh://git@github.com/owner/repository.git", "owner/repository"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeGitHubRepository(input)).toBe(expected);
  });

  it.each([
    "http://github.com/owner/repository",
    "https://gitlab.com/owner/repository",
    "https://token@github.com/owner/repository",
    "https://github.com/owner/repository?token=secret",
    "https://github.com/owner/repository#readme",
    "https://github.com/owner/repository/issues",
    "https://github.com//owner/repository",
    "git@example.com:owner/repository",
    "ssh://owner@github.com/owner/repository",
    "-owner/repository",
    "owner/-repository",
    "owner/repository/extra",
    "owner/repo\nother",
    " owner/repository",
    "owner",
  ])("rejects unsupported or malformed input %j", (input) => {
    expect(() => normalizeGitHubRepository(input)).toThrow(/valid GitHub repository/);
  });
});
