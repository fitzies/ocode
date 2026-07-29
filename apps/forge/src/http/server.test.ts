import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANVIL_PROTOCOL_VERSION,
  isAnvilBootstrap,
  isAnvilSessionDetailSync,
  isAnvilSummaryBootstrap,
  type AnvilCommandResponse,
  type SessionSummary,
} from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../artifacts/artifactStore.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { canonicalizeProjectsRoot } from "../projects/projectsRoot.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ForgeHttpServer } from "./server.ts";

let database: ForgeDatabase;
let events: ForgeEventService;
let server: ForgeHttpServer;
let artifacts: ArtifactStore;
let artifactDirectory: string;
let baseUrl: string;

beforeEach(async () => {
  database = new ForgeDatabase(":memory:");
  artifactDirectory = mkdtempSync(join(tmpdir(), "anvil-http-artifacts-"));
  artifacts = new ArtifactStore(artifactDirectory, 32);
  events = new ForgeEventService(database, [{ id: "anvil", name: "Anvil", path: "/repo" }], artifacts);
  server = new ForgeHttpServer({ events, artifacts });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.close();
  database.close();
  rmSync(artifactDirectory, { recursive: true, force: true });
});

describe("ForgeHttpServer", () => {
  it("serves a protocol bootstrap with its global cursor", async () => {
    events.append([{
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "connection.changed",
      payload: { connection: "connected" },
    }]);
    const response = await fetch(`${baseUrl}/api/v1/bootstrap`);
    const bootstrap: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(isAnvilBootstrap(bootstrap)).toBe(true);
    expect(bootstrap).toMatchObject({ cursor: 1, snapshot: { lastSequence: 1 } });
  });

  it("serves lightweight summaries and sequence-based thread details", async () => {
    const session: SessionSummary = {
      id: "session-1",
      projectId: "anvil",
      title: "Cached thread",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "medium",
    };
    events.createSession(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });
    events.append([{
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          content: [],
          status: "streaming",
          createdAt: "2026-07-23T01:00:01.000Z",
        },
      },
    }]);

    const summaryResponse = await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { accept: "application/vnd.anvil.summary+json" },
    });
    const summary: unknown = await summaryResponse.json();
    expect(isAnvilSummaryBootstrap(summary)).toBe(true);
    expect(summary).toMatchObject({ cursor: 2, sessions: [{ id: session.id }] });
    expect(summary).not.toHaveProperty("snapshot");

    const deltaResponse = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/detail?after=1`);
    const delta: unknown = await deltaResponse.json();
    expect(isAnvilSessionDetailSync(delta)).toBe(true);
    expect(delta).toMatchObject({ mode: "delta", fromSequence: 1, throughSequence: 2 });
    expect((delta as { events: unknown[] }).events).toHaveLength(1);

    const resetResponse = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/detail`);
    const reset: unknown = await resetResponse.json();
    expect(isAnvilSessionDetailSync(reset)).toBe(true);
    expect(reset).toMatchObject({ mode: "reset", detail: { sessionId: session.id, throughSequence: 2 } });

    database.saveSnapshot(events.currentSnapshot(), { retainedEventCount: 1, maxCompactionRows: 10 });
    const staleResponse = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/detail?after=0`);
    expect(await staleResponse.json()).toMatchObject({ mode: "reset", detail: { throughSequence: 2 } });
    const boundaryResponse = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/detail?after=1`);
    expect(await boundaryResponse.json()).toMatchObject({ mode: "delta", fromSequence: 1 });
  });

  it("serves externalized artifacts only through the owner-authenticated API", async () => {
    const session: SessionSummary = {
      id: "artifact-session",
      projectId: "anvil",
      title: "Artifacts",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "medium",
    };
    events.createSession(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });
    const [event] = events.append([{
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          content: [{ id: "text-1", type: "text", text: "large artifact body".repeat(20) }],
          status: "complete",
          createdAt: "2026-07-23T01:00:01.000Z",
        },
      },
    }]);
    if (event?.type !== "message.started") throw new Error("Expected message event");
    const block = event.payload.message.content[0];
    if (block?.type !== "artifact") throw new Error("Expected artifact block");

    await server.close();
    server = new ForgeHttpServer({ events, artifacts, ownerLogin: "owner@example.com" });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${baseUrl}${block.url}`)).status).toBe(403);
    const response = await fetch(`${baseUrl}${block.url}`, {
      headers: { "tailscale-user-login": "owner@example.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("large artifact body".repeat(20));

    const head = await fetch(`${baseUrl}${block.url}`, {
      method: "HEAD",
      headers: { "tailscale-user-login": "owner@example.com" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(block.byteLength));
    expect(await head.text()).toBe("");
    expect((await fetch(`${baseUrl}/api/v1/artifacts/not-a-valid-id`, {
      headers: { "tailscale-user-login": "owner@example.com" },
    })).status).toBe(404);
  });

  it("uploads session-scoped attachments and searches workspace files", async () => {
    const session: SessionSummary = {
      id: "attachment-session",
      projectId: "anvil",
      title: "Attachments",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "medium",
    };
    events.createSession(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });
    await server.close();
    server = new ForgeHttpServer({
      events,
      artifacts,
      searchFiles: async (sessionId, query) => sessionId === session.id && query === "comp"
        ? ["apps/web/src/components/Composer.tsx"]
        : undefined,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const upload = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-anvil-file-name": encodeURIComponent("notes.txt"),
      },
      body: "attachment body",
    });
    const reference = await upload.json() as { artifactId: string; url: string };
    expect(upload.status).toBe(201);
    expect(events.artifact(reference.artifactId)).toMatchObject({
      sessionId: session.id,
      name: "notes.txt",
      byteLength: 15,
    });
    expect(await (await fetch(`${baseUrl}${reference.url}`)).text()).toBe("attachment body");

    const removableUpload = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-anvil-file-name": "remove.txt" },
      body: "remove me",
    });
    const removable = await removableUpload.json() as { artifactId: string };
    expect((await fetch(`${baseUrl}/api/v1/sessions/${session.id}/attachments/${removable.artifactId}`, {
      method: "DELETE",
    })).status).toBe(200);
    expect(events.artifact(removable.artifactId)).toBeUndefined();

    const search = await fetch(`${baseUrl}/api/v1/sessions/${session.id}/files?q=comp`);
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ files: [{ path: "apps/web/src/components/Composer.tsx" }] });
    expect((await fetch(`${baseUrl}/api/v1/sessions/missing/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-anvil-file-name": "notes.txt" },
      body: "no session",
    })).status).toBe(404);
  });

  it("runs an owner-initiated web app rebuild", async () => {
    await server.close();
    let rebuilt = false;
    server = new ForgeHttpServer({
      events,
      artifacts,
      requestRebuild: async () => { rebuilt = true; },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/v1/admin/rebuild`, {
      method: "POST",
      headers: { origin: baseUrl },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "rebuilt" });
    expect(rebuilt).toBe(true);
  });

  it("gets and updates the owner-authenticated projects root with origin and path validation", async () => {
    await server.close();
    const initialRoot = mkdtempSync(join(tmpdir(), "anvil-projects-root-"));
    const nextRoot = join(initialRoot, "next");
    mkdirSync(nextRoot);
    let projectsRoot = initialRoot;
    server = new ForgeHttpServer({
      events,
      ownerLogin: "owner@example.com",
      getProjectsRoot: () => projectsRoot,
      setProjectsRoot: (path) => {
        projectsRoot = canonicalizeProjectsRoot(path);
        return projectsRoot;
      },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const ownerHeaders = { "tailscale-user-login": "owner@example.com" };

    expect((await fetch(`${baseUrl}/api/v1/settings/projects-root`)).status).toBe(403);
    expect(await (await fetch(`${baseUrl}/api/v1/settings/projects-root`, { headers: ownerHeaders })).json()).toEqual({ path: initialRoot });

    const crossOrigin = await fetch(`${baseUrl}/api/v1/settings/projects-root`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(crossOrigin.status).toBe(403);

    const invalid = await fetch(`${baseUrl}/api/v1/settings/projects-root`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ path: join(initialRoot, "missing") }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_projects_root", message: expect.stringContaining("does not exist") });

    const updated = await fetch(`${baseUrl}/api/v1/settings/projects-root`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ path: nextRoot });
    rmSync(initialRoot, { recursive: true, force: true });
  });

  it("rejects rebuild requests when rebuilding is unavailable", async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/rebuild`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "rebuild_unavailable" });
  });

  it("resets stale SSE cursors after journal compaction", async () => {
    events.append(Array.from({ length: 3 }, (_, index) => ({
      sessionId: null,
      timestamp: `2026-07-23T01:00:0${index}.000Z`,
      type: "connection.changed" as const,
      payload: { connection: "connected" as const },
    })));
    database.saveSnapshot(events.currentSnapshot(), { retainedEventCount: 1, maxCompactionRows: 10 });

    const response = await fetch(`${baseUrl}/api/v1/events?after=1`);
    const text = await response.text();
    expect(text).toContain("event: reset");
    expect(text).toContain('"reason":"cursor_invalid"');
    expect(text).toContain('"cursor":3');
  });

  it("replays and streams SSE events after a cursor", async () => {
    events.append([{
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "connection.changed",
      payload: { connection: "connected" },
    }]);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events?after=0`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected SSE body");
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("id: 1");
    expect(text).toContain("event: anvil");
    controller.abort();
  });

  it("enforces the configured Tailscale owner identity", async () => {
    await server.close();
    server = new ForgeHttpServer({ events, ownerLogin: "owner@example.com" });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${baseUrl}/api/v1/bootstrap`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/v1/bootstrap`, {
      headers: { "tailscale-user-login": "owner@example.com" },
    })).status).toBe(200);
  });

  it("validates commands before dispatch", async () => {
    await server.close();
    const handled: string[] = [];
    server = new ForgeHttpServer({
      events,
      handleCommand: async (command): Promise<AnvilCommandResponse> => {
        handled.push(command.id);
        return {
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          id: "response-1",
          commandId: command.id,
          timestamp: command.timestamp,
          success: true,
          outcome: "completed",
        };
      },
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const command = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "command-1",
      sessionId: null,
      timestamp: "2026-07-23T01:00:00.000Z",
      type: "session.create",
      payload: { projectId: "anvil", sessionId: "01959f7e-7d64-7000-8000-000000000001" },
    };
    const response = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    expect(handled).toEqual(["command-1"]);

    const invalid = await fetch(`${baseUrl}/api/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, payload: {} }),
    });
    expect(invalid.status).toBe(400);
  });
});
