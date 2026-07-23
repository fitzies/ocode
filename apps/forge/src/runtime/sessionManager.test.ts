import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANVIL_PROTOCOL_VERSION, type AnvilClientCommand } from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ForgeConfig } from "../config.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { SessionManager } from "./sessionManager.ts";

let directory: string;
let config: ForgeConfig;
let database: ForgeDatabase;
let events: ForgeEventService;
let manager: SessionManager;

const requestedSessionId = "01959f7e-7d64-7000-8000-000000000001";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime events");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function command<T extends AnvilClientCommand["type"]>(
  id: string,
  type: T,
  sessionId: string | null,
  payload: Extract<AnvilClientCommand, { type: T }>["payload"],
): AnvilClientCommand {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id,
    type,
    sessionId,
    timestamp: "2026-07-23T01:00:00.000Z",
    payload,
  } as AnvilClientCommand;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anvil-runtime-"));
  const executable = join(directory, "fake-pi.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
    let sessionFile = sessionDir + "/session.jsonl";
    let sessionId = "pi-session-1";
    let pendingDialogPromptId;
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.type === "get_state") {
        setTimeout(() => send({ type: "response", id: request.id, command: request.type, success: true, data: {
          model: { id: "model-1", name: "Model One", provider: "test", reasoning: true, input: ["text"], thinkingLevelMap: { xhigh: null } },
          thinkingLevel: "medium", isStreaming: false, sessionId, sessionFile, sessionName: "Runtime test"
        }}), 30);
      } else if (request.type === "switch_session") {
        if (request.sessionPath.includes("rejected")) {
          send({ type: "response", id: request.id, command: request.type, success: false, error: "Session rejected" });
        } else if (request.sessionPath.includes("cancelled")) {
          send({ type: "response", id: request.id, command: request.type, success: true, data: { cancelled: true } });
        } else {
          sessionFile = request.sessionPath;
          sessionId = "pi-session-restored";
          send({ type: "response", id: request.id, command: request.type, success: true, data: { cancelled: false } });
        }
      } else if (request.type === "get_messages") {
        send({ type: "response", id: request.id, command: request.type, success: true, data: { messages: [] } });
      } else if (request.type === "get_available_models") {
        send({ type: "response", id: request.id, command: request.type, success: true, data: { models: [
          { id: "model-1", name: "Model One", provider: "test", reasoning: true, input: ["text"], thinkingLevelMap: { xhigh: null } }
        ] }});
      } else if (request.type === "get_commands") {
        send({ type: "response", id: request.id, command: request.type, success: true, data: { commands: [] } });
      } else if (request.type === "prompt") {
        send({ type: "agent_start" });
        send({ type: "message_start", message: { role: "user", content: request.message, timestamp: 1 } });
        send({ type: "message_end", message: { role: "user", content: request.message, timestamp: 1 } });
        if (request.message === "Crash with dialog") {
          send({ type: "extension_ui_request", id: "dialog-crash", method: "confirm", title: "Continue?" });
          setTimeout(() => process.exit(17), 30);
        } else if (request.message === "Open dialog" || request.message === "Open timed dialog") {
          pendingDialogPromptId = request.id;
          send({
            type: "extension_ui_request",
            id: request.message === "Open timed dialog" ? "dialog-timeout" : "dialog-1",
            method: "confirm",
            title: "Continue?",
            ...(request.message === "Open timed dialog" ? { timeout: 10 } : {}),
          });
        } else {
          send({ type: "response", id: request.id, command: request.type, success: true });
          send({ type: "agent_settled" });
        }
      } else if (request.type === "extension_ui_response") {
        if (pendingDialogPromptId) {
          send({ type: "response", id: pendingDialogPromptId, command: "prompt", success: true });
          pendingDialogPromptId = undefined;
          send({ type: "agent_settled" });
        }
      } else {
        send({ type: "response", id: request.id, command: request.type, success: true });
      }
    });
  `);
  chmodSync(executable, 0o755);

  const project = { id: "anvil", name: "Anvil", path: directory };
  config = {
    host: "127.0.0.1",
    port: 3210,
    databasePath: ":memory:",
    sessionDir: join(directory, "sessions"),
    piExecutable: executable,
    webRoot: join(directory, "web"),
    projects: [project],
  };
  database = new ForgeDatabase(":memory:");
  events = new ForgeEventService(database, [project]);
  manager = new SessionManager(config, database, events);
});

afterEach(async () => {
  await manager.stopAll();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SessionManager", () => {
  it("creates a real RPC subprocess session and sends a prompt", async () => {
    const create = command("create-1", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId });
    const created = await manager.handleCommand(create);
    expect(created.success).toBe(true);
    const sessionId = (created.data as { sessionId: string }).sessionId;
    expect(sessionId).toBe(requestedSessionId);

    expect(events.currentSnapshot().sessions).toContainEqual(expect.objectContaining({
      id: sessionId,
      title: "New session",
      modelId: "unknown",
    }));

    await waitUntil(() => (
      events.currentSnapshot().sessions.some(
        (session) => session.id === sessionId && session.title === "Runtime test",
      ) && (events.currentSnapshot().catalogs[sessionId]?.models.length ?? 0) > 0
    ));
    const snapshot = events.currentSnapshot();
    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: sessionId,
      title: "Runtime test",
      modelId: "test/model-1",
      thinkingLevel: "medium",
    }));
    expect(snapshot.catalogs[sessionId].models[0]).toMatchObject({
      id: "test/model-1",
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });

    const prompt = command("prompt-1", "prompt.send", sessionId, {
      content: "Keep running without a browser",
      delivery: "prompt",
    });
    const response = await manager.handleCommand(prompt);
    expect(response.success).toBe(true);
    await waitUntil(() => (events.currentSnapshot().timelines[sessionId] ?? []).some(
      (entry) => entry.kind === "message" && entry.role === "user" && entry.status === "complete",
    ));
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "user",
      status: "complete",
    }));
  });

  it("adds a validated workspace and restores it from the database", async () => {
    const workspacePath = join(directory, "second-workspace");
    mkdirSync(workspacePath);
    const created = await manager.handleCommand(command("project-create", "project.create", null, {
      name: "Second workspace",
      path: workspacePath,
    }));

    expect(created.success).toBe(true);
    const projectId = (created.data as { projectId: string }).projectId;
    expect(events.currentSnapshot().projects).toContainEqual({
      id: projectId,
      name: "Second workspace",
      path: workspacePath,
    });

    await manager.stopAll();
    const orphanDirectory = join(config.sessionDir, "deleted-before-cleanup");
    mkdirSync(orphanDirectory, { recursive: true });
    events = new ForgeEventService(database, config.projects);
    manager = new SessionManager(config, database, events);
    expect(events.currentSnapshot().projects.some((project) => project.id === projectId)).toBe(true);
    expect(existsSync(orphanDirectory)).toBe(false);
  });

  it("permanently deletes a session and its runtime directory", async () => {
    const created = await manager.handleCommand(command("create-delete", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const runtimeDirectory = join(config.sessionDir, sessionId);
    const outsideFile = join(directory, "do-not-delete.jsonl");
    writeFileSync(outsideFile, "sentinel");
    const storedSession = events.currentSnapshot().sessions.find((session) => session.id === sessionId)!;
    database.updateSession(storedSession, { sessionFile: outsideFile });
    expect(existsSync(runtimeDirectory)).toBe(true);

    const deletion = command("delete-session", "session.delete", null, { sessionId });
    const deleted = await manager.handleCommand(deletion);
    const duplicate = await manager.handleCommand(deletion);

    expect(deleted.success).toBe(true);
    expect(duplicate).toEqual(deleted);
    expect(events.currentSnapshot().sessions.some((session) => session.id === sessionId)).toBe(false);
    expect(database.getSession(sessionId)).toBeUndefined();
    expect(existsSync(runtimeDirectory)).toBe(false);
    expect(existsSync(outsideFile)).toBe(true);
    expect(events.currentSnapshot().timelines[sessionId]).toBeUndefined();

    mkdirSync(runtimeDirectory, { recursive: true });
    await manager.stopAll();
    events = new ForgeEventService(database, config.projects);
    manager = new SessionManager(config, database, events);
    expect(events.currentSnapshot().sessions.some((session) => session.id === sessionId)).toBe(false);
    expect(existsSync(runtimeDirectory)).toBe(false);
  });

  it("marks active runs and dialogs interrupted when Forge restarts", async () => {
    const created = await manager.handleCommand(command("create-interrupted", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    await manager.stopAll();
    events.append([
      {
        type: "run.status",
        sessionId,
        timestamp: "2026-07-23T01:00:01.000Z",
        payload: { status: "running" },
      },
      {
        type: "interaction.requested",
        sessionId,
        timestamp: "2026-07-23T01:00:02.000Z",
        payload: {
          request: {
            id: "stale-dialog",
            sessionId,
            method: "confirm",
            title: "Continue?",
            requestedAt: "2026-07-23T01:00:02.000Z",
          },
        },
      },
    ]);

    manager = new SessionManager(config, database, events);

    expect(events.currentSnapshot().pendingInteractions).toHaveLength(0);
    expect(events.currentSnapshot().sessions.find((session) => session.id === sessionId)?.status).toBe("failed");
    expect(database.getSession(sessionId)?.session.status).toBe("failed");
  });

  it("rejects model and thinking settings outside the session catalog", async () => {
    const created = await manager.handleCommand(command("create-capabilities", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;

    const model = await manager.handleCommand(command("model-unavailable", "model.set", sessionId, {
      modelId: "other/not-available",
    }));
    const thinking = await manager.handleCommand(command("thinking-unsupported", "thinking.set", sessionId, {
      level: "xhigh",
    }));

    expect(model).toMatchObject({ success: false, error: "Model is not available in this session" });
    expect(thinking).toMatchObject({
      success: false,
      error: "Thinking level is not supported by this session's model",
    });
  });

  it("fails the session and resolves dialogs when Pi exits unexpectedly", async () => {
    const created = await manager.handleCommand(command("create-crash", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const response = await manager.handleCommand(command("prompt-crash", "prompt.send", sessionId, {
      content: "Crash with dialog",
      delivery: "prompt",
    }));

    expect(response.success).toBe(false);
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === sessionId && session.status === "failed",
    ));
    expect(events.currentSnapshot().pendingInteractions).toHaveLength(0);
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "interaction",
      requestId: "dialog-crash",
      status: "cancelled",
    }));
  });

  it("cancels timed-out dialogs upstream so Pi can continue", async () => {
    const created = await manager.handleCommand(command("create-timeout", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const prompting = manager.handleCommand(command("prompt-timeout", "prompt.send", sessionId, {
      content: "Open timed dialog",
      delivery: "prompt",
    }));

    await waitUntil(() => events.currentSnapshot().pendingInteractions.some(
      (request) => request.id === "dialog-timeout",
    ));
    await waitUntil(() => !events.currentSnapshot().pendingInteractions.some(
      (request) => request.id === "dialog-timeout",
    ));

    expect((await prompting).success).toBe(true);
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "interaction",
      requestId: "dialog-timeout",
      status: "cancelled",
    }));
  });

  it("durably cancels pending dialogs when abort succeeds", async () => {
    const created = await manager.handleCommand(command("create-dialog", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const prompting = manager.handleCommand(command("prompt-dialog", "prompt.send", sessionId, {
      content: "Open dialog",
      delivery: "prompt",
    }));
    await waitUntil(() => events.currentSnapshot().pendingInteractions.some(
      (request) => request.id === "dialog-1",
    ));

    const cancelled = await manager.handleCommand(command("cancel-dialog", "run.cancel", sessionId, {}));

    expect(cancelled.success).toBe(true);
    expect((await prompting).success).toBe(true);
    expect(events.currentSnapshot().pendingInteractions).toHaveLength(0);
    expect(events.currentSnapshot().sessions.find((session) => session.id === sessionId)?.status).toBe("idle");
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "interaction",
      requestId: "dialog-1",
      status: "cancelled",
    }));
  });

  it.each([
    ["rejected", "Session rejected"],
    ["cancelled", "Pi cancelled session restoration"],
  ])("fails closed when restored Pi session is %s", async (failure, expectedError) => {
    const timestamp = "2026-07-23T01:00:00.000Z";
    const storedSession = {
      id: `stored-${failure}`,
      projectId: "anvil",
      title: "Stored session",
      updatedAt: timestamp,
      status: "idle" as const,
      modelId: "test/model-1",
      thinkingLevel: "medium" as const,
    };
    events.createSession(storedSession, {
      type: "session.upserted",
      sessionId: storedSession.id,
      timestamp,
      payload: { session: storedSession },
    });
    const sessionFile = join(directory, `${failure}-session.jsonl`);
    database.updateSession(storedSession, {
      sessionId: "pi-session-restored",
      sessionFile,
    });

    const response = await manager.handleCommand(command(`restore-${failure}`, "prompt.send", storedSession.id, {
      content: "Do not run in an empty session",
      delivery: "prompt",
    }));

    expect(response).toMatchObject({ success: false, error: expect.stringContaining(expectedError) });
    expect(events.currentSnapshot().sessions.find((session) => session.id === storedSession.id)?.status).toBe("failed");
    expect(database.getSession(storedSession.id)).toMatchObject({
      piSessionId: "pi-session-restored",
      piSessionFile: sessionFile,
    });
  });

  it("rejects a requested session id that already exists", async () => {
    const first = await manager.handleCommand(command(
      "create-first-id",
      "session.create",
      null,
      { projectId: "anvil", sessionId: requestedSessionId },
    ));
    const collision = await manager.handleCommand(command(
      "create-colliding-id",
      "session.create",
      null,
      { projectId: "anvil", sessionId: requestedSessionId },
    ));

    expect(first.success).toBe(true);
    expect(collision).toMatchObject({ success: false, error: "Session id already exists" });
    expect(events.currentSnapshot().sessions).toHaveLength(1);
  });

  it("returns the stored response for a duplicate command id", async () => {
    const create = command("create-once", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId });
    const first = await manager.handleCommand(create);
    const duplicate = await manager.handleCommand(create);
    expect(duplicate).toEqual(first);
    expect(events.currentSnapshot().sessions).toHaveLength(1);
  });
});
