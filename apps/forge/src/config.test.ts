import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadForgeConfig } from "./config.ts";

function fixture(ownerLogin?: string) {
  const directory = mkdtempSync(join(tmpdir(), "anvil-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    ...(ownerLogin ? { ownerLogin } : {}),
    projects: [{ id: "project", name: "Project", path: directory }],
  }));
  return { directory, configPath };
}

describe("loadForgeConfig", () => {
  it("requires an owner identity unless development explicitly opts out", () => {
    const { directory, configPath } = fixture();
    try {
      expect(() => loadForgeConfig({ ANVIL_CONFIG: configPath, ANVIL_DATA_DIR: directory })).toThrow("requires ownerLogin");
      expect(loadForgeConfig({
        ANVIL_CONFIG: configPath,
        ANVIL_DATA_DIR: directory,
        ANVIL_ALLOW_UNAUTHENTICATED: "true",
      }).ownerLogin).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes project paths and refuses public binding", () => {
    const { directory, configPath } = fixture("owner@example.com");
    try {
      const config = loadForgeConfig({ ANVIL_CONFIG: configPath, ANVIL_DATA_DIR: directory });
      expect(config).toMatchObject({
        ownerLogin: "owner@example.com",
        host: "127.0.0.1",
        artifactDir: join(directory, "artifacts"),
      });
      expect(config.projects[0]?.path).toBe(directory);
      expect(() => loadForgeConfig({
        ANVIL_CONFIG: configPath,
        ANVIL_DATA_DIR: directory,
        ANVIL_HOST: "0.0.0.0",
      })).toThrow("loopback");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
