import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import {
  ANVIL_PROTOCOL_VERSION,
  createOcodeAskUserQuestionResponse,
  GENERAL_PROJECT_NAME,
  type AnvilClientCommand,
  type SubagentRun,
} from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../artifacts/artifactStore.ts";
import type { ForgeConfig } from "../config.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ProjectCloneError } from "../projects/projectCloneService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { SubagentCoordinator, subagentCompletionContent } from "../subagents/subagentCoordinator.ts";
import { SessionManager } from "./sessionManager.ts";

let directory: string;
let config: ForgeConfig;
let database: ForgeDatabase;
let events: ForgeEventService;
let artifacts: ArtifactStore;
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
    import { appendFileSync, existsSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];
    let sessionFile = sessionDir + "/session.jsonl";
    let sessionId = "pi-session-1";
    let sessionName = "Runtime test";
    let pendingDialogPromptId;
    let askRequestId = 0;
    let aborted = false;
    writeFileSync(sessionDir + "/runtime-args.json", JSON.stringify(process.argv.slice(2)));
    input.on("line", (line) => {
      const request = JSON.parse(line);
      appendFileSync(sessionDir + "/rpc-requests.jsonl", JSON.stringify(request) + "\\n");
      if (request.type === "get_state") {
        setTimeout(() => send({ type: "response", id: request.id, command: request.type, success: true, data: {
          model: { id: "model-1", name: "Model One", provider: "test", reasoning: true, input: ["text"], thinkingLevelMap: { xhigh: null } },
          thinkingLevel: "medium", isStreaming: false, sessionId, sessionFile, sessionName
        }}), 30);
      } else if (request.type === "switch_session") {
        if (request.sessionPath.includes("rejected")) {
          send({ type: "response", id: request.id, command: request.type, success: false, error: "Session rejected" });
        } else if (request.sessionPath.includes("cancelled")) {
          send({ type: "response", id: request.id, command: request.type, success: true, data: { cancelled: true } });
        } else {
          sessionFile = request.sessionPath;
          send({ type: "response", id: request.id, command: request.type, success: true, data: { cancelled: false } });
        }
      } else if (request.type === "set_session_name") {
        sessionName = request.name;
        send({ type: "session_info_changed", name: sessionName });
        send({ type: "response", id: request.id, command: request.type, success: true });
      } else if (request.type === "get_messages") {
        send({ type: "response", id: request.id, command: request.type, success: true, data: { messages: [] } });
      } else if (request.type === "get_available_models") {
        if (existsSync(sessionDir + "/fail-model-discovery")) {
          send({ type: "response", id: request.id, command: request.type, success: false, error: "Model discovery unavailable" });
        } else {
          send({ type: "response", id: request.id, command: request.type, success: true, data: { models: [
            { id: "model-1", name: "Model One", provider: "test", reasoning: true, input: ["text"], thinkingLevelMap: { xhigh: null } }
          ] }});
        }
      } else if (request.type === "get_commands") {
        send({ type: "response", id: request.id, command: request.type, success: true, data: { commands: [] } });
      } else if (request.type === "prompt") {
        send({ type: "agent_start" });
        send({ type: "message_start", message: { role: "user", content: request.message, timestamp: 1 } });
        send({ type: "message_end", message: { role: "user", content: request.message, timestamp: 1 } });
        if (request.message === "Fix the sidebar while Pi names this thread") {
          send({ type: "response", id: request.id, command: request.type, success: true });
          send({ type: "agent_settled" });
          setTimeout(() => {
            sessionName = "Generated sidebar title";
            send({ type: "session_info_changed", name: sessionName });
          }, 100);
        } else if (request.message === "Reject first prompt") {
          send({ type: "response", id: request.id, command: request.type, success: false, error: "Prompt rejected" });
        } else if (request.message === "Reject matching title") {
          sessionName = request.message;
          send({ type: "session_info_changed", name: sessionName });
          send({ type: "response", id: request.id, command: request.type, success: false, error: "Prompt rejected after naming" });
        } else if (request.message === "Stream output") {
          send({ type: "message_start", message: { id: "assistant-stream", role: "assistant", content: [], timestamp: 2 } });
          send({ type: "message_update", message: { id: "assistant-stream" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } });
          send({ type: "message_update", message: { id: "assistant-stream" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" } });
          send({ type: "message_end", message: { id: "assistant-stream", role: "assistant", content: [{ type: "text", text: "Hello world" }], timestamp: 2 } });
          send({ type: "response", id: request.id, command: request.type, success: true });
          send({ type: "agent_settled" });
        } else if (request.message === "Hang tool" || request.message.includes("Subagent stays busy")) {
          send({ type: "response", id: request.id, command: request.type, success: true });
          send({
            type: "tool_execution_start",
            toolCallId: "call-hung",
            toolName: "bash",
            args: { command: "python3 hanging.py" },
          });
        } else if (request.message === "Crash with dialog") {
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
        } else if (request.message === "Open ask dialog") {
          pendingDialogPromptId = request.id;
          askRequestId += 1;
          send({
            type: "extension_ui_request",
            id: "ask-dialog-" + askRequestId,
            method: "editor",
            title: "__ocode_ask_user_question_v1__",
            prefill: JSON.stringify({
              kind: "ocode.ask-user-question",
              schemaVersion: 1,
              question: "Which approach?",
              mode: "single-select",
              options: [
                { label: "Direct", value: "direct" },
                { label: "Layered", value: "layered" },
              ],
            }),
          });
        } else {
          send({ type: "response", id: request.id, command: request.type, success: true });
          send({ type: "agent_settled" });
        }
      } else if (request.type === "extension_ui_response") {
        if (pendingDialogPromptId) {
          send({ type: "response", id: pendingDialogPromptId, command: "prompt", success: true });
          pendingDialogPromptId = undefined;
          if (!aborted) send({ type: "agent_settled" });
        }
      } else if (request.type === "abort") {
        aborted = true;
        process.stdout.write(
          JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n" +
          JSON.stringify({ type: "agent_settled" }) + "\\n"
        );
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
    artifactDir: join(directory, "artifacts"),
    desktopUpdateDir: join(directory, "desktop-updates"),
    piExecutable: executable,
    webRoot: join(directory, "web"),
    projectsRoot: directory,
    projects: [project],
  };
  database = new ForgeDatabase(":memory:");
  artifacts = new ArtifactStore(config.artifactDir);
  events = new ForgeEventService(database, [project], artifacts);
  manager = new SessionManager(config, database, events);
});

afterEach(async () => {
  await manager.stopAll();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SessionManager", () => {
  it("does not remove an adopted General home workspace", async () => {
    const generalHome = join(directory, "general-home");
    mkdirSync(generalHome);
    const project = { id: "existing-home", name: GENERAL_PROJECT_NAME, path: generalHome, workspaceKind: "general" as const };
    events.createProject(project, {
      type: "project.upserted",
      payload: { project },
      sessionId: null,
      timestamp: new Date().toISOString(),
    } as UnsequencedAnvilEvent);

    events.markGeneralProject(project.id);
    const response = await manager.handleCommand(command("remove-general", "project.delete", null, {
      projectId: project.id,
    }));

    expect(response.success).toBe(false);
    expect(response.error).toBe("The General home workspace cannot be removed");
    expect(events.projectSummary(project.id)).toEqual(expect.objectContaining(project));
  });

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
    expect(events.currentSnapshot().sessions.find((session) => session.id === sessionId)).toMatchObject({
      lastUserMessageAt: expect.any(String),
      lastUserMessageSequence: expect.any(Number),
    });
    expect(database.readEventsAfter(0).some((event) => event.type === "session.prompted" && event.sessionId === sessionId)).toBe(true);
  });

  it("uses the first prompt as a provisional title until Pi generates one", async () => {
    await manager.handleCommand(command("create-provisional-title", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.sessionSummary(requestedSessionId)?.title === "Runtime test");
    await manager.handleCommand(command("reset-provisional-title", "session.rename", requestedSessionId, {
      title: "New session",
    }));

    const response = await manager.handleCommand(command(
      "prompt-provisional-title",
      "prompt.send",
      requestedSessionId,
      { content: "Fix the sidebar while Pi names this thread", delivery: "prompt" },
    ));

    expect(response.success).toBe(true);
    expect(events.sessionSummary(requestedSessionId)?.title)
      .toBe("Fix the sidebar while Pi names this…");
    expect(database.getSession(requestedSessionId)?.session.title)
      .toBe("Fix the sidebar while Pi names this…");

    await waitUntil(() => events.sessionSummary(requestedSessionId)?.title === "Generated sidebar title");
    expect(database.getSession(requestedSessionId)?.session.title).toBe("Generated sidebar title");
  });

  it("restores the default title when the first prompt is rejected", async () => {
    await manager.handleCommand(command("create-rejected-title", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.sessionSummary(requestedSessionId)?.title === "Runtime test");
    await manager.handleCommand(command("reset-rejected-title", "session.rename", requestedSessionId, {
      title: "New session",
    }));

    const response = await manager.handleCommand(command(
      "prompt-rejected-title",
      "prompt.send",
      requestedSessionId,
      { content: "Reject first prompt", delivery: "prompt" },
    ));

    expect(response).toMatchObject({ success: false, error: "Prompt rejected" });
    expect(events.sessionSummary(requestedSessionId)?.title).toBe("New session");
    expect(database.getSession(requestedSessionId)?.session.title).toBe("New session");
  });

  it("does not roll back a matching title generated by Pi before rejection", async () => {
    await manager.handleCommand(command("create-matching-title", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.sessionSummary(requestedSessionId)?.title === "Runtime test");
    await manager.handleCommand(command("reset-matching-title", "session.rename", requestedSessionId, {
      title: "New session",
    }));

    const response = await manager.handleCommand(command(
      "prompt-matching-title",
      "prompt.send",
      requestedSessionId,
      { content: "Reject matching title", delivery: "prompt" },
    ));

    expect(response).toMatchObject({ success: false, error: "Prompt rejected after naming" });
    expect(events.sessionSummary(requestedSessionId)?.title).toBe("Reject matching title");
    expect(database.getSession(requestedSessionId)?.session.title).toBe("Reject matching title");
  });

  it("routes durable read-state commands without starting Pi", async () => {
    const session = {
      id: requestedSessionId,
      projectId: "anvil",
      title: "Finished thread",
      updatedAt: "2026-07-23T01:00:00.000Z",
      status: "idle" as const,
      modelId: "test/model-1",
      thinkingLevel: "medium" as const,
      lastTerminalSequence: 10,
      lastTerminalOutcome: "cancelled" as const,
      readThroughSequence: 0,
    };
    events.createSession(session, {
      sessionId: session.id,
      timestamp: session.updatedAt,
      type: "session.upserted",
      payload: { session },
    });
    const runtimes = () => (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;

    const read = await manager.handleCommand(command(
      "mark-read-1",
      "session.markRead",
      session.id,
      { throughSequence: 999 },
    ));
    expect(read.success).toBe(true);
    expect(runtimes().has(session.id)).toBe(false);
    expect(events.sessionSummary(session.id)?.readThroughSequence).toBe(10);
    expect(database.getSession(session.id)?.session.readThroughSequence).toBe(10);

    const unread = await manager.handleCommand(command(
      "mark-unread-1",
      "session.markUnread",
      session.id,
      {},
    ));
    expect(unread.success).toBe(true);
    expect(runtimes().has(session.id)).toBe(false);
    expect(events.sessionSummary(session.id)?.readThroughSequence).toBe(9);
  });

  it("renames a thread through Pi and persists a configured title event", async () => {
    await manager.handleCommand(command("create-rename", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));

    const response = await manager.handleCommand(command(
      "rename-1",
      "session.rename",
      requestedSessionId,
      { title: "  Durable renamed thread  " },
    ));

    expect(response.success).toBe(true);
    expect(events.currentSnapshot().sessions.find((session) => session.id === requestedSessionId)?.title)
      .toBe("Durable renamed thread");
    expect(database.getSession(requestedSessionId)?.session.title).toBe("Durable renamed thread");
    expect(database.readEventsAfter(0)).toContainEqual(expect.objectContaining({
      type: "session.configured",
      payload: { title: "Durable renamed thread" },
    }));

    const invalid = await manager.handleCommand(command(
      "rename-invalid",
      "session.rename",
      requestedSessionId,
      { title: "   " },
    ));
    expect(invalid).toMatchObject({ success: false, error: expect.stringContaining("non-empty") });
  });

  it("stops a settled runtime and lazily restores it when prompting again", async () => {
    await manager.handleCommand(command("create-settle", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));
    const runtimes = () => (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes().has(requestedSessionId)).toBe(true);
    const settle = command("settle-1", "session.settled", requestedSessionId, { settled: true });

    const response = await manager.handleCommand(settle);
    const duplicate = await manager.handleCommand(settle);

    expect(response.success).toBe(true);
    expect(duplicate).toEqual(response);
    expect(events.currentSnapshot().sessions.find((session) => session.id === requestedSessionId)?.settled).toBe(true);
    expect(database.getSession(requestedSessionId)?.session.settled).toBe(true);
    expect(runtimes().has(requestedSessionId)).toBe(false);
    expect(database.readEventsAfter(0).filter((event) => event.type === "session.settled")).toHaveLength(1);

    const prompt = await manager.handleCommand(command("prompt-after-settle", "prompt.send", requestedSessionId, {
      content: "Continue the settled thread",
      delivery: "prompt",
    }));

    expect(prompt.success).toBe(true);
    expect(events.currentSnapshot().sessions.find((session) => session.id === requestedSessionId)?.settled).toBe(false);
    expect(database.getSession(requestedSessionId)?.session.settled).toBe(false);
    expect(runtimes().has(requestedSessionId)).toBe(true);
  });

  it("waits for a starting runtime before settling it", async () => {
    await manager.handleCommand(command("create-starting", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));

    const response = await manager.handleCommand(command("settle-starting", "session.settled", requestedSessionId, {
      settled: true,
    }));

    expect(response).toMatchObject({ success: true });
    expect(database.getSession(requestedSessionId)?.session.settled).toBe(true);
  });

  it("rejects settlement while Pi is waiting for interaction", async () => {
    await manager.handleCommand(command("create-waiting", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));
    const prompt = manager.handleCommand(command("prompt-waiting", "prompt.send", requestedSessionId, {
      content: "Open dialog",
      delivery: "prompt",
    }));
    await waitUntil(() => events.currentSnapshot().pendingInteractions.some(
      (request) => request.sessionId === requestedSessionId,
    ));

    const response = await manager.handleCommand(command("settle-waiting", "session.settled", requestedSessionId, {
      settled: true,
    }));

    expect(response).toMatchObject({ success: false, error: expect.stringContaining("Wait for Pi") });
    expect(database.getSession(requestedSessionId)?.session.settled).toBe(false);
    await manager.handleCommand(command("answer-waiting", "interaction.respond", requestedSessionId, {
      requestId: "dialog-1",
      confirmed: true,
    }));
    await prompt;
  });

  it("validates specialized ask responses before resolving or sending them to Pi", async () => {
    await manager.handleCommand(command("create-ask", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));

    let firstPromptSettled = false;
    const firstPrompt = manager.handleCommand(command("prompt-ask-1", "prompt.send", requestedSessionId, {
      content: "Open ask dialog",
      delivery: "prompt",
    })).finally(() => { firstPromptSettled = true; });
    await waitUntil(() => events.currentSnapshot().pendingInteractions.some(
      (request) => request.sessionId === requestedSessionId && request.presentation?.type === "ask_user_question",
    ));
    const firstRequest = events.pendingInteractionsForSession(requestedSessionId).find(
      (request) => request.presentation?.type === "ask_user_question",
    )!;
    const validValue = createOcodeAskUserQuestionResponse([{ type: "option", optionIndex: 1 }]);
    const invalidPayloads = [
      { requestId: firstRequest.id },
      {
        requestId: firstRequest.id,
        value: createOcodeAskUserQuestionResponse([{ type: "option", optionIndex: 2 }]),
      },
      { requestId: firstRequest.id, cancelled: true, value: validValue },
    ];

    for (const [index, payload] of invalidPayloads.entries()) {
      const response = await manager.handleCommand(command(
        `invalid-ask-${index}`,
        "interaction.respond",
        requestedSessionId,
        payload,
      ));
      expect(response).toMatchObject({ success: false, error: "Invalid ask_user_question response" });
      expect(events.hasPendingInteraction(requestedSessionId, firstRequest.id)).toBe(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstPromptSettled).toBe(false);

    const answered = await manager.handleCommand(command("answer-ask", "interaction.respond", requestedSessionId, {
      requestId: firstRequest.id,
      value: validValue,
    }));
    expect(answered.success).toBe(true);
    expect(events.hasPendingInteraction(requestedSessionId, firstRequest.id)).toBe(false);
    await firstPrompt;

    const secondPrompt = manager.handleCommand(command("prompt-ask-2", "prompt.send", requestedSessionId, {
      content: "Open ask dialog",
      delivery: "prompt",
    }));
    await waitUntil(() => events.currentSnapshot().pendingInteractions.some(
      (request) => request.id === "ask-dialog-2",
    ));
    const cancelled = await manager.handleCommand(command("cancel-ask", "interaction.respond", requestedSessionId, {
      requestId: "ask-dialog-2",
      cancelled: true,
    }));
    expect(cancelled.success).toBe(true);
    expect(events.hasPendingInteraction(requestedSessionId, "ask-dialog-2")).toBe(false);
    await secondPrompt;
  });

  it("resolves uploaded attachments into Pi prompt context", async () => {
    const created = await manager.handleCommand(command("create-attachment", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const attachment = events.ingestAttachment(
      sessionId,
      Buffer.from("important attachment text"),
      "text/plain",
      "notes.txt",
    );

    const response = await manager.handleCommand(command("prompt-attachment", "prompt.send", sessionId, {
      content: "Review this",
      delivery: "prompt",
      attachments: [attachment],
    }));

    expect(response.success).toBe(true);
    await waitUntil(() => (events.currentSnapshot().timelines[sessionId] ?? []).some(
      (entry) => entry.kind === "message" && entry.role === "user",
    ));
    const user = events.currentSnapshot().timelines[sessionId].find(
      (entry) => entry.kind === "message" && entry.role === "user",
    );
    expect(user).toMatchObject({
      kind: "message",
      content: [expect.objectContaining({
        type: "text",
        text: expect.stringContaining('<file name="notes.txt">\nimportant attachment text\n</file>'),
      })],
    });
    expect(events.artifact(attachment.artifactId)?.purpose).toBe("input");
  });

  it("rejects image attachments whose bytes do not match the declared media type", async () => {
    const created = await manager.handleCommand(command("create-bad-image", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const attachment = events.ingestAttachment(
      sessionId,
      Buffer.from("not a png"),
      "image/png",
      "fake.png",
    );

    const response = await manager.handleCommand(command("prompt-bad-image", "prompt.send", sessionId, {
      content: "Review this",
      delivery: "prompt",
      attachments: [attachment],
    }));

    expect(response).toMatchObject({
      success: false,
      error: expect.stringContaining("does not match its media type"),
    });
    expect(events.artifact(attachment.artifactId)?.purpose).toBe("upload");
    expect(database.readEventsAfter(0).some((event) => event.type === "session.prompted" && event.sessionId === sessionId)).toBe(false);
  });

  it("creates a slug directory under the projects root and restores the project", async () => {
    const created = await manager.handleCommand(command("project-create", "project.create", null, {
      name: "Second Project!",
    }));

    expect(created.success).toBe(true);
    const projectId = (created.data as { projectId: string }).projectId;
    const projectPath = join(directory, "second-project");
    expect(existsSync(projectPath)).toBe(true);
    expect(events.currentSnapshot().projects).toContainEqual({
      id: projectId,
      name: "Second Project!",
      path: projectPath,
      workspaceKind: "folder",
    });

    const duplicate = await manager.handleCommand(command("project-duplicate", "project.create", null, {
      name: "Second Project!",
    }));
    expect(duplicate).toMatchObject({ success: false, error: expect.stringContaining("already exists") });
    const unusable = await manager.handleCommand(command("project-unusable", "project.create", null, {
      name: "***",
    }));
    expect(unusable).toMatchObject({ success: false, error: expect.stringContaining("letters or numbers") });
    const existingDirectory = join(directory, "existing-project");
    mkdirSync(existingDirectory);
    const marker = join(existingDirectory, "README.md");
    writeFileSync(marker, "existing contents");
    const detected = await manager.handleCommand(command("project-existing-detected", "project.create", null, {
      name: "Existing Project",
    }));
    expect(detected).toMatchObject({
      success: false,
      error: expect.stringContaining("Use a Forge directory"),
    });
    expect(events.currentSnapshot().projects.some((project) => project.path === existingDirectory)).toBe(false);

    const added = await manager.handleCommand(command("project-existing-add", "project.addExisting", null, {
      name: "Existing Project",
      path: existingDirectory,
    }));
    expect(added).toMatchObject({ success: true, data: { status: "added" } });
    expect(events.currentSnapshot().projects).toContainEqual(expect.objectContaining({
      name: "Existing Project",
      path: existingDirectory,
    }));
    expect(readFileSync(marker, "utf8")).toBe("existing contents");

    const blockedPath = join(directory, "blocked-project");
    writeFileSync(blockedPath, "not a directory");
    const blocked = await manager.handleCommand(command("project-blocked-entry", "project.create", null, {
      name: "Blocked Project",
    }));
    expect(blocked).toMatchObject({ success: false, error: expect.stringContaining("Use a Forge directory") });

    await manager.stopAll();
    const orphanDirectory = join(config.sessionDir, "deleted-before-cleanup");
    mkdirSync(orphanDirectory, { recursive: true });
    events = new ForgeEventService(database, config.projects, artifacts);
    manager = new SessionManager(config, database, events);
    expect(events.currentSnapshot().projects.some((project) => project.id === projectId)).toBe(true);
    expect(existsSync(orphanDirectory)).toBe(false);
  });

  it("removes only its new empty directory when project persistence fails", async () => {
    vi.spyOn(events, "createProject").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    const failed = await manager.handleCommand(command("project-persistence-failure", "project.create", null, {
      name: "Temporary Project",
    }));

    expect(failed).toMatchObject({ success: false, error: "database unavailable" });
    expect(existsSync(join(directory, "temporary-project"))).toBe(false);
  });

  it("runs clone staging cleanup after the projects root is canonicalized", async () => {
    await manager.stopAll();
    const cleanupStale = vi.fn();
    manager = new SessionManager(config, database, events, {
      projectCloner: { clone: vi.fn(), cleanupStale },
    });

    expect(cleanupStale).toHaveBeenCalledOnce();
    expect(cleanupStale).toHaveBeenCalledWith(directory);
  });

  it("clones a normalized GitHub repository and registers it only after the move", async () => {
    await manager.stopAll();
    const clone = vi.fn(async (root: string, slug: string, repository: string) => {
      const destination = join(root, slug);
      mkdirSync(destination);
      writeFileSync(join(destination, "README.md"), repository);
      return destination;
    });
    manager = new SessionManager(config, database, events, { projectCloner: { clone } });

    const response = await manager.handleCommand(command("project-clone", "project.clone", null, {
      name: "Cloned Project",
      repository: "git@github.com:Owner/repository.git",
    }));

    expect(response).toMatchObject({ success: true, data: { status: "cloned", projectId: expect.any(String) } });
    expect(clone).toHaveBeenCalledWith(directory, "cloned-project", "Owner/repository");
    expect(events.currentSnapshot().projects).toContainEqual(expect.objectContaining({
      name: "Cloned Project",
      path: join(directory, "cloned-project"),
    }));
  });

  it("rejects clone name and path collisions without invoking the cloner", async () => {
    await manager.stopAll();
    const clone = vi.fn();
    manager = new SessionManager(config, database, events, { projectCloner: { clone } });

    const invalidRepository = await manager.handleCommand(command("project-clone-invalid-repository", "project.clone", null, {
      name: "Invalid Repository",
      repository: "https://token@github.com/owner/repository?token=secret",
    }));
    expect(invalidRepository).toMatchObject({ success: false, error: expect.stringContaining("valid GitHub repository") });

    const duplicateName = await manager.handleCommand(command("project-clone-name-collision", "project.clone", null, {
      name: "Anvil",
      repository: "owner/repository",
    }));
    expect(duplicateName).toMatchObject({ success: false, error: expect.stringContaining("name already exists") });
    expect(clone).not.toHaveBeenCalled();

    mkdirSync(join(directory, "occupied"));
    clone.mockRejectedValueOnce(new ProjectCloneError("existing destination was not changed"));
    const collision = await manager.handleCommand(command("project-clone-path-collision", "project.clone", null, {
      name: "Occupied",
      repository: "owner/repository",
    }));
    expect(collision).toMatchObject({ success: false, error: expect.stringContaining("not changed") });
    expect(existsSync(join(directory, "occupied"))).toBe(true);
  });

  it("preserves a successfully cloned workspace when registration persistence fails", async () => {
    await manager.stopAll();
    manager = new SessionManager(config, database, events, {
      projectCloner: {
        clone: async (root, slug) => {
          const destination = join(root, slug);
          mkdirSync(destination);
          writeFileSync(join(destination, "keep.txt"), "cloned workspace");
          return destination;
        },
      },
    });
    vi.spyOn(events, "createProject").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    const response = await manager.handleCommand(command("project-clone-persistence-failure", "project.clone", null, {
      name: "Preserved Clone",
      repository: "owner/repository",
    }));

    expect(response).toMatchObject({ success: false, error: expect.stringContaining("cloned successfully") });
    expect(response.error).toContain("use “Use a Forge directory”");
    expect(readFileSync(join(directory, "preserved-clone", "keep.txt"), "utf8")).toBe("cloned workspace");
    expect(events.currentSnapshot().projects.some((project) => project.path === join(directory, "preserved-clone"))).toBe(false);
  });

  it("reserves a clone destination while an earlier clone is running", async () => {
    await manager.stopAll();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    manager = new SessionManager(config, database, events, {
      projectCloner: {
        clone: async (root, slug) => {
          started = true;
          await blocked;
          const destination = join(root, slug);
          mkdirSync(destination);
          return destination;
        },
      },
    });
    const first = manager.handleCommand(command("project-clone-concurrent-1", "project.clone", null, {
      name: "Concurrent Clone",
      repository: "owner/repository",
    }));
    await waitUntil(() => started);
    const nextRoot = join(directory, "root-change-during-clone");
    mkdirSync(nextRoot);
    expect(() => manager.setProjectsRoot(nextRoot)).toThrow("cannot be changed while a repository is being cloned");
    expect(manager.getProjectsRoot()).toBe(directory);
    const second = await manager.handleCommand(command("project-clone-concurrent-2", "project.clone", null, {
      name: "Concurrent Clone",
      repository: "owner/repository",
    }));
    expect(second).toMatchObject({ success: false, error: expect.stringContaining("already being cloned") });
    release();
    await expect(first).resolves.toMatchObject({ success: true });
    expect(events.currentSnapshot().projects.filter((project) => project.name === "Concurrent Clone")).toHaveLength(1);
  });

  it("persists projects root changes and creates future projects there", async () => {
    const nextRoot = join(directory, "projects-root");
    mkdirSync(nextRoot);
    expect(manager.setProjectsRoot(nextRoot)).toBe(nextRoot);

    await manager.stopAll();
    config.projectsRoot = join(directory, "obsolete-config-root");
    manager = new SessionManager(config, database, events);
    expect(manager.getProjectsRoot()).toBe(nextRoot);

    const created = await manager.handleCommand(command("project-in-saved-root", "project.create", null, {
      name: "Saved Root Project",
    }));
    expect(created.success).toBe(true);
    expect(events.currentSnapshot().projects).toContainEqual(expect.objectContaining({
      name: "Saved Root Project",
      path: join(nextRoot, "saved-root-project"),
    }));
  });

  it("returns the canonical durable run when cancellation is accepted", async () => {
    await manager.stopAll();
    const run: SubagentRun = {
      id: "run-cancel-contract",
      parentSessionId: requestedSessionId,
      parentToolCallId: "tool-cancel-contract",
      childSessionId: "child-cancel-contract",
      role: "builder",
      status: "cancelled",
      taskPreview: "Cancel this worker",
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:01.000Z",
      endedAt: "2026-07-23T01:00:01.000Z",
    };
    const cancelSubagent = vi.fn(async () => run);
    manager = new SessionManager(config, database, events, { cancelSubagent });
    await manager.handleCommand(command("create-cancel-contract-parent", "session.create", null, {
      projectId: "anvil", sessionId: requestedSessionId,
    }));

    const response = await manager.handleCommand(command("cancel-contract", "subagent.cancel", requestedSessionId, {
      runId: run.id,
    }));

    expect(response).toMatchObject({ success: true, data: run });
    expect(cancelSubagent).toHaveBeenCalledWith(requestedSessionId, run.id);
  });

  it("excludes only delegation tools from parent and child Pi runtimes", async () => {
    config.piExtensionPath = join(directory, "ocode-extension.ts");
    await manager.stopAll();
    manager = new SessionManager(config, database, events);
    const created = await manager.handleCommand(command("create-tool-policy-parent", "session.create", null, {
      projectId: "anvil", sessionId: requestedSessionId,
    }));
    const parentSessionId = (created.data as { sessionId: string }).sessionId;
    const childSessionId = "01959f7e-7d64-7000-8000-000000000002";
    manager.createSubagentSession({ sessionId: childSessionId, parentSessionId, title: "Worker" });
    await waitUntil(() => existsSync(join(config.sessionDir, parentSessionId, "runtime-args.json")) &&
      existsSync(join(config.sessionDir, childSessionId, "runtime-args.json")));

    const args = (sessionId: string) => JSON.parse(
      readFileSync(join(config.sessionDir, sessionId, "runtime-args.json"), "utf8"),
    ) as string[];
    const parentArgs = args(parentSessionId);
    const childArgs = args(childSessionId);
    expect(parentArgs.slice(parentArgs.indexOf("--exclude-tools"), parentArgs.indexOf("--exclude-tools") + 2))
      .toEqual(["--exclude-tools", "subagent"]);
    expect(childArgs.slice(childArgs.indexOf("--exclude-tools"), childArgs.indexOf("--exclude-tools") + 2))
      .toEqual(["--exclude-tools", "subagent,ocode_subagent"]);
    expect(parentArgs).toContain(config.piExtensionPath);
    expect(childArgs).toContain(config.piExtensionPath);
    expect(parentArgs).not.toContain("--tools");
    expect(childArgs).not.toContain("--tools");
  });

  it.each([
    { state: "idle/settled", expectedRpcType: "prompt" },
    { state: "busy", expectedRpcType: "follow_up" },
  ] as const)("delivers one internal completion to a $state parent through $expectedRpcType", async ({ state, expectedRpcType }) => {
    const created = await manager.handleCommand(command(`create-internal-delivery-${state}`, "session.create", null, {
      projectId: "anvil", sessionId: requestedSessionId,
    }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    await waitUntil(() => (events.currentSnapshot().catalogs[sessionId]?.models.length ?? 0) > 0);
    if (state === "busy") {
      const busy = await manager.handleCommand(command("busy-parent", "prompt.send", sessionId, {
        content: "Hang tool", delivery: "prompt",
      }));
      expect(busy.success).toBe(true);
      await waitUntil(() => events.currentSnapshot().runStates[sessionId] === "running");
    } else {
      const settled = await manager.handleCommand(command("settle-idle-parent", "session.settled", sessionId, {
        settled: true,
      }));
      expect(settled.success).toBe(true);
    }
    const promptedBefore = database.readEventsAfter(0).filter((event) => event.type === "session.prompted").length;
    const activityBefore = database.getSession(sessionId)?.session.lastUserMessageAt;
    const timestamp = new Date().toISOString();
    const admitted = database.subagents.admit({
      parentSessionId: sessionId,
      parentToolCallId: `tool-delivery-${state}`,
      childSessionId: `child-delivery-${state}`,
      role: "reviewer",
      taskPreview: "Review delivery",
      timestamp,
    });
    events.acceptSubagentEvents(admitted.events);
    const transition = database.subagents.updateStatus(admitted.run.id, "completed", timestamp, {
      resultPreview: "The child found the issue.",
    })!;
    events.acceptSubagentEvents(transition.events);
    const completed = transition.run;
    const completion = subagentCompletionContent(completed);
    const deliveryId = completed.notification!.id;

    const [delivered, duplicate] = await Promise.all([
      manager.deliverSubagentCompletion(deliveryId, sessionId, completion),
      manager.deliverSubagentCompletion(deliveryId, sessionId, "different content"),
    ]);

    expect(delivered.success).toBe(true);
    expect(duplicate).toEqual(delivered);
    const requests = readFileSync(join(config.sessionDir, sessionId, "rpc-requests.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(requests.filter((request) => request.message === completion)).toEqual([
      expect.objectContaining({ type: expectedRpcType }),
    ]);
    expect(requests.some((request) => request.message === "different content")).toBe(false);
    expect(database.readEventsAfter(0).filter((event) => event.type === "session.prompted")).toHaveLength(promptedBefore);
    expect(database.getSession(sessionId)?.session.lastUserMessageAt).toBe(activityBefore);
    if (state === "idle/settled") {
      expect(database.getSession(sessionId)?.session.settled).toBe(false);
      const injected = events.timelineForSession(sessionId).find((entry) =>
        entry.kind === "message" && entry.origin?.type === "subagentCompletion"
      );
      expect(injected).toMatchObject({
        role: "user",
        origin: {
          type: "subagentCompletion",
          runId: completed.id,
          childSessionId: completed.childSessionId,
          deliveryId,
          role: "reviewer",
          status: "completed",
        },
      });
    }
  });

  it.each(["session", "project"] as const)("stops and deletes owned child runtimes before %s deletion", async (scope) => {
    await manager.stopAll();
    let coordinator!: SubagentCoordinator;
    manager = new SessionManager(config, database, events, {
      deleteOwnedSubagents: (parentSessionId) => coordinator.deleteOwnedChildren(parentSessionId),
      finishParentSubagentDeletion: (parentSessionId) => coordinator.finishParentDeletion(parentSessionId),
      prepareChildSubagentDeletion: (childSessionId) => coordinator.prepareChildDeletion(childSessionId),
    });
    coordinator = new SubagentCoordinator(database, events, manager, 1);
    try {
      const created = await manager.handleCommand(command(`create-owned-${scope}`, "session.create", null, {
        projectId: "anvil", sessionId: requestedSessionId,
      }));
      const parentSessionId = (created.data as { sessionId: string }).sessionId;
      const run = coordinator.launch({
        parentSessionId, parentToolCallId: `tool-owned-${scope}`, role: "builder", task: "Subagent stays busy",
      });
      await waitUntil(() => database.subagents.get(run.id)?.status === "running");
      const runtimes = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
      expect(runtimes.has(run.childSessionId)).toBe(true);

      const deleted = scope === "session"
        ? await manager.handleCommand(command("delete-owned-parent", "session.delete", null, { sessionId: parentSessionId }))
        : await manager.handleCommand(command("delete-owned-project", "project.delete", null, { projectId: "anvil" }));

      expect(deleted.error).toBeUndefined();
      expect(deleted).toMatchObject({ success: true });
      expect(database.getSession(parentSessionId)).toBeUndefined();
      expect(database.getSession(run.childSessionId)).toBeUndefined();
      expect(database.subagents.get(run.id)).toBeUndefined();
      expect(runtimes.has(run.childSessionId)).toBe(false);
      expect(events.currentSnapshot().sessions.some((session) => session.id === run.childSessionId)).toBe(false);
    } finally {
      coordinator.stop();
    }
  });

  it("directly deletes an internal child without deadlocking its lifecycle cancellation", async () => {
    await manager.stopAll();
    let coordinator!: SubagentCoordinator;
    manager = new SessionManager(config, database, events, {
      deleteOwnedSubagents: (parentSessionId) => coordinator.deleteOwnedChildren(parentSessionId),
      finishParentSubagentDeletion: (parentSessionId) => coordinator.finishParentDeletion(parentSessionId),
      prepareChildSubagentDeletion: (childSessionId) => coordinator.prepareChildDeletion(childSessionId),
    });
    coordinator = new SubagentCoordinator(database, events, manager, 1);
    try {
      const created = await manager.handleCommand(command("create-parent-for-child-delete", "session.create", null, {
        projectId: "anvil", sessionId: requestedSessionId,
      }));
      const parentSessionId = (created.data as { sessionId: string }).sessionId;
      const run = coordinator.launch({
        parentSessionId, parentToolCallId: "tool-direct-child-delete", task: "Subagent stays busy",
      });
      await waitUntil(() => database.subagents.get(run.id)?.status === "running");

      const deleted = await manager.handleCommand(command("delete-internal-child", "session.delete", null, {
        sessionId: run.childSessionId,
      }));

      expect(deleted).toMatchObject({ success: true });
      expect(database.getSession(parentSessionId)).toBeDefined();
      expect(database.getSession(run.childSessionId)).toBeUndefined();
      expect(database.subagents.get(run.id)).toBeUndefined();
    } finally {
      coordinator.stop();
    }
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
    events = new ForgeEventService(database, config.projects, artifacts);
    manager = new SessionManager(config, database, events);
    expect(events.currentSnapshot().sessions.some((session) => session.id === sessionId)).toBe(false);
    expect(existsSync(runtimeDirectory)).toBe(false);
  });

  it("removes all project sessions without touching the workspace or reseeding config on restart", async () => {
    const workspaceFile = join(directory, "workspace-stays.txt");
    writeFileSync(workspaceFile, "keep");
    const created = await manager.handleCommand(command("create-project-removal", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    expect(created.success).toBe(true);
    const runtimeDirectory = join(config.sessionDir, requestedSessionId);
    expect(existsSync(runtimeDirectory)).toBe(true);
    const attachment = events.ingestAttachment(
      requestedSessionId,
      Buffer.from("private attachment"),
      "text/plain",
      "private.txt",
    );
    const attachmentPath = artifacts.pathFor(attachment.artifactId)!;
    expect(existsSync(attachmentPath)).toBe(true);

    const [removed, duplicateRemoval] = await Promise.all([
      manager.handleCommand(command("remove-project", "project.delete", null, { projectId: "anvil" })),
      manager.handleCommand(command("remove-project-again", "project.delete", null, { projectId: "anvil" })),
    ]);

    expect(removed.success).toBe(true);
    expect(duplicateRemoval.success).toBe(false);
    expect(duplicateRemoval.error).toBe("Project not found");
    expect(events.currentSnapshot().projects).toEqual([]);
    expect(events.currentSnapshot().sessions).toEqual([]);
    expect(database.listProjects()).toEqual([]);
    expect(database.getSession(requestedSessionId)).toBeUndefined();
    expect(database.getArtifact(attachment.artifactId)).toBeUndefined();
    expect(existsSync(runtimeDirectory)).toBe(false);
    expect(existsSync(attachmentPath)).toBe(false);
    expect(readFileSync(workspaceFile, "utf8")).toBe("keep");
    expect(existsSync(directory)).toBe(true);

    await manager.stopAll();
    events = new ForgeEventService(database, config.projects, artifacts);
    manager = new SessionManager(config, database, events);
    expect(events.currentSnapshot().projects).toEqual([]);
    expect(database.listProjects()).toEqual([]);
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
        type: "tool.started",
        sessionId,
        timestamp: "2026-07-23T01:00:02.000Z",
        payload: {
          tool: {
            id: "tool-interrupted",
            kind: "tool",
            toolCallId: "call-interrupted",
            name: "bash",
            summary: "Run script",
            status: "running",
            arguments: {},
            output: [],
            createdAt: "2026-07-23T01:00:02.000Z",
          },
        },
      },
      {
        type: "interaction.requested",
        sessionId,
        timestamp: "2026-07-23T01:00:03.000Z",
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
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "tool",
      toolCallId: "call-interrupted",
      status: "failed",
    }));
    expect(database.getSession(sessionId)?.session.status).toBe("failed");
  });

  it("fails startup when Pi cannot load the model catalog", async () => {
    const sessionDir = join(config.sessionDir, requestedSessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "fail-model-discovery"), "");

    await manager.handleCommand(command("create-model-failure", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));

    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.status === "failed",
    ));
    expect(events.currentSnapshot().timelines[requestedSessionId]).toContainEqual(expect.objectContaining({
      kind: "event",
      category: "error",
      message: "Model discovery unavailable",
    }));
  });

  it("waits for a new session's model catalog before configuring it", async () => {
    const created = await manager.handleCommand(command("create-configuring", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    const sessionId = (created.data as { sessionId: string }).sessionId;

    const model = await manager.handleCommand(command("model-while-starting", "model.set", sessionId, {
      modelId: "test/model-1",
    }));

    expect(model.success).toBe(true);
  });

  it("waits for a new session's model catalog before changing its thinking level", async () => {
    const created = await manager.handleCommand(command("create-thinking", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    const sessionId = (created.data as { sessionId: string }).sessionId;

    const thinking = await manager.handleCommand(command("thinking-while-starting", "thinking.set", sessionId, {
      level: "high",
    }));

    expect(thinking.success).toBe(true);
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

  it("stops idle runtimes without changing thread settlement and restores them on demand", async () => {
    await manager.stopAll();
    manager = new SessionManager(config, database, events, { idleRuntimeTimeoutMs: 20 });
    await manager.handleCommand(command("create-idle", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));
    const runtimes = () => (manager as unknown as { runtimes: Map<string, unknown> }).runtimes;
    await waitUntil(() => (events.currentSnapshot().catalogs[requestedSessionId]?.models.length ?? 0) > 0);
    const configured = await manager.handleCommand(command("model-before-idle", "model.set", requestedSessionId, {
      modelId: "test/model-1",
    }));
    expect(configured.success).toBe(true);

    await waitUntil(() => !runtimes().has(requestedSessionId));
    expect(database.getSession(requestedSessionId)?.session.settled).toBe(false);

    const response = await manager.handleCommand(command("prompt-after-idle", "prompt.send", requestedSessionId, {
      content: "Resume idle runtime",
      delivery: "prompt",
    }));
    expect(response.success).toBe(true);
    expect(runtimes().has(requestedSessionId)).toBe(true);
  });

  it("coalesces adjacent streaming deltas before journaling them", async () => {
    await manager.handleCommand(command("create-stream", "session.create", null, {
      projectId: "anvil",
      sessionId: requestedSessionId,
    }));
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === requestedSessionId && session.title === "Runtime test",
    ));

    const response = await manager.handleCommand(command("prompt-stream", "prompt.send", requestedSessionId, {
      content: "Stream output",
      delivery: "prompt",
    }));

    expect(response.success).toBe(true);
    const deltas = database.readEventsAfter(0).filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ payload: { delta: "Hello world" } });
  });

  it("fails a tool visibly when it never reports completion, even without a declared timeout", async () => {
    await manager.stopAll();
    manager = new SessionManager(config, database, events, { defaultBashTimeoutMs: 20 });
    const created = await manager.handleCommand(command("create-hung", "session.create", null, { projectId: "anvil", sessionId: requestedSessionId }));
    const sessionId = (created.data as { sessionId: string }).sessionId;
    const response = await manager.handleCommand(command("prompt-hung", "prompt.send", sessionId, {
      content: "Hang tool",
      delivery: "prompt",
    }));

    expect(response.success).toBe(true);
    await waitUntil(() => events.currentSnapshot().sessions.some(
      (session) => session.id === sessionId && session.status === "failed",
    ));
    expect(events.currentSnapshot().timelines[sessionId]).toContainEqual(expect.objectContaining({
      kind: "tool",
      toolCallId: "call-hung",
      status: "failed",
      output: [expect.objectContaining({
        type: "text",
        text: expect.stringContaining("timeout without reporting completion"),
      })],
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.currentSnapshot().sessions.find((session) => session.id === sessionId)).toMatchObject({
      status: "idle",
      lastTerminalOutcome: "cancelled",
    });
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
