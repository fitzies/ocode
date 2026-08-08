import type { GitHubRepositorySummary } from "@anvil/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { isValidGitHubRepository } from "@/lib/githubRepository";
import {
  appendGitHubRepositories,
  applyRepositorySelection,
  GitHubRepositorySelect,
  inferProjectNameFromRepository,
  NewProjectSourceChooser,
  NEW_PROJECT_SOURCE_OPTIONS,
  repositoryCatalogStatusText,
  RepositoryLoadMoreButton,
  repositorySelectPlaceholder,
} from "./NewProjectDialog";

describe("new project dialog", () => {
  it("starts with the three source choices in the requested order", () => {
    expect(NEW_PROJECT_SOURCE_OPTIONS.map(({ value, title }) => ({ value, title }))).toEqual([
      { value: "clone", title: "Clone a repository (GitHub)" },
      { value: "empty", title: "Start empty" },
      { value: "existing", title: "Use a Forge directory" },
    ]);
  });

  it("renders the actual accessible shadcn source chooser and Forge operation note", () => {
    const html = renderToStaticMarkup(createElement(NewProjectSourceChooser, {
      source: "clone",
      onSourceChange: () => undefined,
    }));

    expect(html.match(/role="radio"/g)).toHaveLength(3);
    for (const option of NEW_PROJECT_SOURCE_OPTIONS) {
      expect(html).toContain(option.title);
      expect(html).toContain(option.description);
      expect(html).toContain(`aria-labelledby="project-source-${option.value}-label"`);
      expect(html).toContain(`aria-describedby="project-source-${option.value}-description"`);
    }
    expect(html).toContain("aria-label=\"Project source\"");
    expect(html).toContain("Operations run on Forge, not in this browser.");
  });

  it("renders the actual shadcn repository Select states with accessible associations", () => {
    const repository: GitHubRepositorySummary = {
      nameWithOwner: "organization/private-tools",
      name: "private-tools",
      owner: "organization",
      private: true,
      updatedAt: "2026-07-23T01:00:00Z",
    };
    const loading = renderToStaticMarkup(createElement(GitHubRepositorySelect, {
      repositories: [],
      status: "loading",
      value: "",
      onValueChange: () => undefined,
      disabled: true,
      describedBy: "clone-repository-description",
    }));
    expect(loading).toContain("data-slot=\"select-trigger\"");
    expect(loading).toContain("role=\"combobox\"");
    expect(loading).toContain("Loading repositories…");
    expect(loading).toContain("aria-busy=\"true\"");
    expect(loading).toContain("aria-labelledby=\"clone-repository-label\"");
    expect(loading).toContain("aria-describedby=\"clone-repository-description\"");

    const selected = renderToStaticMarkup(createElement(GitHubRepositorySelect, {
      repositories: [repository],
      status: "ready",
      value: repository.nameWithOwner,
      onValueChange: () => undefined,
    }));
    expect(selected).toContain("organization/private-tools");
    expect(selected).toContain("Private repository");
    expect(selected).toContain("private repository");
    expect(repositorySelectPlaceholder("ready")).toBe("Choose a repository");
  });

  it("renders load-more and retry states without replacing the Select", () => {
    const ready = renderToStaticMarkup(createElement(RepositoryLoadMoreButton, {
      hasMore: true,
      status: "idle",
      onLoadMore: () => undefined,
      describedBy: "clone-repository-status",
    }));
    expect(ready).toContain("Load more repositories");
    expect(ready).toContain("data-variant=\"outline\"");
    expect(ready).toContain("aria-describedby=\"clone-repository-status\"");

    const loading = renderToStaticMarkup(createElement(RepositoryLoadMoreButton, {
      hasMore: true,
      status: "loading",
      onLoadMore: () => undefined,
    }));
    expect(loading).toContain("Loading more repositories…");
    expect(loading).toContain("aria-busy=\"true\"");
    expect(loading).toContain("disabled=\"\"");

    const retry = renderToStaticMarkup(createElement(RepositoryLoadMoreButton, {
      hasMore: true,
      status: "error",
      onLoadMore: () => undefined,
    }));
    expect(retry).toContain("Retry loading more repositories");
    expect(renderToStaticMarkup(createElement(RepositoryLoadMoreButton, {
      hasMore: false,
      status: "idle",
      onLoadMore: () => undefined,
    }))).toBe("");
  });

  it("appends and deduplicates repository pages while preserving order", () => {
    const first: GitHubRepositorySummary[] = [
      { nameWithOwner: "owner/first", owner: "owner", name: "first", private: false, updatedAt: "2026-07-23T03:00:00Z" },
      { nameWithOwner: "owner/selected", owner: "owner", name: "selected", private: true, updatedAt: "2026-07-23T02:00:00Z" },
    ];
    const second: GitHubRepositorySummary[] = [
      { ...first[1]!, updatedAt: "2026-07-23T04:00:00Z" },
      { nameWithOwner: "owner/older", owner: "owner", name: "older", private: false, updatedAt: "2026-07-22T01:00:00Z" },
    ];

    expect(appendGitHubRepositories(first, second).map(({ nameWithOwner }) => nameWithOwner)).toEqual([
      "owner/first",
      "owner/selected",
      "owner/older",
    ]);
    expect(repositoryCatalogStatusText("ready", "loading", 2, true)).toBe("Loading more repositories. 2 loaded.");
    expect(repositoryCatalogStatusText("ready", "error", 2, true)).toContain("2 repositories remain loaded");
    expect(repositoryCatalogStatusText("ready", "idle", 3, false)).toContain("All available repositories loaded");
  });

  it("infers the project name on selection until the name has been edited", () => {
    expect(applyRepositorySelection("organization/private-tools", "", false)).toEqual({
      repository: "organization/private-tools",
      name: "private-tools",
    });
    expect(applyRepositorySelection("organization/private-tools", "Internal Tools", true)).toEqual({
      repository: "organization/private-tools",
      name: "Internal Tools",
    });
  });

  it.each([
    ["owner/repository", "repository"],
    ["https://github.com/owner/ocode.git", "ocode"],
    ["git@github.com:owner/project.git", "project"],
    ["ssh://git@github.com/owner/forge", "forge"],
  ])("infers an editable project name from %s", (repository, expected) => {
    expect(inferProjectNameFromRepository(repository)).toBe(expected);
  });

  it("does not infer a name from another host or an extra GitHub path", () => {
    expect(inferProjectNameFromRepository("https://gitlab.com/owner/project")).toBeUndefined();
    expect(inferProjectNameFromRepository("https://github.com/owner/project/issues")).toBeUndefined();
  });

  it.each([
    ["owner/repository", true],
    ["https://github.com/owner/repository.git", true],
    ["git@github.com:owner/repository.git", true],
    ["ssh://git@github.com/owner/repository", true],
    ["https://github.com/owner/repository/issues", false],
    ["https://token@github.com/owner/repository", false],
    ["owner/-repository", false],
    ["not-a-repository", false],
  ])("validates repository format %s", (repository, valid) => {
    expect(isValidGitHubRepository(repository)).toBe(valid);
  });
});
