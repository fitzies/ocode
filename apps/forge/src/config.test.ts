import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadForgeConfig, migrationDefault, migrationStateDirectory } from "./config.ts";

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
  it("prefers canonical environment variables and accepts legacy fallbacks", () => {
    const { directory, configPath } = fixture("owner@example.com");
    const canonicalData = join(directory, "canonical");
    const legacyData = join(directory, "legacy");
    try {
      const config = loadForgeConfig({
        OCODE_CONFIG: configPath,
        ANVIL_CONFIG: "/ignored/config.json",
        OCODE_DATA_DIR: canonicalData,
        ANVIL_DATA_DIR: legacyData,
        OCODE_PORT: "4321",
        ANVIL_PORT: "1234",
      });
      expect(config.port).toBe(4321);
      expect(config.databasePath).toBe(join(canonicalData, "forge.sqlite"));

      const legacy = loadForgeConfig({ ANVIL_CONFIG: configPath, ANVIL_DATA_DIR: legacyData });
      expect(legacy.databasePath).toBe(join(legacyData, "forge.sqlite"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects an existing legacy default only while the canonical path is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocode-defaults-"));
    const canonical = join(directory, "ocode");
    const legacy = join(directory, "anvil");
    try {
      expect(migrationDefault(canonical, legacy)).toBe(canonical);
      writeFileSync(legacy, "legacy");
      expect(migrationDefault(canonical, legacy)).toBe(legacy);
      writeFileSync(canonical, "canonical");
      expect(migrationDefault(canonical, legacy)).toBe(canonical);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues using populated legacy state when the canonical directory is merely empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocode-state-defaults-"));
    const canonical = join(directory, "ocode");
    const legacy = join(directory, "anvil");
    try {
      // Empty directories alone must not strand a populated legacy database.
      mkdirSync(canonical);
      mkdirSync(legacy);
      writeFileSync(join(legacy, "forge.sqlite"), "legacy");
      expect(migrationStateDirectory(canonical, legacy)).toBe(legacy);
      writeFileSync(join(canonical, "forge.sqlite"), "canonical");
      expect(migrationStateDirectory(canonical, legacy)).toBe(canonical);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      expect(config.projectsRoot).toBe(tmpdir());
      expect(() => loadForgeConfig({
        ANVIL_CONFIG: configPath,
        ANVIL_DATA_DIR: directory,
        ANVIL_HOST: "0.0.0.0",
      })).toThrow("loopback");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses an explicitly configured projects root as the runtime seed", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-projects-root-"));
    const projectsRoot = join(directory, "projects");
    const configPath = join(directory, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({
        ownerLogin: "owner@example.com",
        projectsRoot,
        projects: [{ id: "project", name: "Project", path: directory }],
      }));
      expect(loadForgeConfig({ ANVIL_CONFIG: configPath, ANVIL_DATA_DIR: directory }).projectsRoot).toBe(projectsRoot);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
