import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSummary } from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommitMessageGenerator, CommitMessageInput } from "../pi/commitMessageGenerator.ts";
import { ProjectGitService } from "../projects/projectGitService.ts";
import { EventProjectResolver } from "../projects/projectResolver.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ForgeHttpServer } from "./server.ts";

let directory: string;
let repository: string;
let remote: string;
let database: ForgeDatabase;
let server: ForgeHttpServer;
let baseUrl: string;
let generator: StubGenerator;
const ownerHeaders = { "tailscale-user-login": "owner@example.com" };

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
  input?: CommitMessageInput;

  async generate(input: CommitMessageInput): Promise<string> {
    this.input = input;
    return "Update project Git action";
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-git-routes-"));
  repository = join(directory, "repository");
  remote = join(directory, "remote.git");
  mkdirSync(repository);
  git(directory, ["init", "--bare", remote]);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Anvil Test"]);
  git(repository, ["config", "user.email", "anvil@example.test"]);
  writeFileSync(join(repository, "file.txt"), "initial\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "Initial commit"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "--set-upstream", "origin", "main"]);
  writeFileSync(join(repository, "file.txt"), "changed\n");

  database = new ForgeDatabase(":memory:");
  const events = new ForgeEventService(database, [{ id: "project-1", name: "Project", path: repository }]);
  const session: SessionSummary = {
    id: "session-1",
    projectId: "project-1",
    title: "Git work",
    updatedAt: "2026-07-23T01:00:00.000Z",
    status: "idle",
    modelId: "openai/test-model",
    thinkingLevel: "low",
  };
  events.createSession(session, {
    sessionId: session.id,
    timestamp: session.updatedAt,
    type: "session.upserted",
    payload: { session },
  });
  generator = new StubGenerator();
  const projectGit = new ProjectGitService(new EventProjectResolver(events), generator);
  server = new ForgeHttpServer({ events, projectGit, ownerLogin: "owner@example.com" });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("project Git HTTP routes", () => {
  it("requires owner authentication and rejects cross-origin mutations", async () => {
    expect((await fetch(`${baseUrl}/api/v1/projects/project-1/git/status`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/v1/projects/project-1/git/status`, { headers: ownerHeaders })).status).toBe(200);
    const rejected = await fetch(`${baseUrl}/api/v1/projects/project-1/git/generate-message`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(rejected.status).toBe(403);
  });

  it("validates connect requests and connects an existing bare remote", async () => {
    const invalid = await fetch(`${baseUrl}/api/v1/projects/project-1/git/connect`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ mode: "existing" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_remote_url" });

    git(repository, ["remote", "remove", "origin"]);
    const disconnected = await fetch(`${baseUrl}/api/v1/projects/project-1/git/status`, { headers: ownerHeaders });
    expect(await disconnected.json()).toMatchObject({ repositoryState: "no-remote", remote: null });

    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/git/connect`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ mode: "existing", remoteUrl: remote }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: true,
      initialized: false,
      remote: { name: "origin", url: remote, provider: "other" },
      status: { repositoryState: "connected", branch: "main" },
    });
    expect(git(repository, ["remote", "get-url", "origin"])).toBe(remote);
  });

  it("uses the active session model without exposing a client-selected model id", async () => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/git/generate-message`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branch: "main", message: "Update project Git action" });
    expect(generator.input?.modelId).toBe("openai/test-model");

    const missing = await fetch(`${baseUrl}/api/v1/projects/project-1/git/generate-message`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "other-session" }),
    });
    expect(missing.status).toBe(404);
  });

  it("reports a committed local change when the subsequent push fails", async () => {
    const generatedResponse = await fetch(`${baseUrl}/api/v1/projects/project-1/git/generate-message`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    const generated = await generatedResponse.json() as { message: string; changeFingerprint: string };
    rmSync(remote, { recursive: true, force: true });

    const response = await fetch(`${baseUrl}/api/v1/projects/project-1/git/commit-and-push`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify(generated),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "push_failed_after_commit",
      committed: true,
      commitMessage: "Update project Git action",
    });
  });
});
