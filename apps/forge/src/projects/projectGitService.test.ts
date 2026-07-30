import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommitMessageGenerator, CommitMessageInput } from "../pi/commitMessageGenerator.ts";
import { ProjectGitService } from "./projectGitService.ts";

let directory: string;
let repository: string;
let remote: string;

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Anvil Test",
  GIT_AUTHOR_EMAIL: "anvil@example.test",
  GIT_COMMITTER_NAME: "Anvil Test",
  GIT_COMMITTER_EMAIL: "anvil@example.test",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" }).trim();
}

class StubGenerator implements CommitMessageGenerator {
  inputs: CommitMessageInput[] = [];

  async generate(input: CommitMessageInput): Promise<string> {
    this.inputs.push(input);
    return "Update greeting files";
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anvil-project-git-"));
  repository = join(directory, "repository");
  remote = join(directory, "remote.git");
  mkdirSync(repository);
  git(directory, ["init", "--bare", remote]);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Anvil Test"]);
  git(repository, ["config", "user.email", "anvil@example.test"]);
  writeFileSync(join(repository, "greeting.txt"), "hello\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "Initial commit"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function service(generator = new StubGenerator()): { service: ProjectGitService; generator: StubGenerator } {
  return {
    service: new ProjectGitService({
      resolveProject: (projectId) => projectId === "project-1"
        ? { id: projectId, name: "Project", path: repository }
        : undefined,
    }, generator),
    generator,
  };
}

describe("ProjectGitService", () => {
  it("distinguishes a non-repository from a repository without a remote", async () => {
    rmSync(join(repository, ".git"), { recursive: true, force: true });
    const subject = service();

    await expect(subject.service.status("project-1")).resolves.toMatchObject({
      action: "unavailable",
      repositoryState: "not-a-repository",
      branch: null,
      ahead: 0,
      behind: 0,
      remote: null,
    });

    git(repository, ["init", "--initial-branch=main"]);
    await expect(subject.service.status("project-1")).resolves.toMatchObject({
      action: "unavailable",
      repositoryState: "no-remote",
      branch: "main",
      remote: null,
    });
  });

  it("sanitizes credential-bearing remote metadata without contacting the remote", async () => {
    git(repository, ["remote", "set-url", "origin", "https://user:secret@git.example/owner/repository.git?token=hidden#fragment"]);
    const status = await service().service.status("project-1");

    expect(status).toMatchObject({
      repositoryState: "connected",
      behind: 0,
      remote: {
        name: "origin",
        url: "https://git.example/owner/repository.git",
        host: "git.example",
        owner: "owner",
        repository: "repository",
      },
      lastCommit: { subject: "Initial commit" },
    });
    expect(status.statusUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("hidden");
  });

  it("keeps local GitHub status when gh is unavailable", async () => {
    const bin = join(directory, "bin");
    const gh = join(bin, "gh");
    mkdirSync(bin);
    writeFileSync(gh, "#!/bin/sh\necho 'GitHub authentication unavailable' >&2\nexit 1\n");
    chmodSync(gh, 0o755);
    git(repository, ["remote", "set-url", "origin", "https://token@github.com/owner/repository.git"]);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const status = await service().service.status("project-1");
      expect(status).toMatchObject({
        action: "up-to-date",
        repositoryState: "connected",
        remote: {
          url: "https://github.com/owner/repository.git",
          provider: "github",
          owner: "owner",
          repository: "repository",
        },
        remoteStatusError: "GitHub authentication unavailable",
      });
      expect(JSON.stringify(status)).not.toContain("token");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("initializes Git and connects an existing bare remote", async () => {
    rmSync(join(repository, ".git"), { recursive: true, force: true });
    const subject = service();

    const result = await subject.service.connect("project-1", {
      mode: "existing",
      remoteUrl: remote,
    });

    expect(result).toMatchObject({
      connected: true,
      initialized: true,
      remote: { name: "origin", url: remote, provider: "other" },
      status: {
        repositoryState: "connected",
        branch: "main",
        remote: { name: "origin", url: remote },
      },
    });
    expect(git(repository, ["remote", "get-url", "origin"])).toBe(remote);
    await expect(subject.service.connect("project-1", {
      mode: "existing",
      remoteUrl: remote,
    })).rejects.toMatchObject({ code: "remote_exists", status: 409 });
  });

  it("rejects Git remote helpers and sanitizes SCP-style remote metadata", async () => {
    const subject = service();
    await expect(subject.service.connect("project-1", {
      mode: "existing",
      remoteName: "unsafe",
      remoteUrl: "ext::sh -c touch /tmp/unsafe",
    })).rejects.toMatchObject({ code: "invalid_remote_url" });

    git(repository, ["remote", "set-url", "origin", "ext::sh -c echo token=secret"]);
    const unsafeStatus = await subject.service.status("project-1");
    expect(unsafeStatus).toMatchObject({
      action: "unavailable",
      repositoryState: "no-remote",
      remote: null,
      remotes: [{ name: "origin", url: null }],
    });
    expect(JSON.stringify(unsafeStatus)).not.toContain("secret");

    git(repository, ["remote", "set-url", "origin", "user@github.com:owner/repository.git"]);
    const status = await subject.service.status("project-1");
    expect(status.remote).toMatchObject({
      url: "github.com:owner/repository.git",
      provider: "github",
      owner: "owner",
      repository: "repository",
    });
    expect(JSON.stringify(status)).not.toContain("user@");
  });

  it("blocks commit and push while the branch is behind", async () => {
    const other = join(directory, "other");
    git(directory, ["clone", "--branch", "main", remote, other]);
    git(other, ["config", "user.name", "Anvil Test"]);
    git(other, ["config", "user.email", "anvil@example.test"]);
    writeFileSync(join(other, "remote.txt"), "remote change\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "Remote change"]);
    git(other, ["push", "origin", "main"]);
    git(repository, ["fetch", "origin"]);
    writeFileSync(join(repository, "local.txt"), "local change\n");

    await expect(service().service.status("project-1")).resolves.toMatchObject({
      action: "unavailable",
      repositoryState: "behind",
      behind: 1,
      changedFiles: 1,
    });
  });

  it("selects one of multiple configured remotes", async () => {
    git(repository, ["remote", "rename", "origin", "alpha"]);
    git(repository, ["remote", "add", "beta", remote]);
    git(repository, ["config", "--unset", "branch.main.remote"]);
    git(repository, ["config", "--unset", "branch.main.merge"]);
    const subject = service();
    await expect(subject.service.status("project-1")).resolves.toMatchObject({
      repositoryState: "ambiguous-remote",
      remotes: [{ name: "alpha" }, { name: "beta" }],
    });

    const result = await subject.service.connect("project-1", { mode: "select", remoteName: "beta" });
    expect(result.status).toMatchObject({ repositoryState: "connected", remote: { name: "beta" } });
  });

  it("generates a message from tracked and untracked changes, commits, and pushes", async () => {
    writeFileSync(join(repository, "greeting.txt"), "hello world\n");
    writeFileSync(join(repository, "new-file.txt"), "new content\n");
    const subject = service();

    await expect(subject.service.status("project-1")).resolves.toMatchObject({
      action: "commit-and-push",
      branch: "main",
      upstream: "origin/main",
      changedFiles: 2,
    });
    const generated = await subject.service.generateMessage("project-1", "openai/test-model");
    expect(generated.message).toBe("Update greeting files");
    expect(generated.changeFingerprint).toMatch(/^[0-9a-f]{40,64}$/);
    expect(subject.generator.inputs[0]).toMatchObject({ modelId: "openai/test-model", branch: "main" });
    expect(subject.generator.inputs[0]?.summary).toContain("new-file.txt");
    expect(subject.generator.inputs[0]?.changes).toContain("new content");

    const result = await subject.service.commitAndPush("project-1", {
      message: generated.message,
      changeFingerprint: generated.changeFingerprint,
    });
    expect(result).toMatchObject({ branch: "main", message: "Update greeting files", pushed: true });
    expect(git(repository, ["status", "--porcelain"])).toBe("");
    expect(git(repository, ["log", "-1", "--format=%s"])).toBe("Update greeting files");
    expect(git(remote, ["log", "-1", "--format=%s", "main"])).toBe("Update greeting files");
  });

  it("pushes an existing local commit without generating another message", async () => {
    writeFileSync(join(repository, "greeting.txt"), "local commit\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "Existing local commit"]);
    const subject = service();

    await expect(subject.service.status("project-1")).resolves.toMatchObject({ action: "push", ahead: 1 });
    const result = await subject.service.commitAndPush("project-1", {});
    expect(result.message).toBeUndefined();
    expect(subject.generator.inputs).toHaveLength(0);
    expect(git(remote, ["log", "-1", "--format=%s", "main"])).toBe("Existing local commit");
  });

  it("rejects a commit when changes drift after message generation", async () => {
    writeFileSync(join(repository, "greeting.txt"), "first version\n");
    const subject = service();
    const generated = await subject.service.generateMessage("project-1");
    writeFileSync(join(repository, "greeting.txt"), "second version\n");

    await expect(subject.service.commitAndPush("project-1", {
      message: generated.message,
      changeFingerprint: generated.changeFingerprint,
    })).rejects.toMatchObject({ code: "workspace_changed", status: 409 });
    expect(git(repository, ["log", "-1", "--format=%s"])).toBe("Initial commit");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("restores the original index when commit creation fails", async () => {
    writeFileSync(join(repository, "greeting.txt"), "staged version\n");
    git(repository, ["add", "greeting.txt"]);
    writeFileSync(join(repository, "greeting.txt"), "unstaged version\n");
    writeFileSync(join(repository, "new-file.txt"), "untracked\n");
    const hook = join(repository, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const subject = service();
    const generated = await subject.service.generateMessage("project-1");

    await expect(subject.service.commitAndPush("project-1", {
      message: generated.message,
      changeFingerprint: generated.changeFingerprint,
    })).rejects.toMatchObject({ code: "git_failed" });
    expect(git(repository, ["show", ":greeting.txt"])).toBe("staged version");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("greeting.txt");
    expect(git(repository, ["status", "--porcelain"])).toContain("?? new-file.txt");
  });

  it("binds a generated message to the reviewed branch and HEAD", async () => {
    writeFileSync(join(repository, "greeting.txt"), "branch-sensitive change\n");
    const subject = service();
    const generated = await subject.service.generateMessage("project-1");
    git(repository, ["switch", "-c", "other"]);

    await expect(subject.service.commitAndPush("project-1", {
      message: generated.message,
      changeFingerprint: generated.changeFingerprint,
    })).rejects.toMatchObject({ code: "workspace_changed", status: 409 });
    expect(git(repository, ["branch", "--show-current"])).toBe("other");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("pushes only the current branch even when Git push config names another ref", async () => {
    git(repository, ["switch", "-c", "other"]);
    writeFileSync(join(repository, "other.txt"), "remote version\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "Create other branch"]);
    git(repository, ["push", "--set-upstream", "origin", "other"]);
    const remoteOther = git(remote, ["rev-parse", "refs/heads/other"]);
    writeFileSync(join(repository, "other.txt"), "must not be pushed\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "Local other change"]);
    git(repository, ["switch", "main"]);
    writeFileSync(join(repository, "greeting.txt"), "main branch change\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "Local main change"]);
    git(repository, ["config", "remote.origin.push", "refs/heads/other"]);
    const subject = service();

    await subject.service.commitAndPush("project-1", {});
    expect(git(remote, ["log", "-1", "--format=%s", "main"])).toBe("Local main change");
    expect(git(remote, ["rev-parse", "refs/heads/other"])).toBe(remoteOther);
  });
});
