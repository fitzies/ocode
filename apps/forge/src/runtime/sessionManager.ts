import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  createPiRpcAdapterState,
  normalizePiRpcRecord,
  type PiRpcAdapterState,
  type UnsequencedAnvilEvent,
} from "@anvil/pi-rpc";
import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type JsonValue,
  type ProjectSummary,
  type SessionSummary,
  type ToolEntry,
} from "@anvil/protocol";

import type { ForgeConfig } from "../config.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase, type RuntimeSessionRecord } from "../store/database.ts";
import { createPiRpcProcess, type RpcRecord, type RpcSubprocess } from "../rpc/subprocess.ts";
import { WorkspaceFileIndex } from "./workspaceFiles.ts";

interface SessionManagerOptions {
  defaultToolTimeoutMs?: number;
  defaultBashTimeoutMs?: number;
}

interface ManagedSession {
  rpc: RpcSubprocess;
  adapter: PiRpcAdapterState;
  baseTimestamp: number;
  stopping: boolean;
  failureReported: boolean;
  commandTail: Promise<unknown>;
  suppressedResponseIds: Set<string>;
  toolTimers: Map<string, NodeJS.Timeout>;
}

function commandResponse(
  command: AnvilClientCommand,
  success: boolean,
  input: { data?: JsonValue; error?: string; outcome?: "completed" | "unknown" } = {},
): AnvilCommandResponse {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: randomUUID(),
    commandId: command.id,
    timestamp: new Date().toISOString(),
    success,
    outcome: input.outcome ?? "completed",
    data: input.data,
    error: input.error,
  };
}

function domainEvent<T extends AnvilEvent["type"]>(
  type: T,
  payload: Extract<AnvilEvent, { type: T }>["payload"],
  sessionId: string | null,
): UnsequencedAnvilEvent {
  return {
    type,
    payload,
    sessionId,
    timestamp: new Date().toISOString(),
  } as UnsequencedAnvilEvent;
}

function rpcFailure(record: RpcRecord): string | undefined {
  return record.type === "response" && record.success === false
    ? typeof record.error === "string" ? record.error : "Pi rejected the command"
    : undefined;
}

function rpcData(record: RpcRecord): Record<string, unknown> {
  return record.type === "response" && record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : {};
}

function escapeFileAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || /^(application\/(json|xml|javascript|typescript|x-sh|yaml|toml))$/i.test(mediaType);
}

const PI_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function gitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") return branch;
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit ? `detached-${commit}` : undefined;
  } catch {
    return undefined;
  }
}

function detectedImageMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const prefix = bytes.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export class SessionManager {
  private readonly projects = new Map<string, ProjectSummary>();
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly starting = new Map<string, Promise<ManagedSession>>();
  private readonly inFlightCommands = new Map<string, Promise<AnvilCommandResponse>>();
  private readonly interactionTimers = new Map<string, NodeJS.Timeout>();
  private readonly deleting = new Set<string>();
  private readonly workspaceFiles = new WorkspaceFileIndex();
  private shuttingDown = false;

  constructor(
    private readonly config: ForgeConfig,
    private readonly database: ForgeDatabase,
    private readonly events: ForgeEventService,
    private readonly options: SessionManagerOptions = {},
  ) {
    const restored = events.currentSnapshot();
    for (const project of restored.projects) this.projects.set(project.id, project);
    for (const project of restored.projects) this.refreshProjectBranch(project.id);
    this.cleanupOrphanSessionDirectories(new Set(restored.sessions.map((session) => session.id)));
    const staleInteractions = restored.pendingInteractions;
    const interruptedSessionIds = new Set(
      restored.sessions
        .filter((session) =>
          restored.runStates[session.id] === "running" ||
          session.status === "running" ||
          session.status === "waiting"
        )
        .map((session) => session.id),
    );
    if (staleInteractions.length > 0 || interruptedSessionIds.size > 0) {
      events.append([
        ...staleInteractions.map((request) => domainEvent(
          "interaction.resolved",
          { requestId: request.id, status: "cancelled" },
          request.sessionId,
        )),
        ...[...interruptedSessionIds].flatMap((sessionId) => [
          ...this.toolFailureEvents(sessionId, "Interrupted by Forge restart"),
          domainEvent(
            "run.status",
            { status: "failed", outcome: "failed", message: "Interrupted by Forge restart" },
            sessionId,
          ),
        ]),
      ]);
      for (const sessionId of interruptedSessionIds) this.syncSession(sessionId);
    }
    events.on("event", this.onEvent);
  }

  handleCommand = async (command: AnvilClientCommand): Promise<AnvilCommandResponse> => {
    const inFlight = this.inFlightCommands.get(command.id);
    if (inFlight) return inFlight;

    const persisted = this.database.beginCommand(command);
    if (typeof persisted === "object") return persisted;
    if (persisted !== "started") {
      return commandResponse(command, false, {
        outcome: "unknown",
        error: persisted === "pending"
          ? "The command is still pending"
          : "The command outcome is unknown after a Forge restart",
      });
    }

    const execution = this.dispatch(command)
      .catch((error) => commandResponse(command, false, {
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((response) => {
        this.database.completeCommand(response);
        return response;
      })
      .finally(() => this.inFlightCommands.delete(command.id));
    this.inFlightCommands.set(command.id, execution);
    return execution;
  };

  searchFiles = async (sessionId: string, query: string, limit: number): Promise<string[] | undefined> => {
    const stored = this.database.getSession(sessionId);
    if (!stored) return undefined;
    const project = this.projects.get(stored.session.projectId);
    if (!project) return undefined;
    return this.workspaceFiles.search(project.path, query, limit);
  };

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      runtime.stopping = true;
      this.clearToolTimers(runtime);
      runtime.rpc.stop();
    }
    await Promise.all(runtimes.map(async (runtime) => {
      let timeout: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        runtime.rpc.waitForExit().then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 2_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!exited) {
        runtime.rpc.stop("SIGKILL");
        await runtime.rpc.waitForExit();
      }
    }));
    this.runtimes.clear();
    this.starting.clear();
    for (const timer of this.interactionTimers.values()) clearTimeout(timer);
    this.interactionTimers.clear();
    this.events.off("event", this.onEvent);
  }

  private async dispatch(command: AnvilClientCommand): Promise<AnvilCommandResponse> {
    if (command.type === "project.create") return this.createProject(command);
    if (command.type === "session.select") return commandResponse(command, true);
    if (command.type === "session.create") return this.createSession(command);
    if (command.type === "session.delete") return this.deleteSession(command);
    if (command.type === "session.settled") return this.setSessionSettled(command);
    if (!command.sessionId) return commandResponse(command, false, { error: "A session is required" });

    const stored = this.database.getSession(command.sessionId);
    if (!stored) return commandResponse(command, false, { error: "Session not found" });
    const snapshot = this.events.currentSnapshot();
    const catalog = snapshot.catalogs[command.sessionId];
    if (command.type === "model.set" && !catalog?.models.some(
      (model) => model.id === command.payload.modelId,
    )) {
      return commandResponse(command, false, { error: "Model is not available in this session" });
    }
    if (command.type === "thinking.set") {
      const session = snapshot.sessions.find((candidate) => candidate.id === command.sessionId);
      const model = catalog?.models.find((candidate) => candidate.id === session?.modelId);
      if (!model?.supportedThinkingLevels.includes(command.payload.level)) {
        return commandResponse(command, false, {
          error: "Thinking level is not supported by this session's model",
        });
      }
    }
    const runtime = await this.ensureRuntime(stored);

    if (command.type === "run.cancel") {
      const previousOutcome = runtime.adapter.terminalOutcomeInCurrentRun;
      runtime.adapter.terminalOutcomeInCurrentRun = "cancelled";
      let response: AnvilCommandResponse;
      try {
        response = await this.sendRpc(command, runtime, { type: "abort" });
      } catch (error) {
        runtime.adapter.terminalOutcomeInCurrentRun = previousOutcome;
        throw error;
      }
      if (response.success) {
        const pending = this.events.currentSnapshot().pendingInteractions.filter(
          (request) => request.sessionId === command.sessionId,
        );
        for (const request of pending) {
          runtime.rpc.send({
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
          });
        }
        this.events.append([
          ...pending.map((request) => domainEvent(
            "interaction.resolved",
            { requestId: request.id, status: "cancelled" },
            command.sessionId,
          )),
          domainEvent("run.status", { status: "idle", outcome: "cancelled" }, command.sessionId),
        ]);
        this.syncSession(command.sessionId);
      } else {
        runtime.adapter.terminalOutcomeInCurrentRun = previousOutcome;
      }
      return response;
    }
    if (command.type === "interaction.respond") {
      const pending = this.events.currentSnapshot().pendingInteractions.some(
        (request) => request.id === command.payload.requestId && request.sessionId === command.sessionId,
      );
      if (!pending) return commandResponse(command, false, { error: "Interaction is no longer pending" });
      runtime.rpc.send({
        type: "extension_ui_response",
        id: command.payload.requestId,
        ...(command.payload.cancelled ? { cancelled: true } : {}),
        ...(command.payload.confirmed === undefined ? {} : { confirmed: command.payload.confirmed }),
        ...(command.payload.value === undefined ? {} : { value: command.payload.value }),
      });
      this.events.append([domainEvent(
        "interaction.resolved",
        {
          requestId: command.payload.requestId,
          status: command.payload.cancelled ? "cancelled" : "answered",
          response: command.payload,
        },
        command.sessionId,
      )]);
      return commandResponse(command, true);
    }

    return this.enqueue(runtime, async () => {
      if (command.type === "prompt.send") {
        const images = command.payload.images?.map((image) => {
          if (!image.data) throw new Error("Live Pi prompts require inline image data");
          return { type: "image", data: image.data, mimeType: image.mimeType };
        }) ?? [];
        const attachmentContext: string[] = [];
        for (const attachment of command.payload.attachments ?? []) {
          const metadata = this.events.artifact(attachment.artifactId);
          const path = this.events.artifactPath(attachment.artifactId);
          if (!metadata || metadata.sessionId !== command.sessionId || !path) {
            throw new Error(`Attachment is unavailable: ${attachment.name ?? attachment.artifactId}`);
          }
          const name = metadata.name ?? attachment.name ?? attachment.artifactId;
          if (PI_IMAGE_MEDIA_TYPES.has(metadata.mediaType)) {
            if (metadata.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
              throw new Error(`Image attachment exceeds 8 MB: ${name}`);
            }
            const bytes = await readFile(path);
            const detectedMediaType = detectedImageMediaType(bytes);
            if (detectedMediaType !== metadata.mediaType) {
              throw new Error(`Image attachment content does not match its media type: ${name}`);
            }
            images.push({
              type: "image",
              data: bytes.toString("base64"),
              mimeType: detectedMediaType,
            });
            attachmentContext.push(`<file name="${escapeFileAttribute(name)}"></file>`);
          } else if (isTextMediaType(metadata.mediaType) && metadata.byteLength <= MAX_INLINE_TEXT_ATTACHMENT_BYTES) {
            const text = await readFile(path, "utf8");
            attachmentContext.push(`<file name="${escapeFileAttribute(name)}">\n${text}\n</file>`);
          } else {
            attachmentContext.push(`<file name="${escapeFileAttribute(path)}">Uploaded as ${escapeFileAttribute(name)}. Inspect this file with the available tools.</file>`);
          }
        }
        const message = attachmentContext.length
          ? `${command.payload.content}${command.payload.content ? "\n\n" : ""}${attachmentContext.join("\n")}`
          : command.payload.content;
        const type = command.payload.delivery === "followUp"
          ? "follow_up"
          : command.payload.delivery === "steer" ? "steer" : "prompt";
        const response = await this.sendRpc(command, runtime, {
          type,
          message,
          ...(images.length ? { images } : {}),
        });
        if (response.success && command.payload.attachments?.length) {
          this.events.consumeAttachments(
            stored.session.id,
            command.payload.attachments.map((attachment) => attachment.artifactId),
          );
        }
        return response;
      }
      if (command.type === "model.set") {
        const separator = command.payload.modelId.indexOf("/");
        if (separator <= 0 || separator === command.payload.modelId.length - 1) {
          return commandResponse(command, false, { error: "Model id must use provider/model format" });
        }
        const response = await this.sendRpc(command, runtime, {
          type: "set_model",
          provider: command.payload.modelId.slice(0, separator),
          modelId: command.payload.modelId.slice(separator + 1),
        });
        if (response.success) await runtime.rpc.sendRequest({ type: "get_state" });
        return response;
      }
      if (command.type === "thinking.set") {
        const response = await this.sendRpc(command, runtime, {
          type: "set_thinking_level",
          level: command.payload.level,
        });
        if (response.success) await runtime.rpc.sendRequest({ type: "get_state" });
        return response;
      }
      return commandResponse(command, false, { error: "Unsupported command" });
    });
  }

  private readonly onEvent = (event: AnvilEvent): void => {
    if (event.type === "interaction.resolved") {
      const timer = this.interactionTimers.get(event.payload.requestId);
      if (timer) clearTimeout(timer);
      this.interactionTimers.delete(event.payload.requestId);
      return;
    }
    if (event.type !== "interaction.requested") return;
    const request = event.payload.request;
    const timeoutMs = request.timeoutMs;
    if (timeoutMs === undefined) return;
    const remaining = Math.max(
      0,
      new Date(request.requestedAt).getTime() + timeoutMs - Date.now(),
    );
    const timer = setTimeout(() => {
      this.interactionTimers.delete(request.id);
      const stillPending = this.events.currentSnapshot().pendingInteractions.some(
        (candidate) => candidate.id === request.id,
      );
      if (stillPending) {
        const runtime = this.runtimes.get(request.sessionId);
        if (runtime?.rpc.running) {
          try {
            runtime.rpc.send({
              type: "extension_ui_response",
              id: request.id,
              cancelled: true,
            });
          } catch {
            // Runtime exit cleanup will resolve the interaction if the process disappeared.
          }
        }
        this.events.append([domainEvent(
          "interaction.resolved",
          { requestId: request.id, status: "cancelled" },
          request.sessionId,
        )]);
      }
    }, remaining);
    this.interactionTimers.set(request.id, timer);
  };

  private createProject(
    command: Extract<AnvilClientCommand, { type: "project.create" }>,
  ): AnvilCommandResponse {
    const name = command.payload.name.trim();
    const requestedPath = command.payload.path.trim();
    if (!name || name.length > 80) {
      return commandResponse(command, false, { error: "Workspace name must be between 1 and 80 characters" });
    }
    if (!requestedPath) return commandResponse(command, false, { error: "Workspace path is required" });

    let path: string;
    try {
      path = realpathSync(resolve(requestedPath));
      if (!statSync(path).isDirectory()) {
        return commandResponse(command, false, { error: "Workspace path is not a directory" });
      }
    } catch {
      return commandResponse(command, false, { error: "Workspace path does not exist or is not accessible" });
    }
    if ([...this.projects.values()].some((project) => project.path === path)) {
      return commandResponse(command, false, { error: "That workspace path is already configured" });
    }
    if ([...this.projects.values()].some((project) => project.name.toLowerCase() === name.toLowerCase())) {
      return commandResponse(command, false, { error: "A workspace with that name already exists" });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
    const project: ProjectSummary = {
      id: `${slug}-${randomUUID().slice(0, 8)}`,
      name,
      path,
    };
    this.events.createProject(
      project,
      domainEvent("project.upserted", { project }, null),
    );
    this.projects.set(project.id, project);
    return commandResponse(command, true, { data: { projectId: project.id } });
  }

  private createSession(
    command: Extract<AnvilClientCommand, { type: "session.create" }>,
  ): AnvilCommandResponse {
    const project = this.projects.get(command.payload.projectId);
    if (!project) return commandResponse(command, false, { error: "Project is not configured on Forge" });
    const sessionId = command.payload.sessionId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      return commandResponse(command, false, { error: "Session id must be a UUID" });
    }
    if (this.database.getSession(sessionId)) {
      return commandResponse(command, false, { error: "Session id already exists" });
    }
    const timestamp = new Date().toISOString();
    const session: SessionSummary = {
      id: sessionId,
      projectId: project.id,
      title: "New session",
      updatedAt: timestamp,
      status: "idle",
      modelId: "unknown",
      thinkingLevel: "off",
      settled: false,
      branch: gitBranch(project.path),
    };
    this.events.createSession(
      session,
      domainEvent("session.upserted", { session }, session.id),
    );

    void this.ensureRuntime({ session }).catch((error) => {
      if (this.shuttingDown || this.deleting.has(session.id)) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = this.events.currentSnapshot().sessions.find(
        (candidate) => candidate.id === session.id,
      );
      if (current && current.status !== "failed") {
        this.events.append([
          domainEvent("run.status", { status: "failed", outcome: "failed", message }, session.id),
        ]);
        this.syncSession(session.id);
      }
      process.stderr.write(`[pi:${session.id}] Session startup failed: ${message}\n`);
    });

    return commandResponse(command, true, { data: { sessionId: session.id } });
  }

  private setSessionSettled(
    command: Extract<AnvilClientCommand, { type: "session.settled" }>,
  ): AnvilCommandResponse {
    if (!command.sessionId || !this.database.getSession(command.sessionId)) {
      return commandResponse(command, false, { error: "Session not found" });
    }
    this.events.setSessionSettled(
      command.sessionId,
      command.payload.settled,
      domainEvent("session.settled", { settled: command.payload.settled }, command.sessionId),
    );
    return commandResponse(command, true);
  }

  private async deleteSession(
    command: Extract<AnvilClientCommand, { type: "session.delete" }>,
  ): Promise<AnvilCommandResponse> {
    const sessionId = command.payload.sessionId;
    const stored = this.database.getSession(sessionId);
    if (!stored) return commandResponse(command, false, { error: "Session not found" });

    this.deleting.add(sessionId);
    try {
      const starting = this.starting.get(sessionId);
      const runtime = this.runtimes.get(sessionId);
      if (runtime) await this.stopRuntime(runtime);
      if (starting) await starting.catch(() => undefined);
      const settledRuntime = this.runtimes.get(sessionId);
      if (settledRuntime && settledRuntime !== runtime) await this.stopRuntime(settledRuntime);
      this.runtimes.delete(sessionId);

      const pending = this.events.currentSnapshot().pendingInteractions.filter(
        (request) => request.sessionId === sessionId,
      );
      for (const request of pending) {
        const timer = this.interactionTimers.get(request.id);
        if (timer) clearTimeout(timer);
        this.interactionTimers.delete(request.id);
      }

      this.events.deleteSession(
        sessionId,
        domainEvent("session.deleted", { sessionId }, sessionId),
      );
      try {
        rmSync(join(this.config.sessionDir, sessionId), { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(
          `[pi:${sessionId}] Session deleted; file cleanup will retry after restart: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return commandResponse(command, true);
    } finally {
      this.deleting.delete(sessionId);
    }
  }

  private async stopRuntime(runtime: ManagedSession): Promise<void> {
    runtime.stopping = true;
    if (runtime.rpc.running) runtime.rpc.stop();
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      runtime.rpc.waitForExit().then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited) {
      runtime.rpc.stop("SIGKILL");
      await runtime.rpc.waitForExit();
    }
  }

  async getIndicatorSource(sessionId: string): Promise<{
    projectPath: string;
    context?: { tokens: number | null; contextWindow: number; percent: number | null };
  } | undefined> {
    const stored = this.database.getSession(sessionId);
    if (!stored) return undefined;
    const project = this.projects.get(stored.session.projectId);
    if (!project) return undefined;
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.rpc.running) return { projectPath: project.path };
    let response: RpcRecord;
    try {
      response = await this.sendSuppressedRequest(runtime, { type: "get_session_stats" });
    } catch {
      return { projectPath: project.path };
    }
    if (rpcFailure(response)) return { projectPath: project.path };
    const context = rpcData(response).contextUsage;
    const item = context && typeof context === "object" && !Array.isArray(context)
      ? context as Record<string, unknown>
      : undefined;
    const contextWindow = typeof item?.contextWindow === "number" ? item.contextWindow : undefined;
    return {
      projectPath: project.path,
      context: contextWindow === undefined ? undefined : {
        tokens: typeof item?.tokens === "number" ? item.tokens : null,
        contextWindow,
        percent: typeof item?.percent === "number" ? item.percent : null,
      },
    };
  }

  private async ensureRuntime(stored: RuntimeSessionRecord): Promise<ManagedSession> {
    const existing = this.runtimes.get(stored.session.id);
    if (existing?.rpc.running) return existing;
    const pending = this.starting.get(stored.session.id);
    if (pending) return pending;

    const starting = this.startRuntime(stored).finally(() => this.starting.delete(stored.session.id));
    this.starting.set(stored.session.id, starting);
    return starting;
  }

  private async startRuntime(stored: RuntimeSessionRecord): Promise<ManagedSession> {
    const project = this.projects.get(stored.session.projectId);
    if (!project) throw new Error("The session project is no longer configured");
    const baseTimestamp = Date.now();
    const adapter = createPiRpcAdapterState({
      fixtureId: `pi-${stored.session.id}`,
      sessionId: stored.session.id,
      baseTimestamp: new Date(baseTimestamp).toISOString(),
    });
    const sessionDir = join(this.config.sessionDir, stored.session.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const rpc = createPiRpcProcess({
      executable: this.config.piExecutable,
      cwd: project.path,
      sessionDir,
    });
    const runtime: ManagedSession = {
      rpc,
      adapter,
      baseTimestamp,
      stopping: false,
      failureReported: false,
      commandTail: Promise.resolve(),
      suppressedResponseIds: new Set(),
      toolTimers: new Map(),
    };
    this.runtimes.set(stored.session.id, runtime);

    rpc.on("record", (record: RpcRecord) => this.onRecord(stored.session.id, runtime, record));
    rpc.on("stderr", (text: string) => process.stderr.write(`[pi:${stored.session.id}] ${text}`));
    rpc.on("protocolError", (error: Error) => process.stderr.write(`[pi:${stored.session.id}] ${error.message}\n`));
    rpc.on("exit", () => this.onExit(stored.session.id, runtime));
    rpc.start();

    try {
      if (stored.piSessionFile) {
        const switched = await this.sendSuppressedRequest(runtime, {
          type: "switch_session",
          sessionPath: stored.piSessionFile,
        });
        const error = rpcFailure(switched);
        if (error) throw new Error(`Pi could not restore the session: ${error}`);
        const switchData = rpcData(switched);
        if (switchData.cancelled !== false) {
          throw new Error(
            switchData.cancelled === true
              ? "Pi cancelled session restoration"
              : "Pi did not confirm session restoration",
          );
        }
      }
      const state = await this.sendSuppressedRequest(runtime, { type: "get_state" });
      const stateError = rpcFailure(state);
      if (stateError) throw new Error(stateError);
      const data = rpcData(state);
      if (stored.piSessionFile) {
        if (typeof data.sessionFile !== "string" || resolve(data.sessionFile) !== resolve(stored.piSessionFile)) {
          throw new Error("Pi restored a different session file than requested");
        }
        if (stored.piSessionId && data.sessionId !== stored.piSessionId) {
          throw new Error("Pi restored a different session id than requested");
        }
      }
      const at = Math.max(0, Date.now() - runtime.baseTimestamp);
      this.events.append(normalizePiRpcRecord(runtime.adapter, state, at));
      await this.sendSuppressedRequest(runtime, { type: "get_messages" });
      await rpc.sendRequest({ type: "get_available_models" });
      await rpc.sendRequest({ type: "get_commands" });

      this.syncSession(stored.session.id, {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
      });
      return runtime;
    } catch (error) {
      runtime.stopping = true;
      rpc.stop();
      this.runtimes.delete(stored.session.id);
      if (!this.shuttingDown && !this.deleting.has(stored.session.id)) {
        const message = error instanceof Error ? error.message : String(error);
        this.events.append([
          domainEvent("run.status", { status: "failed", outcome: "failed", message }, stored.session.id),
        ]);
        this.syncSession(stored.session.id);
      }
      throw error;
    }
  }

  private onRecord(sessionId: string, runtime: ManagedSession, record: RpcRecord): void {
    if (this.deleting.has(sessionId)) return;
    if (record.type === "response" && typeof record.id === "string" && runtime.suppressedResponseIds.delete(record.id)) {
      return;
    }
    try {
      const at = Math.max(0, Date.now() - runtime.baseTimestamp);
      this.events.append(normalizePiRpcRecord(runtime.adapter, record, at));
      if (record.type === "tool_execution_start") this.armToolTimer(sessionId, runtime, record);
      if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
        this.clearToolTimer(runtime, record.toolCallId);
      }
      if (record.type === "agent_settled") {
        const session = this.events.currentSnapshot().sessions.find((candidate) => candidate.id === sessionId);
        if (session) this.refreshProjectBranch(session.projectId);
      }
      this.syncSession(sessionId);
      if (record.type === "agent_settled" && this.runningTools(sessionId).length > 0) {
        this.failRuntime(sessionId, runtime, "Pi settled without reporting a result for a running tool");
      }
    } catch (error) {
      const message = `Failed to persist RPC record: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`[pi:${sessionId}] ${message}\n`);
      this.failRuntime(sessionId, runtime, message);
    }
  }

  private onExit(sessionId: string, runtime: ManagedSession): void {
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
    if (runtime.stopping || runtime.failureReported) return;
    this.failRuntime(sessionId, runtime, "Pi subprocess exited unexpectedly");
  }

  private failRuntime(sessionId: string, runtime: ManagedSession, message: string): void {
    if (runtime.failureReported) return;
    runtime.failureReported = true;
    this.clearToolTimers(runtime);
    const pending = this.events.currentSnapshot().pendingInteractions.filter(
      (request) => request.sessionId === sessionId,
    );
    try {
      this.events.append([
        ...pending.map((request) => domainEvent(
          "interaction.resolved",
          { requestId: request.id, status: "cancelled" },
          sessionId,
        )),
        ...this.toolFailureEvents(sessionId, message),
        domainEvent("run.status", { status: "failed", outcome: "failed", message }, sessionId),
      ]);
      this.syncSession(sessionId);
    } catch (error) {
      process.stderr.write(
        `[pi:${sessionId}] Failed to persist runtime failure: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (runtime.rpc.running) runtime.rpc.stop("SIGKILL");
  }

  private runningTools(sessionId: string): ToolEntry[] {
    return (this.events.currentSnapshot().timelines[sessionId] ?? []).filter(
      (entry): entry is ToolEntry => entry.kind === "tool" && (entry.status === "running" || entry.status === "queued"),
    );
  }

  private toolFailureEvents(sessionId: string, message: string): UnsequencedAnvilEvent[] {
    return this.runningTools(sessionId).map((tool) => domainEvent("tool.completed", {
      toolCallId: tool.toolCallId,
      output: [{ id: `${tool.id}-failure`, type: "text", text: message }],
      details: { error: message },
      status: "failed",
    }, sessionId));
  }

  private armToolTimer(sessionId: string, runtime: ManagedSession, record: RpcRecord): void {
    if (typeof record.toolCallId !== "string") return;
    const args = record.args && typeof record.args === "object" && !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : {};
    const declaredTimeoutMs = record.toolName === "bash" && typeof args.timeout === "number"
      ? args.timeout * 1_000
      : typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
    const timeoutMs = declaredTimeoutMs ?? (record.toolName === "bash"
      ? this.options.defaultBashTimeoutMs ?? 10 * 60_000
      : this.options.defaultToolTimeoutMs ?? 30 * 60_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    this.clearToolTimer(runtime, record.toolCallId);
    const graceMs = declaredTimeoutMs === undefined
      ? 0
      : Math.min(5_000, Math.max(100, timeoutMs * 0.1));
    const timer = setTimeout(() => {
      runtime.toolTimers.delete(record.toolCallId as string);
      this.failRuntime(
        sessionId,
        runtime,
        `${String(record.toolName ?? "Tool")} exceeded its ${Math.round(timeoutMs / 1_000)}s timeout without reporting completion`,
      );
    }, Math.min(timeoutMs + graceMs, 2_147_483_647));
    timer.unref();
    runtime.toolTimers.set(record.toolCallId, timer);
  }

  private clearToolTimer(runtime: ManagedSession, toolCallId: string): void {
    const timer = runtime.toolTimers.get(toolCallId);
    if (timer) clearTimeout(timer);
    runtime.toolTimers.delete(toolCallId);
  }

  private clearToolTimers(runtime: ManagedSession): void {
    for (const timer of runtime.toolTimers.values()) clearTimeout(timer);
    runtime.toolTimers.clear();
  }

  private refreshProjectBranch(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    const branch = gitBranch(project.path);
    const affected = this.events.currentSnapshot().sessions.filter(
      (session) => session.projectId === projectId && session.branch !== branch,
    );
    if (affected.length === 0) return;
    this.events.append(affected.map((session) => domainEvent(
      "session.configured",
      { branch: branch ?? null },
      session.id,
    )));
    const snapshot = this.events.currentSnapshot();
    for (const previous of affected) {
      const session = snapshot.sessions.find((candidate) => candidate.id === previous.id);
      if (session) this.database.updateSession(session);
    }
  }

  private syncSession(sessionId: string, piState?: { sessionId?: string; sessionFile?: string }): void {
    const session = this.events.currentSnapshot().sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (piState?.sessionFile) {
      const ownedDirectory = `${resolve(this.config.sessionDir, sessionId)}${sep}`;
      const sessionFile = resolve(piState.sessionFile);
      if (!sessionFile.startsWith(ownedDirectory)) {
        throw new Error("Pi reported a session file outside its Anvil session directory");
      }
      piState = { ...piState, sessionFile };
    }
    this.database.updateSession(session, piState);
  }

  private cleanupOrphanSessionDirectories(sessionIds: Set<string>): void {
    mkdirSync(this.config.sessionDir, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(this.config.sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || sessionIds.has(entry.name)) continue;
      try {
        rmSync(join(this.config.sessionDir, entry.name), { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(
          `[forge] Failed to clean orphan session directory ${entry.name}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private async sendSuppressedRequest(runtime: ManagedSession, record: RpcRecord): Promise<RpcRecord> {
    const id = randomUUID();
    runtime.suppressedResponseIds.add(id);
    try {
      return await runtime.rpc.sendRequest({ ...record, id });
    } finally {
      runtime.suppressedResponseIds.delete(id);
    }
  }

  private enqueue<T>(runtime: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const result = runtime.commandTail.then(operation, operation);
    runtime.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async sendRpc(
    command: AnvilClientCommand,
    runtime: ManagedSession,
    record: RpcRecord,
  ): Promise<AnvilCommandResponse> {
    const response = await runtime.rpc.sendRequest(record);
    const error = rpcFailure(response);
    return commandResponse(command, !error, { error });
  }
}
