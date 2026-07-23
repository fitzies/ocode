import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
} from "@anvil/protocol";

import type { ForgeConfig } from "../config.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase, type RuntimeSessionRecord } from "../store/database.ts";
import { createPiRpcProcess, type RpcRecord, type RpcSubprocess } from "../rpc/subprocess.ts";

interface ManagedSession {
  rpc: RpcSubprocess;
  adapter: PiRpcAdapterState;
  baseTimestamp: number;
  stopping: boolean;
  failureReported: boolean;
  commandTail: Promise<unknown>;
  suppressedResponseIds: Set<string>;
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

export class SessionManager {
  private readonly projects = new Map<string, ProjectSummary>();
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly starting = new Map<string, Promise<ManagedSession>>();
  private readonly inFlightCommands = new Map<string, Promise<AnvilCommandResponse>>();
  private readonly interactionTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: ForgeConfig,
    private readonly database: ForgeDatabase,
    private readonly events: ForgeEventService,
  ) {
    for (const project of config.projects) this.projects.set(project.id, project);
    database.syncProjects(config.projects);
    const restored = events.currentSnapshot();
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
        ...[...interruptedSessionIds].map((sessionId) => domainEvent(
          "run.status",
          { status: "failed", message: "Interrupted by Forge restart" },
          sessionId,
        )),
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

  async stopAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      runtime.stopping = true;
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
    if (command.type === "session.select") return commandResponse(command, true);
    if (command.type === "session.create") return this.createSession(command);
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
      const response = await this.sendRpc(command, runtime, { type: "abort" });
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
          domainEvent("run.status", { status: "idle" }, command.sessionId),
        ]);
        this.syncSession(command.sessionId);
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
        });
        const type = command.payload.delivery === "followUp"
          ? "follow_up"
          : command.payload.delivery === "steer" ? "steer" : "prompt";
        return this.sendRpc(command, runtime, {
          type,
          message: command.payload.content,
          ...(images?.length ? { images } : {}),
        });
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

  private async createSession(
    command: Extract<AnvilClientCommand, { type: "session.create" }>,
  ): Promise<AnvilCommandResponse> {
    const project = this.projects.get(command.payload.projectId);
    if (!project) return commandResponse(command, false, { error: "Project is not configured on Forge" });
    const timestamp = new Date().toISOString();
    const session: SessionSummary = {
      id: randomUUID(),
      projectId: project.id,
      title: "New session",
      updatedAt: timestamp,
      status: "idle",
      modelId: "unknown",
      thinkingLevel: "off",
    };
    this.events.createSession(
      session,
      domainEvent("session.upserted", { session }, session.id),
    );

    try {
      await this.ensureRuntime({ session });
      return commandResponse(command, true, { data: { sessionId: session.id } });
    } catch (error) {
      this.syncSession(session.id);
      return commandResponse(command, false, {
        data: { sessionId: session.id },
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      const message = error instanceof Error ? error.message : String(error);
      this.events.append([
        domainEvent("run.status", { status: "failed", message }, stored.session.id),
      ]);
      this.syncSession(stored.session.id);
      throw error;
    }
  }

  private onRecord(sessionId: string, runtime: ManagedSession, record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string" && runtime.suppressedResponseIds.delete(record.id)) {
      return;
    }
    try {
      const at = Math.max(0, Date.now() - runtime.baseTimestamp);
      this.events.append(normalizePiRpcRecord(runtime.adapter, record, at));
      this.syncSession(sessionId);
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
        domainEvent("run.status", { status: "failed", message }, sessionId),
      ]);
      this.syncSession(sessionId);
    } catch (error) {
      process.stderr.write(
        `[pi:${sessionId}] Failed to persist runtime failure: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (runtime.rpc.running) runtime.rpc.stop("SIGKILL");
  }

  private syncSession(sessionId: string, piState?: { sessionId?: string; sessionFile?: string }): void {
    const session = this.events.currentSnapshot().sessions.find((candidate) => candidate.id === sessionId);
    if (session) this.database.updateSession(session, piState);
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
