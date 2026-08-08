import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const CLONE_TIMEOUT_MS = 2 * 60_000;
const CLONE_MAX_BUFFER = 16 * 1024 * 1024;
const FINALIZE_TIMEOUT_MS = 10_000;
const FINALIZE_MAX_BUFFER = 64 * 1024;
const TERMINATE_GRACE_MS = 500;
const IMPORTS_DIRECTORY = ".ocode-imports";
const IMPORTS_MARKER = ".ocode-owned";
const IMPORTS_MARKER_CONTENT = "ocode project imports v1\n";
const CLONE_DIRECTORY_PATTERN = /^clone-[A-Za-z0-9]{6}$/;

export interface ProjectCloneCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ProjectCloneCommandRunner = (
  executable: string,
  args: string[],
  options: ProjectCloneCommandOptions,
) => Promise<{ stdout?: string; stderr?: string }>;

export interface ProjectCloner {
  clone(projectsRoot: string, slug: string, repository: string): Promise<string>;
  cleanupStale?(projectsRoot: string): void;
  shutdown?(): Promise<void>;
}

export class ProjectCloneError extends Error {}

type CommandFailure = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
};

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { process.kill(pid, signal); } catch { /* The process already exited. */ }
    }
  }
}

/** Run one bounded, non-shell command in its own Linux process group. */
export const runProjectCloneCommand: ProjectCloneCommandRunner = (executable, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    const error = new Error("Command aborted") as CommandFailure;
    error.code = "ABORT_ERR";
    error.killed = true;
    reject(error);
    return;
  }

  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  let terminationError: CommandFailure | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let forceKillComplete = false;
  let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let settleClose: (code: number | null, signal: NodeJS.Signals | null) => void;

  const terminate = (error: CommandFailure) => {
    if (terminationError || settled) return;
    terminationError = error;
    error.killed = true;
    killProcessGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => {
      killProcessGroup(child.pid, "SIGKILL");
      forceKillComplete = true;
      if (closeResult) settleClose(closeResult.code, closeResult.signal);
    }, TERMINATE_GRACE_MS);
  };
  const collect = (target: Buffer[], chunk: Buffer) => {
    const remaining = options.maxBuffer - outputBytes;
    if (remaining > 0) {
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(kept);
      outputBytes += kept.byteLength;
    }
    if (chunk.byteLength > remaining) {
      const error = new Error("Command output exceeded its limit") as CommandFailure;
      error.code = "ENOBUFS";
      terminate(error);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

  const timeout = setTimeout(() => {
    const error = new Error("Command timed out") as CommandFailure;
    error.code = "ETIMEDOUT";
    terminate(error);
  }, options.timeout);
  timeout.unref();

  const abort = () => {
    const error = new Error("Command aborted") as CommandFailure;
    error.code = "ABORT_ERR";
    terminate(error);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const finish = () => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
  };
  const output = () => ({
    stdout: Buffer.concat(stdout).toString(options.encoding),
    stderr: Buffer.concat(stderr).toString(options.encoding),
  });

  child.once("error", (cause: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    finish();
    const error = new Error("Command could not start", { cause }) as CommandFailure;
    error.code = cause.code;
    Object.assign(error, output());
    reject(error);
  });
  settleClose = (code, signal) => {
    if (settled) return;
    settled = true;
    finish();
    const captured = output();
    if (!terminationError && code === 0) {
      resolve(captured);
      return;
    }
    const error = terminationError ?? new Error("Command failed") as CommandFailure;
    error.code ??= code;
    error.signal = signal;
    Object.assign(error, captured);
    reject(error);
  };
  child.once("close", (code, signal) => {
    closeResult = { code, signal };
    // Even if the direct child exits on SIGTERM, wait for the bounded grace
    // period and SIGKILL its process group so an uncooperative git descendant
    // cannot outlive a timeout or Forge shutdown.
    if (terminationError && !forceKillComplete) return;
    settleClose(code, signal);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cloneFailureText(error: unknown): string {
  const item = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [item?.stderr, item?.stdout, item?.message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

/** Classify command failures without returning subprocess output to clients. */
export function classifiedCloneError(error: unknown): string {
  const item = error as { code?: unknown; killed?: unknown };
  const text = cloneFailureText(error);
  if (item?.code === "ENOENT") {
    return "GitHub CLI is not installed on Forge. Install gh and try again.";
  }
  if (item?.code === "ABORT_ERR") {
    return "Forge could not clone the GitHub repository. Check the repository and try again.";
  }
  if (item?.code === "ETIMEDOUT" || (item?.killed && item.code === undefined) || /timed?\s*out/i.test(text)) {
    return "The GitHub clone timed out. Try again or check Forge's network connection.";
  }
  if (/auth|not logged|login required|http 401|bad credentials/i.test(text)) {
    return "Forge's GitHub CLI is not authenticated. Run gh auth login on Forge and try again.";
  }
  if (/could not resolve to a repository|repository not found|not found|permission denied|forbidden|http 403/i.test(text)) {
    return "GitHub could not find that repository or Forge does not have access to it.";
  }
  return "Forge could not clone the GitHub repository. Check the repository and try again.";
}

function markerPath(projectsRoot: string): string {
  return join(projectsRoot, IMPORTS_DIRECTORY, IMPORTS_MARKER);
}

function hasValidImportsMarkerSync(projectsRoot: string): boolean {
  const importsPath = join(projectsRoot, IMPORTS_DIRECTORY);
  try {
    return lstatSync(importsPath).isDirectory()
      && !lstatSync(importsPath).isSymbolicLink()
      && readFileSync(markerPath(projectsRoot), "utf8") === IMPORTS_MARKER_CONTENT;
  } catch {
    return false;
  }
}

async function ensureImportsDirectory(projectsRoot: string): Promise<string> {
  const importsPath = join(projectsRoot, IMPORTS_DIRECTORY);
  let created = false;
  try {
    await mkdir(importsPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (created) {
    try {
      await writeFile(markerPath(projectsRoot), IMPORTS_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
    } catch (error) {
      // A directory left unmarked by an interrupted initialization is preserved.
      throw new ProjectCloneError("Forge could not initialize its private clone staging directory.", { cause: error });
    }
  }

  try {
    const stat = await lstat(importsPath);
    const marker = await readFile(markerPath(projectsRoot), "utf8");
    if (!stat.isDirectory() || stat.isSymbolicLink() || marker !== IMPORTS_MARKER_CONTENT) throw new Error();
  } catch {
    throw new ProjectCloneError("Forge's clone staging path is not an ocode-owned directory. The existing path was not changed.");
  }
  return importsPath;
}

async function finalizeNoReplace(stagingPath: string, destination: string, projectsRoot: string, signal: AbortSignal): Promise<void> {
  let commandError: unknown;
  try {
    await runProjectCloneCommand("mv", ["--no-clobber", "--no-target-directory", stagingPath, destination], {
      cwd: projectsRoot,
      timeout: FINALIZE_TIMEOUT_MS,
      maxBuffer: FINALIZE_MAX_BUFFER,
      encoding: "utf8",
      env: process.env,
      signal,
    });
  } catch (error) {
    commandError = error;
  }

  const [sourceRemains, destinationExists] = await Promise.all([
    pathExists(stagingPath),
    pathExists(destination),
  ]);
  if (!sourceRemains && destinationExists) return;
  if (sourceRemains && destinationExists) {
    throw new ProjectCloneError(`A filesystem entry already exists at ${destination}. The existing entry was not changed.`);
  }
  throw new ProjectCloneError("Forge could not safely finalize the cloned workspace.", { cause: commandError });
}

export class GhProjectCloner implements ProjectCloner {
  private readonly activeClones = new Map<AbortController, Promise<string>>();
  private readonly activeStagingPaths = new Set<string>();
  private shuttingDown = false;

  constructor(private readonly run: ProjectCloneCommandRunner = runProjectCloneCommand) {}

  clone(projectsRoot: string, slug: string, repository: string): Promise<string> {
    if (this.shuttingDown) {
      return Promise.reject(new ProjectCloneError("Forge is shutting down and cannot start another repository clone."));
    }
    const controller = new AbortController();
    const operation = this.cloneWithSignal(projectsRoot, slug, repository, controller.signal)
      .finally(() => this.activeClones.delete(controller));
    this.activeClones.set(controller, operation);
    return operation;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.activeClones.entries()];
    for (const [controller] of active) controller.abort();
    await Promise.allSettled(active.map(([, operation]) => operation));
  }

  cleanupStale(projectsRoot: string): void {
    if (!hasValidImportsMarkerSync(projectsRoot)) return;
    const importsPath = join(projectsRoot, IMPORTS_DIRECTORY);
    let entries;
    try {
      entries = readdirSync(importsPath, { withFileTypes: true });
    } catch (error) {
      process.stderr.write(
        `[forge] Failed to inspect clone staging directory: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !CLONE_DIRECTORY_PATTERN.test(entry.name)) continue;
      const stagingPath = join(importsPath, entry.name);
      if (this.activeStagingPaths.has(stagingPath)) continue;
      try {
        rmSync(stagingPath, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(
          `[forge] Failed to clean stale clone staging directory ${entry.name}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private async cloneWithSignal(
    projectsRoot: string,
    slug: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<string> {
    const destination = join(projectsRoot, slug);
    if (await pathExists(destination)) {
      throw new ProjectCloneError(`A filesystem entry already exists at ${destination}. Choose “Use a Forge directory” to register it.`);
    }

    const importsPath = await ensureImportsDirectory(projectsRoot);
    const stagingPath = await mkdtemp(join(importsPath, "clone-"));
    this.activeStagingPaths.add(stagingPath);
    let moved = false;
    try {
      try {
        await this.run("gh", ["repo", "clone", repository, stagingPath], {
          cwd: projectsRoot,
          timeout: CLONE_TIMEOUT_MS,
          maxBuffer: CLONE_MAX_BUFFER,
          encoding: "utf8",
          env: {
            ...process.env,
            GH_PROMPT_DISABLED: "1",
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
          },
          signal,
        });
      } catch (error) {
        throw new ProjectCloneError(classifiedCloneError(error));
      }

      await finalizeNoReplace(stagingPath, destination, projectsRoot, signal);
      moved = true;
      return destination;
    } finally {
      this.activeStagingPaths.delete(stagingPath);
      if (!moved) await rm(stagingPath, { recursive: true, force: true });
    }
  }
}
