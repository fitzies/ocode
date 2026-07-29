import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProjectSummary } from "@anvil/protocol";

export interface ForgeConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  databasePath: string;
  sessionDir: string;
  artifactDir: string;
  terminalHistoryDir?: string;
  piExecutable: string;
  piExtensionPath?: string;
  ownerLogin?: string;
  webRoot: string;
  projectsRoot: string;
  projects: ProjectSummary[];
}

interface ConfigFile {
  ownerLogin?: unknown;
  piExecutable?: unknown;
  projectsRoot?: unknown;
  projects?: unknown;
}

function configuredProjects(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) throw new Error("Forge config must contain a projects array");
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Project ${index + 1} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.name || typeof record.path !== "string") {
      throw new Error(`Project ${index + 1} requires non-empty id, name, and path`);
    }
    const path = realpathSync(resolve(record.path));
    if (!statSync(path).isDirectory()) throw new Error(`Project path is not a directory: ${path}`);
    if (ids.has(record.id)) throw new Error(`Duplicate project id: ${record.id}`);
    if (paths.has(path)) throw new Error(`Duplicate project path: ${path}`);
    ids.add(record.id);
    paths.add(path);
    return { id: record.id, name: record.name, path };
  });
}

export function loadForgeConfig(environment: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const stateDirectory = resolve(environment.ANVIL_DATA_DIR ?? join(homedir(), ".local", "state", "anvil"));
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const piExtensionPath = [
    join(moduleDirectory, "pi", "anvilInlineArtifact.ts"),
    join(moduleDirectory, "pi", "anvilInlineArtifact.js"),
  ].find(existsSync);
  if (!piExtensionPath) throw new Error("Bundled Anvil Pi extension is missing");
  const configPath = resolve(environment.ANVIL_CONFIG ?? join(homedir(), ".config", "anvil", "config.json"));
  if (!existsSync(configPath)) {
    throw new Error(`Forge config does not exist: ${configPath}`);
  }
  const file = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFile;
  const port = Number(environment.ANVIL_PORT ?? 3210);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("ANVIL_PORT must be between 1 and 65535");
  const host = environment.ANVIL_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Forge may only bind to a loopback address; expose it through Tailscale Serve");
  }
  const piExecutable = typeof file.piExecutable === "string" && file.piExecutable
    ? file.piExecutable
    : "pi";
  if (file.ownerLogin !== undefined && (typeof file.ownerLogin !== "string" || !file.ownerLogin)) {
    throw new Error("ownerLogin must be a non-empty Tailscale login when configured");
  }
  const allowUnauthenticated = environment.ANVIL_ALLOW_UNAUTHENTICATED === "true";
  if (!file.ownerLogin && !allowUnauthenticated) {
    throw new Error("Forge requires ownerLogin; set ANVIL_ALLOW_UNAUTHENTICATED=true only for loopback development");
  }
  const projects = configuredProjects(file.projects);
  if (file.projectsRoot !== undefined && (typeof file.projectsRoot !== "string" || !file.projectsRoot.trim())) {
    throw new Error("projectsRoot must be a non-empty directory path when configured");
  }
  // Runtime validation happens after Forge opens its database so a root saved
  // from the settings UI can take precedence over this configuration seed.
  const projectsRoot = resolve(
    typeof file.projectsRoot === "string"
      ? file.projectsRoot
      : projects[0] ? dirname(projects[0].path) : "/code",
  );

  return {
    host,
    port,
    databasePath: resolve(environment.ANVIL_DATABASE ?? join(stateDirectory, "forge.sqlite")),
    sessionDir: resolve(environment.ANVIL_SESSION_DIR ?? join(stateDirectory, "pi-sessions")),
    artifactDir: resolve(environment.ANVIL_ARTIFACT_DIR ?? join(stateDirectory, "artifacts")),
    terminalHistoryDir: resolve(environment.ANVIL_TERMINAL_HISTORY_DIR ?? join(stateDirectory, "terminal-history")),
    piExecutable,
    piExtensionPath,
    ownerLogin: allowUnauthenticated
      ? undefined
      : typeof file.ownerLogin === "string" ? file.ownerLogin : undefined,
    webRoot: resolve(
      environment.ANVIL_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    projectsRoot,
    projects,
  };
}

export function configDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolve(environment.ANVIL_CONFIG ?? join(homedir(), ".config", "anvil", "config.json")));
}
