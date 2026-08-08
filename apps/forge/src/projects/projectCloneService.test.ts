import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifiedCloneError,
  GhProjectCloner,
  runProjectCloneCommand,
  type ProjectCloneCommandRunner,
} from "./projectCloneService.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocode-cloner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stagingChildren(): string[] {
  const importsPath = join(root, ".ocode-imports");
  return existsSync(importsPath)
    ? readdirSync(importsPath).filter((entry) => entry.startsWith("clone-"))
    : [];
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GhProjectCloner", () => {
  it("clones with gh into Forge-owned staging and moves it after success", async () => {
    const run = vi.fn<ProjectCloneCommandRunner>(async (_executable, args) => {
      writeFileSync(join(args[3]!, "README.md"), "cloned");
      return {};
    });
    const destination = await new GhProjectCloner(run).clone(root, "project", "owner/project");

    expect(destination).toBe(join(root, "project"));
    expect(existsSync(join(destination, "README.md"))).toBe(true);
    expect(readFileSync(join(root, ".ocode-imports", ".ocode-owned"), "utf8")).toBe("ocode project imports v1\n");
    expect(run).toHaveBeenCalledWith("gh", ["repo", "clone", "owner/project", expect.stringMatching(/\.ocode-imports\/clone-/)], expect.objectContaining({
      cwd: root,
      timeout: expect.any(Number),
      maxBuffer: expect.any(Number),
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }),
      signal: expect.any(AbortSignal),
    }));
    expect(stagingChildren()).toEqual([]);
  });

  it("cleans staging after failure without changing the final destination", async () => {
    const run: ProjectCloneCommandRunner = async () => {
      throw { stderr: "repository not found: github_pat_secretvalue" };
    };
    await expect(new GhProjectCloner(run).clone(root, "missing", "owner/missing"))
      .rejects.toThrow("GitHub could not find that repository");

    expect(existsSync(join(root, "missing"))).toBe(false);
    expect(stagingChildren()).toEqual([]);
  });

  it("never invokes gh or overwrites an existing destination", async () => {
    const destination = join(root, "existing");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "keep");
    const run = vi.fn<ProjectCloneCommandRunner>();

    await expect(new GhProjectCloner(run).clone(root, "existing", "owner/existing"))
      .rejects.toThrow("already exists");
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(destination, "keep.txt"))).toBe(true);
  });

  it("preserves an empty destination that appears while gh is running", async () => {
    const destination = join(root, "raced-empty");
    const run: ProjectCloneCommandRunner = async (_executable, args) => {
      writeFileSync(join(args[3]!, "README.md"), "staged clone");
      mkdirSync(destination);
      return {};
    };

    await expect(new GhProjectCloner(run).clone(root, "raced-empty", "owner/raced"))
      .rejects.toThrow("already exists");
    expect(readdirSync(destination)).toEqual([]);
    expect(stagingChildren()).toEqual([]);
  });

  it("preserves a non-empty destination that appears while gh is running", async () => {
    const destination = join(root, "raced");
    const run: ProjectCloneCommandRunner = async (_executable, args) => {
      writeFileSync(join(args[3]!, "README.md"), "staged clone");
      mkdirSync(destination);
      writeFileSync(join(destination, "keep.txt"), "external workspace");
      return {};
    };

    await expect(new GhProjectCloner(run).clone(root, "raced", "owner/raced"))
      .rejects.toThrow("already exists");
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("external workspace");
    expect(stagingChildren()).toEqual([]);
  });

  it("cleans only recognized stale children of a marker-verified staging root", async () => {
    const cloner = new GhProjectCloner(async (_executable, args) => {
      writeFileSync(join(args[3]!, "README.md"), "cloned");
      return {};
    });
    await cloner.clone(root, "initial", "owner/initial");

    const importsPath = join(root, ".ocode-imports");
    mkdirSync(join(importsPath, "clone-ABC123"));
    writeFileSync(join(importsPath, "clone-ABC123", "partial"), "stale");
    mkdirSync(join(importsPath, "clone-not-recognized"));
    writeFileSync(join(importsPath, "clone-ZYX987"), "not a directory");
    mkdirSync(join(root, ".ocode-clone-legacy"));

    cloner.cleanupStale(root);

    expect(existsSync(join(importsPath, "clone-ABC123"))).toBe(false);
    expect(existsSync(join(importsPath, "clone-not-recognized"))).toBe(true);
    expect(existsSync(join(importsPath, "clone-ZYX987"))).toBe(true);
    expect(existsSync(join(root, ".ocode-clone-legacy"))).toBe(true);
  });

  it("does not clean a staging directory used by an active clone", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let activeStagingPath: string | undefined;
    const cloner = new GhProjectCloner(async (_executable, args) => {
      activeStagingPath = args[3]!;
      await blocked;
      writeFileSync(join(activeStagingPath, "README.md"), "cloned");
      return {};
    });

    const clone = cloner.clone(root, "active", "owner/active");
    await waitUntil(() => activeStagingPath !== undefined);
    cloner.cleanupStale(root);

    expect(existsSync(activeStagingPath!)).toBe(true);
    release();
    await expect(clone).resolves.toBe(join(root, "active"));
  });

  it("does not clean an unmarked pre-existing staging path", () => {
    const importsPath = join(root, ".ocode-imports");
    mkdirSync(join(importsPath, "clone-ABC123"), { recursive: true });
    writeFileSync(join(importsPath, "unknown"), "keep");

    new GhProjectCloner().cleanupStale(root);

    expect(existsSync(join(importsPath, "clone-ABC123"))).toBe(true);
    expect(readFileSync(join(importsPath, "unknown"), "utf8")).toBe("keep");
  });

  it("refuses to use an unmarked pre-existing staging path", async () => {
    mkdirSync(join(root, ".ocode-imports"));
    writeFileSync(join(root, ".ocode-imports", "unknown"), "keep");
    const run = vi.fn<ProjectCloneCommandRunner>();

    await expect(new GhProjectCloner(run).clone(root, "project", "owner/project"))
      .rejects.toThrow("not an ocode-owned directory");
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(join(root, ".ocode-imports", "unknown"), "utf8")).toBe("keep");
  });

  it("does not include unknown subprocess output in a clone failure", async () => {
    const arbitrary = "remote exploded with unknown-secret-7a91 and user-controlled text";
    const cloner = new GhProjectCloner(async () => {
      throw { stderr: arbitrary, stdout: "another-secret" };
    });

    const failure = await cloner.clone(root, "failed", "owner/repository").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Forge could not clone the GitHub repository. Check the repository and try again.");
    expect((failure as Error).message).not.toContain("unknown-secret-7a91");
    expect((failure as Error).message).not.toContain("another-secret");
  });

  it("maps failures to fixed messages without exposing arbitrary subprocess output", () => {
    const arbitrary = "remote exploded with unknown-secret-7a91 and user-controlled text";
    const generic = classifiedCloneError({ stderr: arbitrary, stdout: "another-secret" });

    expect(generic).toBe("Forge could not clone the GitHub repository. Check the repository and try again.");
    expect(generic).not.toContain("unknown-secret-7a91");
    expect(generic).not.toContain("user-controlled text");
    expect(generic).not.toContain("another-secret");
    expect(classifiedCloneError({ code: "ENOENT", message: arbitrary })).toContain("not installed");
    expect(classifiedCloneError({ code: "ETIMEDOUT", stderr: arbitrary })).toContain("timed out");
    expect(classifiedCloneError({ stderr: `authentication failed ${arbitrary}` })).toContain("not authenticated");
    expect(classifiedCloneError({ stderr: `repository not found ${arbitrary}` })).toBe(
      "GitHub could not find that repository or Forge does not have access to it.",
    );
  });

  it("aborts active clone commands during shutdown", async () => {
    let commandSignal: AbortSignal | undefined;
    const run: ProjectCloneCommandRunner = async (_executable, _args, options) => {
      commandSignal = options.signal;
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("arbitrary raw error"), {
          code: "ABORT_ERR",
          killed: true,
        })), { once: true });
      });
      return {};
    };
    const cloner = new GhProjectCloner(run);
    const clone = cloner.clone(root, "interrupted", "owner/repository");
    await waitUntil(() => commandSignal !== undefined);

    await cloner.shutdown();

    expect(commandSignal?.aborted).toBe(true);
    await expect(clone).rejects.toThrow("Forge could not clone the GitHub repository");
    expect(stagingChildren()).toEqual([]);
  });
});

describe("runProjectCloneCommand", () => {
  it.each(["timeout", "abort"] as const)("kills the whole detached process group on %s", async (mode) => {
    const script = join(root, "process-group.mjs");
    const childPidPath = join(root, "child.pid");
    const childTerminatedPath = join(root, "child-terminated");
    writeFileSync(script, `
      import { existsSync, writeFileSync } from "node:fs";
      import { spawn } from "node:child_process";
      if (process.argv[2] === "child") {
        writeFileSync(process.argv[3], String(process.pid));
        process.on("SIGTERM", () => {
          writeFileSync(process.argv[4], "terminated");
        });
        setInterval(() => {}, 1000);
      } else {
        spawn(process.execPath, [process.argv[1], "child", process.argv[2], process.argv[3]], { stdio: "ignore" });
        while (!existsSync(process.argv[2])) await new Promise((resolve) => setTimeout(resolve, 5));
        setInterval(() => {}, 1000);
      }
    `);
    const controller = new AbortController();
    if (mode === "abort") setTimeout(() => controller.abort(), 500).unref();

    const command = runProjectCloneCommand(process.execPath, [script, childPidPath, childTerminatedPath], {
      cwd: root,
      timeout: mode === "timeout" ? 500 : 5_000,
      maxBuffer: 1024,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal: controller.signal,
    });
    await expect(command).rejects.toMatchObject({
      code: mode === "timeout" ? "ETIMEDOUT" : "ABORT_ERR",
      killed: true,
    });
    await waitUntil(() => existsSync(childTerminatedPath));

    const childPid = Number(readFileSync(childPidPath, "utf8"));
    await waitUntil(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
  });
});
