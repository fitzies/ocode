import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceFileIndex } from "./workspaceFiles.ts";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("WorkspaceFileIndex", () => {
  it("returns fuzzy project-relative paths including hidden files", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-files-"));
    mkdirSync(join(directory, "apps", "web", "src", "components"), { recursive: true });
    mkdirSync(join(directory, ".pi"), { recursive: true });
    mkdirSync(join(directory, ".git"), { recursive: true });
    writeFileSync(join(directory, "apps", "web", "src", "components", "Composer.tsx"), "export {};");
    writeFileSync(join(directory, ".pi", "settings.json"), "{}");
    writeFileSync(join(directory, ".git", "config"), "secret");

    const index = new WorkspaceFileIndex();
    expect(await index.search(directory, "cmp", 10)).toContain("apps/web/src/components/Composer.tsx");
    expect(await index.search(directory, "settings", 10)).toContain(".pi/settings.json");
    expect(await index.search(directory, "config", 10)).not.toContain(".git/config");
  });
});
