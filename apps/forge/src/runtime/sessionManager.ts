import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  createPiRpcAdapterState,
  normalizePiRpcRecord,
  type PiRpcAdapterState,
  type UnsequencedAnvilEvent,
} from "@anvil/pi-rpc";
import {
  ANVIL_PROTOCOL_VERSION,
  DEFAULT_SESSION_TITLE,
  isGeneralProject,
  normalizeProjectSlug,
  normalizeSessionTitle,
  parseOcodeAskUserQuestionEditorEnvelope,
  parseOcodeAskUserQuestionResponse,
  provisionalSessionTitleFromPrompt,
  SESSION_TITLE_MAX_LENGTH,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type JsonValue,
  type ProjectSummary,
  type SessionSummary,
  type SubagentRun,
  type ToolEntry,
} from "@anvil/protocol";

import type { ForgeConfig } from "../config.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { normalizeGitHubRepository } from "../projects/githubRepository.ts";
import { GhProjectCloner, ProjectCloneError, type ProjectCloner } from "../projects/projectCloneService.ts";
import { EventProjectResolver, type ProjectResolver } from "../projects/projectResolver.ts";
import { canonicalizeProjectsRoot, ProjectsRootValidationError } from "../projects/projectsRoot.ts";
import { detectProjectWorkspaceKind } from "../projects/workspaceKind.ts";
import { ForgeDatabase, type RuntimeSessionRecord } from "../store/database.ts";
import { subagentCompletionOrigin } from "../subagents/completionMessage.ts";
import type { PreparedProjectTerminalRemoval, ProjectTerminalCleanup } from "../terminal/terminalManager.ts";
import { createPiRpcProcess, type RpcRecord, type RpcSubprocess } from "../rpc/subprocess.ts";
import { WorkspaceFileIndex } from "./workspaceFiles.ts";

interface SessionManagerOptions {
  defaultToolTimeoutMs?: number;
  defaultBashTimeoutMs?: number;
  idleRuntimeTimeoutMs?: number;
  projectResolver?: ProjectResolver;
  terminalCleanup?: ProjectTerminalCleanup;
  projectCloner?: ProjectCloner;
  runtimeEnvironment?: (session: RuntimeSessionRecord) => NodeJS.ProcessEnv | undefined;
  cancelSubagent?: (parentSessionId: string, runId: string) => Promise<SubagentRun>;
  deleteOwnedSubagents?: (parentSessionId: string) => Promise<void>;
  finishParentSubagentDeletion?: (parentSessionId: string) => void;
  prepareChildSubagentDeletion?: (childSessionId: string) => Promise<void>;
}

type StreamDeltaEvent = Extract<UnsequencedAnvilEvent, { type: "message.delta" | "reasoning.delta" }>;

interface ManagedSession {
  rpc: RpcSubprocess;
  adapter: PiRpcAdapterState;
  baseTimestamp: number;
  stopping: boolean;
  failureReported: boolean;
  commandTail: Promise<unknown>;
  suppressedResponseIds: Set<string>;
  toolTimers: Map<string, NodeJS.Timeout>;
  pendingStreamEvent?: StreamDeltaEvent;
  streamFlushTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
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
const STREAM_BATCH_MS = 32;
const MAX_STREAM_BATCH_BYTES = 8 * 1024;
const DEFAULT_IDLE_RUNTIME_TIMEOUT_MS = 15 * 60_000;
const OCODE_HANDOFF_EDITOR_SENTINEL = "__ocode_handoff_v1__";
const OCODE_HANDOFF_MAX_BYTES = 256 * 1024;
const SESSION_SUMMARY_EVENT_TYPES = new Set<AnvilEvent["type"]>([
  "session.configured",
  "run.status",
  "message.started",
  "interaction.requested",
  "interaction.resolved",
]);

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

function ocodeHandoffRequest(record: RpcRecord): { requestId: string; handoffPath?: string; error?: string } | undefined {
  if (
    record.type !== "extension_ui_request" ||
    record.method !== "editor" ||
    record.title !== OCODE_HANDOFF_EDITOR_SENTINEL ||
    typeof record.id !== "string" ||
    !record.id
  ) return undefined;

  let envelope: unknown;
  try {
    envelope = typeof record.prefill === "string" ? JSON.parse(record.prefill) : undefined;
  } catch {
    return { requestId: record.id, error: "The handoff request was malformed" };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { requestId: record.id, error: "The handoff request was malformed" };
  }
  const value = envelope as Record<string, unknown>;
  if (
    value.kind !== "ocode.handoff" ||
    value.schemaVersion !== 1 ||
    typeof value.handoffPath !== "string"
  ) {
    return { requestId: record.id, error: "The handoff request version is unsupported" };
  }

  try {
    const requestedPath = resolve(value.handoffPath);
    const handoffRoot = realpathSync(join(tmpdir(), "pi-handoffs"));
    const handoffPath = realpathSync(requestedPath);
    const metadata = lstatSync(requestedPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > OCODE_HANDOFF_MAX_BYTES ||
      dirname(handoffPath) !== handoffRoot ||
      !/^handoff-[A-Za-z0-9.-]+\.md$/.test(basename(handoffPath))
    ) {
      return { requestId: record.id, error: "The handoff file is outside the trusted handoff directory" };
    }
    return { requestId: record.id, handoffPath };
  } catch {
    return { requestId: record.id, error: "The handoff file is unavailable" };
  }
}

export class SessionManager {
  private readonly projectResolver: ProjectResolver;
  private readonly projectCloner: ProjectCloner;
  private readonly runtimes = new Map<string, ManagedSession>();
  private readonly starting = new Map<string, Promise<ManagedSession>>();
  private readonly inFlightCommands = new Map<string, Promise<AnvilCommandResponse>>();
  private readonly inFlightCommandProjects = new Map<string, string>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly projectLifecycleTails = new Map<string, Promise<void>>();
  private readonly activeCommandCounts = new Map<string, number>();
  private readonly provisionalTitleOwners = new Map<string, symbol>();
  private readonly interactionTimers = new Map<string, NodeJS.Timeout>();
  private readonly internalDeliveryCounts = new Map<string, number>();
  private readonly internalLifecycleCommandIds = new Set<string>();
  private readonly pendingSessionCreationEvents = new Map<string, UnsequencedAnvilEvent[]>();
  private readonly deleting = new Set<string>();
  private readonly deletingProjects = new Set<string>();
  private readonly cloneReservations = new Set<string>();
  private readonly workspaceFiles = new WorkspaceFileIndex();
  private projectsRoot: string;
  private shuttingDown = false;

  constructor(
    private readonly config: ForgeConfig,
    private readonly database: ForgeDatabase,
    private readonly events: ForgeEventService,
    private readonly options: SessionManagerOptions = {},
  ) {
    this.projectResolver = options.projectResolver ?? new EventProjectResolver(events);
    this.projectCloner = options.projectCloner ?? new GhProjectCloner();
    const persistedProjectsRoot = database.runtimeMetadata("projects_root");
    this.projectsRoot = canonicalizeProjectsRoot(persistedProjectsRoot ?? config.projectsRoot);
    this.projectCloner.cleanupStale?.(this.projectsRoot);
    if (persistedProjectsRoot === undefined) {
      database.setRuntimeMetadata("projects_root", this.projectsRoot);
    }
    const restored = events.currentSnapshot();
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

    const projectId = this.projectIdForCommand(command);
    const execution = Promise.resolve()
      .then(() => this.dispatch(command))
      .catch((error) => commandResponse(command, false, {
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((response) => {
        this.database.completeCommand(response);
        return response;
      })
      .finally(() => {
        this.inFlightCommands.delete(command.id);
        this.inFlightCommandProjects.delete(command.id);
      });
    this.inFlightCommands.set(command.id, execution);
    if (projectId) this.inFlightCommandProjects.set(command.id, projectId);
    return execution;
  };

  createSubagentSession(input: {
    sessionId: string;
    parentSessionId: string;
    title: string;
  }): void {
    const existing = this.database.getSession(input.sessionId);
    if (existing) {
      if (existing.session.internal && existing.session.parentSessionId === input.parentSessionId) return;
      throw new Error("Subagent child session id collided with an existing session");
    }
    const parent = this.database.getSession(input.parentSessionId);
    if (!parent || parent.session.internal) throw new Error("A valid parent session is required");
    const timestamp = new Date().toISOString();
    const session: SessionSummary = {
      id: input.sessionId,
      projectId: parent.session.projectId,
      title: input.title.slice(0, SESSION_TITLE_MAX_LENGTH),
      updatedAt: timestamp,
      status: "idle",
      modelId: parent.session.modelId,
      thinkingLevel: parent.session.thinkingLevel,
      settled: false,
      branch: parent.session.branch,
      readThroughSequence: 0,
      internal: true,
      parentSessionId: input.parentSessionId,
    };
    this.events.createSession(session, domainEvent("session.upserted", { session }, session.id));
    void this.ensureRuntime({ session }).catch(() => {
      // startRuntime publishes a durable failure for the child session.
    });
  }

  sendSubagentPrompt(runId: string, childSessionId: string, prompt: string): Promise<AnvilCommandResponse> {
    return this.handleCommand({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: `subagent-prompt:${runId}`,
      sessionId: childSessionId,
      timestamp: new Date().toISOString(),
      type: "prompt.send",
      payload: { content: prompt, delivery: "prompt" },
    });
  }

  async cancelSubagentSession(runId: string, childSessionId: string): Promise<AnvilCommandResponse> {
    const commandId = `subagent-cancel:${runId}`;
    this.internalLifecycleCommandIds.add(commandId);
    try {
      return await this.handleCommand({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: commandId,
        sessionId: childSessionId,
        timestamp: new Date().toISOString(),
        type: "run.cancel",
        payload: {},
      });
    } finally {
      this.internalLifecycleCommandIds.delete(commandId);
    }
  }

  async deliverSubagentCompletion(deliveryId: string, parentSessionId: string, content: string): Promise<AnvilCommandResponse> {
    // Stable command ids provide at-most-once acceptance across retries. Keep a
    // reference count so concurrent duplicate calls cannot drop the internal
    // marker while the one serialized delivery is still being dispatched.
    this.internalDeliveryCounts.set(deliveryId, (this.internalDeliveryCounts.get(deliveryId) ?? 0) + 1);
    try {
      return await this.handleCommand({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: deliveryId,
        sessionId: parentSessionId,
        timestamp: new Date().toISOString(),
        type: "prompt.send",
        payload: { content, delivery: "followUp" },
      });
    } finally {
      const remaining = (this.internalDeliveryCounts.get(deliveryId) ?? 1) - 1;
      if (remaining > 0) this.internalDeliveryCounts.set(deliveryId, remaining);
      else this.internalDeliveryCounts.delete(deliveryId);
    }
  }

  async deleteSubagentSession(childSessionId: string): Promise<void> {
    if (!this.database.getSession(childSessionId)) return;
    const alreadyDeleting = this.deleting.has(childSessionId);
    this.deleting.add(childSessionId);
    try {
      await this.withSessionLifecycle(childSessionId, () => this.stopAndDeleteSession(childSessionId));
    } finally {
      if (!alreadyDeleting) this.deleting.delete(childSessionId);
    }
  }

  searchFiles = async (sessionId: string, query: string, limit: number): Promise<string[] | undefined> => {
    const stored = this.database.getSession(sessionId);
    if (!stored) return undefined;
    const project = this.projectResolver.resolveProject(stored.session.projectId);
    if (!project) return undefined;
    return this.workspaceFiles.search(project.path, query, limit);
  };

  getProjectsRoot = (): string => this.projectsRoot;

  setProjectsRoot = (requestedPath: string): string => {
    if (this.cloneReservations.size > 0) {
      throw new ProjectsRootValidationError("Projects root cannot be changed while a repository is being cloned");
    }
    const path = canonicalizeProjectsRoot(requestedPath);
    this.projectCloner.cleanupStale?.(path);
    this.database.setRuntimeMetadata("projects_root", path);
    this.projectsRoot = path;
    return path;
  };

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    await this.projectCloner.shutdown?.();
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      runtime.stopping = true;
      this.clearIdleTimer(runtime);
      this.flushPendingStreamEvent(runtime);
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
    if (command.type === "project.delete") {
      return this.withProjectLifecycle(command.payload.projectId, () => this.deleteProject(command));
    }
    const sessionId = command.type === "session.delete" ? command.payload.sessionId : command.sessionId;
    const projectId = command.type === "session.create"
      ? command.payload.projectId
      : sessionId ? this.database.getSession(sessionId)?.session.projectId : undefined;
    if (projectId && this.deletingProjects.has(projectId) && !this.internalLifecycleCommandIds.has(command.id)) {
      return commandResponse(command, false, { error: "Project removal is in progress" });
    }
    return this.dispatchForProject(command);
  }

  private async dispatchForProject(command: AnvilClientCommand): Promise<AnvilCommandResponse> {
    if (command.type === "subagent.cancel") {
      if (!command.sessionId || !this.options.cancelSubagent) {
        return commandResponse(command, false, { error: "Subagent cancellation is unavailable" });
      }
      try {
        const run = await this.options.cancelSubagent(command.sessionId, command.payload.runId);
        return commandResponse(command, true, { data: { ...run } });
      } catch (error) {
        return commandResponse(command, false, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (command.type === "project.create") return this.createProject(command);
    if (command.type === "project.clone") return this.cloneProject(command);
    if (command.type === "project.addExisting") return this.addExistingProject(command);
    if (command.type === "session.select") return commandResponse(command, true);
    if (command.type === "session.create") return this.createSession(command);
    if (command.type === "session.delete") {
      return this.withSessionLifecycle(command.payload.sessionId, () => this.deleteSession(command));
    }
    if (command.type === "session.settled") {
      if (!command.sessionId) return commandResponse(command, false, { error: "Session not found" });
      return this.withSessionLifecycle(command.sessionId, () => this.setSessionSettled(command));
    }
    if (command.type === "session.markRead" || command.type === "session.markUnread") {
      if (!command.sessionId) return commandResponse(command, false, { error: "Session not found" });
      return this.afterSessionLifecycle(command.sessionId, async () => this.setSessionReadState(command));
    }
    if (!command.sessionId) return commandResponse(command, false, { error: "A session is required" });
    if (this.internalLifecycleCommandIds.has(command.id)) {
      return this.dispatchTrackedRuntimeCommand(command);
    }
    return this.afterSessionLifecycle(command.sessionId, () => this.dispatchTrackedRuntimeCommand(command));
  }

  private async dispatchTrackedRuntimeCommand(command: AnvilClientCommand): Promise<AnvilCommandResponse> {
    const sessionId = command.sessionId;
    if (!sessionId) return commandResponse(command, false, { error: "A session is required" });
    this.activeCommandCounts.set(sessionId, (this.activeCommandCounts.get(sessionId) ?? 0) + 1);
    try {
      return await this.dispatchRuntimeCommand(command);
    } finally {
      const remaining = (this.activeCommandCounts.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.activeCommandCounts.set(sessionId, remaining);
      } else {
        this.activeCommandCounts.delete(sessionId);
        const runtime = this.runtimes.get(sessionId);
        if (runtime && this.events.sessionSummary(sessionId)?.status === "idle") {
          this.scheduleIdleStop(sessionId, runtime);
        }
      }
    }
  }

  private async dispatchRuntimeCommand(command: AnvilClientCommand): Promise<AnvilCommandResponse> {
    const sessionId = command.sessionId;
    if (!sessionId) return commandResponse(command, false, { error: "A session is required" });
    const stored = this.database.getSession(sessionId);
    if (!stored) return commandResponse(command, false, { error: "Session not found" });
    if (command.type === "session.rename" && !normalizeSessionTitle(command.payload.title)) {
      return commandResponse(command, false, {
        error: `Thread title must be non-empty and at most ${SESSION_TITLE_MAX_LENGTH} characters`,
      });
    }
    if (stored.session.settled && command.type !== "prompt.send" && command.type !== "session.rename") {
      return commandResponse(command, false, { error: "Send a prompt to resume this settled thread" });
    }
    if (command.type === "model.set" || command.type === "thinking.set") {
      await this.starting.get(sessionId);
    }
    const catalog = this.events.catalogForSession(sessionId);
    if (command.type === "model.set" && !catalog?.models.some(
      (model) => model.id === command.payload.modelId,
    )) {
      return commandResponse(command, false, { error: "Model is not available in this session" });
    }
    if (command.type === "thinking.set") {
      const session = this.events.sessionSummary(sessionId);
      const model = catalog?.models.find((candidate) => candidate.id === session?.modelId);
      if (!model?.supportedThinkingLevels.includes(command.payload.level)) {
        return commandResponse(command, false, {
          error: "Thinking level is not supported by this session's model",
        });
      }
    }
    const runtime = await this.ensureRuntime(stored);
    const internalDelivery = this.internalDeliveryCounts.has(command.id);
    if (command.type === "prompt.send" && stored.session.settled && !internalDelivery) {
      this.events.setSessionSettled(
        sessionId,
        false,
        domainEvent("session.settled", { settled: false }, sessionId),
      );
    }

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
        const pending = this.events.pendingInteractionsForSession(sessionId);
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
            sessionId,
          )),
          domainEvent("run.status", { status: "idle", outcome: "cancelled" }, sessionId),
        ]);
        this.syncSession(sessionId);
      } else {
        runtime.adapter.terminalOutcomeInCurrentRun = previousOutcome;
      }
      return response;
    }
    if (command.type === "interaction.respond") {
      const pending = this.events.pendingInteractionsForSession(sessionId).find(
        (request) => request.id === command.payload.requestId,
      );
      if (!pending) return commandResponse(command, false, { error: "Interaction is no longer pending" });
      if (pending.presentation?.type === "ask_user_question") {
        const raw = pending.raw;
        const prefill = raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).prefill
          : undefined;
        const envelope = parseOcodeAskUserQuestionEditorEnvelope(prefill);
        const cancellation = command.payload.cancelled === true &&
          command.payload.value === undefined &&
          command.payload.confirmed === undefined;
        const answer = command.payload.cancelled === undefined &&
          command.payload.confirmed === undefined &&
          command.payload.value !== undefined &&
          envelope !== undefined &&
          parseOcodeAskUserQuestionResponse(command.payload.value, envelope) !== undefined;
        if (!envelope || (!cancellation && !answer)) {
          return commandResponse(command, false, { error: "Invalid ask_user_question response" });
        }
      }
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
        // Completion delivery chooses the Pi primitive here, inside the parent
        // runtime's command tail. An idle follow_up only queues, so idle (and
        // settled) parents need prompt to trigger a turn; a running parent must
        // use follow_up so completion runs after its current work.
        const parentStatus = this.events.sessionSummary(sessionId)?.status;
        const type = internalDelivery
          ? parentStatus === "running" || parentStatus === "waiting" ? "follow_up" : "prompt"
          : command.payload.delivery === "followUp"
            ? "follow_up"
            : command.payload.delivery === "steer" ? "steer" : "prompt";
        if (internalDelivery && stored.session.settled) {
          this.events.setSessionSettled(
            sessionId,
            false,
            domainEvent("session.settled", { settled: false }, sessionId),
          );
        }
        const isFirstPrompt = !internalDelivery && type === "prompt" && !stored.session.lastUserMessageAt;
        const provisionalTitle = isFirstPrompt && this.events.sessionSummary(sessionId)?.title === DEFAULT_SESSION_TITLE
          ? provisionalSessionTitleFromPrompt(command.payload.content)
          : undefined;
        const provisionalTitleOwner = provisionalTitle ? Symbol(sessionId) : undefined;
        if (provisionalTitle && provisionalTitleOwner) {
          this.provisionalTitleOwners.set(sessionId, provisionalTitleOwner);
          this.events.renameSession(
            sessionId,
            provisionalTitle,
            domainEvent("session.configured", {
              title: provisionalTitle,
              titleSource: "provisional",
            }, sessionId),
          );
        }
        const restoreDefaultTitle = () => {
          if (
            provisionalTitle &&
            provisionalTitleOwner &&
            this.provisionalTitleOwners.get(sessionId) === provisionalTitleOwner
          ) {
            this.provisionalTitleOwners.delete(sessionId);
            this.events.renameSession(
              sessionId,
              DEFAULT_SESSION_TITLE,
              domainEvent("session.configured", { title: DEFAULT_SESSION_TITLE }, sessionId),
            );
          }
        };
        let response: AnvilCommandResponse;
        try {
          response = await this.sendRpc(command, runtime, {
            type,
            message,
            ...(images.length ? { images } : {}),
          });
        } catch (error) {
          restoreDefaultTitle();
          throw error;
        }
        if (response.success) {
          if (provisionalTitleOwner && this.provisionalTitleOwners.get(sessionId) === provisionalTitleOwner) {
            this.provisionalTitleOwners.delete(sessionId);
          }
          if (!internalDelivery) this.events.append([domainEvent("session.prompted", {}, sessionId)]);
          this.syncSession(sessionId);
        } else {
          restoreDefaultTitle();
        }
        if (response.success && command.payload.attachments?.length) {
          this.events.consumeAttachments(
            stored.session.id,
            command.payload.attachments.map((attachment) => attachment.artifactId),
          );
        }
        return response;
      }
      if (command.type === "session.rename") {
        const title = normalizeSessionTitle(command.payload.title)!;
        if (this.events.sessionSummary(sessionId)?.title === title) {
          return commandResponse(command, true);
        }
        const response = await this.sendRpc(command, runtime, {
          type: "set_session_name",
          name: title,
        });
        if (response.success && this.events.sessionSummary(sessionId)?.title !== title) {
          this.events.renameSession(
            sessionId,
            title,
            domainEvent("session.configured", { title }, sessionId),
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
      const stillPending = this.events.hasPendingInteraction(request.sessionId, request.id);
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
    if (!name || name.length > 80) {
      return commandResponse(command, false, { error: "Project name must be between 1 and 80 characters" });
    }

    const projects = this.events.projectSummaries();
    if (projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
      return commandResponse(command, false, { error: "A project with that name already exists" });
    }

    const slug = normalizeProjectSlug(name);
    if (!slug) {
      return commandResponse(command, false, { error: "Project name must contain letters or numbers that can form a directory name" });
    }

    let currentRoot: string;
    try {
      currentRoot = canonicalizeProjectsRoot(this.projectsRoot);
    } catch (error) {
      return commandResponse(command, false, {
        error: error instanceof Error ? error.message : "Projects root is unavailable",
      });
    }
    if (currentRoot !== this.projectsRoot) {
      return commandResponse(command, false, {
        error: "Projects root changed on disk; review and save it again in Forge settings",
      });
    }

    let path = join(currentRoot, slug);
    if (projects.some((project) => project.path === path)) {
      return commandResponse(command, false, { error: "That project path is already configured" });
    }
    if (this.cloneReservations.has(`name:${name.toLowerCase()}`) || this.cloneReservations.has(`path:${path}`)) {
      return commandResponse(command, false, { error: "That project is currently being cloned" });
    }
    let createdDirectory = false;
    try {
      mkdirSync(path);
      createdDirectory = true;
      path = realpathSync(path);
      if (dirname(path) !== currentRoot) {
        rmdirSync(path);
        createdDirectory = false;
        return commandResponse(command, false, { error: "Project directory escaped the configured projects root" });
      }
    } catch (error) {
      if (createdDirectory) {
        try {
          rmdirSync(path);
        } catch {
          // Leave anything that is no longer our empty directory untouched.
        }
      }
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      return commandResponse(command, false, {
        error: code === "EEXIST"
          ? `A filesystem entry already exists at ${path}. Choose “Use a Forge directory” to register an existing workspace.`
          : `Forge could not create the project directory at ${path}`,
      });
    }

    try {
      if (realpathSync(path) !== path || dirname(path) !== currentRoot || !statSync(path).isDirectory()) {
        throw new Error("Project directory changed before it could be registered");
      }
    } catch (error) {
      if (createdDirectory) {
        try { rmdirSync(path); } catch { /* Keep a changed or non-empty directory untouched. */ }
      }
      return commandResponse(command, false, {
        error: error instanceof Error ? error.message : "Project directory changed before it could be registered",
      });
    }

    const project: ProjectSummary = {
      id: `${slug.slice(0, 40)}-${randomUUID().slice(0, 8)}`,
      name,
      path,
      workspaceKind: detectProjectWorkspaceKind(path),
    };
    try {
      this.events.createProject(
        project,
        domainEvent("project.upserted", { project }, null),
      );
    } catch (error) {
      if (createdDirectory) {
        try {
          rmdirSync(path);
        } catch {
          // Never remove a directory that is no longer empty or no longer ours.
        }
      }
      throw error;
    }
    return commandResponse(command, true, { data: { status: "created", projectId: project.id } });
  }

  private async cloneProject(
    command: Extract<AnvilClientCommand, { type: "project.clone" }>,
  ): Promise<AnvilCommandResponse> {
    const name = command.payload.name.trim();
    if (!name || name.length > 80) {
      return commandResponse(command, false, { error: "Project name must be between 1 and 80 characters" });
    }
    const slug = normalizeProjectSlug(name);
    if (!slug) {
      return commandResponse(command, false, { error: "Project name must contain letters or numbers that can form a directory name" });
    }

    let repository: string;
    try {
      repository = normalizeGitHubRepository(command.payload.repository);
    } catch (error) {
      return commandResponse(command, false, {
        error: error instanceof Error ? error.message : "GitHub repository is malformed",
      });
    }

    let currentRoot: string;
    try {
      currentRoot = canonicalizeProjectsRoot(this.projectsRoot);
    } catch (error) {
      return commandResponse(command, false, {
        error: error instanceof Error ? error.message : "Projects root is unavailable",
      });
    }
    if (currentRoot !== this.projectsRoot) {
      return commandResponse(command, false, {
        error: "Projects root changed on disk; review and save it again in Forge settings",
      });
    }

    const path = join(currentRoot, slug);
    const nameReservation = `name:${name.toLowerCase()}`;
    const pathReservation = `path:${path}`;
    const projects = this.events.projectSummaries();
    if (projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
      return commandResponse(command, false, { error: "A project with that name already exists" });
    }
    if (projects.some((project) => project.path === path)) {
      return commandResponse(command, false, { error: "That project path is already configured" });
    }
    if (this.cloneReservations.has(nameReservation) || this.cloneReservations.has(pathReservation)) {
      return commandResponse(command, false, { error: "That project is already being cloned" });
    }

    this.cloneReservations.add(nameReservation);
    this.cloneReservations.add(pathReservation);
    try {
      // Recheck after taking the reservation so two clone commands cannot both
      // pass validation before either publishes project.upserted.
      const currentProjects = this.events.projectSummaries();
      if (currentProjects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
        return commandResponse(command, false, { error: "A project with that name already exists" });
      }
      if (currentProjects.some((project) => project.path === path)) {
        return commandResponse(command, false, { error: "That project path is already configured" });
      }

      let clonedPath: string;
      try {
        clonedPath = await this.projectCloner.clone(currentRoot, slug, repository);
      } catch (error) {
        return commandResponse(command, false, {
          error: error instanceof ProjectCloneError
            ? error.message
            : "Forge could not clone the GitHub repository. Check the repository and try again.",
        });
      }
      if (clonedPath !== path) {
        return commandResponse(command, false, {
          error: `The repository was cloned to ${clonedPath}, but Forge refused to register an unexpected destination. Use “Use a Forge directory” to register it.`,
        });
      }
      try {
        if (realpathSync(path) !== path || dirname(path) !== currentRoot || !statSync(path).isDirectory()) {
          throw new Error("cloned workspace is not a direct project directory");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "cloned workspace validation failed";
        return commandResponse(command, false, {
          error: `Repository cloned to ${path}, but Forge could not safely register it: ${detail}. The workspace was preserved.`,
        });
      }

      const project: ProjectSummary = {
        id: `${slug.slice(0, 40)}-${randomUUID().slice(0, 8)}`,
        name,
        path,
        workspaceKind: detectProjectWorkspaceKind(path),
      };
      try {
        this.events.createProject(
          project,
          domainEvent("project.upserted", { project }, null),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "project persistence failed";
        return commandResponse(command, false, {
          error: `Repository cloned successfully to ${path}, but Forge could not register it: ${detail}. The workspace was preserved; use “Use a Forge directory” to register it later.`,
        });
      }
      return commandResponse(command, true, { data: { status: "cloned", projectId: project.id } });
    } finally {
      this.cloneReservations.delete(nameReservation);
      this.cloneReservations.delete(pathReservation);
    }
  }

  private addExistingProject(
    command: Extract<AnvilClientCommand, { type: "project.addExisting" }>,
  ): AnvilCommandResponse {
    const name = command.payload.name.trim();
    if (!name || name.length > 80) {
      return commandResponse(command, false, { error: "Project name must be between 1 and 80 characters" });
    }

    const projects = this.events.projectSummaries();
    if (projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
      return commandResponse(command, false, { error: "A project with that name already exists" });
    }
    const slug = normalizeProjectSlug(name);
    if (!slug) {
      return commandResponse(command, false, { error: "Project name must contain letters or numbers that can form a directory name" });
    }

    let currentRoot: string;
    try {
      currentRoot = canonicalizeProjectsRoot(this.projectsRoot);
    } catch (error) {
      return commandResponse(command, false, {
        error: error instanceof Error ? error.message : "Projects root is unavailable",
      });
    }
    if (currentRoot !== this.projectsRoot) {
      return commandResponse(command, false, {
        error: "Projects root changed on disk; review and save it again in Forge settings",
      });
    }

    const requestedPath = join(currentRoot, slug);
    if (command.payload.path.trim() !== requestedPath) {
      return commandResponse(command, false, { error: "The existing project candidate changed; check it again" });
    }
    if (projects.some((project) => project.path === requestedPath)) {
      return commandResponse(command, false, { error: "That project path is already configured" });
    }
    if (this.cloneReservations.has(`name:${name.toLowerCase()}`) || this.cloneReservations.has(`path:${requestedPath}`)) {
      return commandResponse(command, false, { error: "That project is currently being cloned" });
    }

    let path: string;
    try {
      path = realpathSync(requestedPath);
      if (path !== requestedPath || dirname(path) !== currentRoot || !statSync(path).isDirectory()) {
        return commandResponse(command, false, { error: "Existing project must be a real directory directly inside the projects root" });
      }
    } catch {
      return commandResponse(command, false, { error: `No accessible project directory exists at ${requestedPath}` });
    }

    try {
      if (realpathSync(requestedPath) !== path || !statSync(requestedPath).isDirectory()) {
        return commandResponse(command, false, { error: "Existing project directory changed before it could be registered" });
      }
    } catch {
      return commandResponse(command, false, { error: "Existing project directory changed before it could be registered" });
    }

    const project: ProjectSummary = {
      id: `${slug.slice(0, 40)}-${randomUUID().slice(0, 8)}`,
      name,
      path,
      workspaceKind: detectProjectWorkspaceKind(path),
    };
    this.events.createProject(
      project,
      domainEvent("project.upserted", { project }, null),
    );
    return commandResponse(command, true, { data: { status: "added", projectId: project.id } });
  }

  private createSession(
    command: Extract<AnvilClientCommand, { type: "session.create" }>,
  ): AnvilCommandResponse {
    if (this.deletingProjects.has(command.payload.projectId)) {
      return commandResponse(command, false, { error: "Project removal is in progress" });
    }
    const project = this.projectResolver.resolveProject(command.payload.projectId);
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
      title: DEFAULT_SESSION_TITLE,
      updatedAt: timestamp,
      status: "idle",
      modelId: "unknown",
      thinkingLevel: "off",
      settled: false,
      branch: gitBranch(project.path),
      readThroughSequence: 0,
    };
    const initialEvents = this.pendingSessionCreationEvents.get(session.id) ?? [];
    this.pendingSessionCreationEvents.delete(session.id);
    this.events.createSessionWithEvents(session, [
      domainEvent("session.upserted", { session }, session.id),
      ...initialEvents,
    ]);

    void this.ensureRuntime({ session }).catch((error) => {
      if (this.shuttingDown || this.deleting.has(session.id)) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = this.events.sessionSummary(session.id);
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

  private setSessionReadState(
    command: Extract<AnvilClientCommand, { type: "session.markRead" | "session.markUnread" }>,
  ): AnvilCommandResponse {
    const sessionId = command.sessionId;
    if (!sessionId || !this.database.getSession(sessionId)) {
      return commandResponse(command, false, { error: "Session not found" });
    }
    if (command.type === "session.markRead") {
      this.events.markSessionRead(sessionId, command.payload.throughSequence);
    } else {
      this.events.markSessionUnread(sessionId);
    }
    return commandResponse(command, true);
  }

  private async setSessionSettled(
    command: Extract<AnvilClientCommand, { type: "session.settled" }>,
  ): Promise<AnvilCommandResponse> {
    const sessionId = command.sessionId;
    if (!sessionId || !this.database.getSession(sessionId)) {
      return commandResponse(command, false, { error: "Session not found" });
    }

    if (command.payload.settled) {
      const starting = this.starting.get(sessionId);
      if (starting) {
        try {
          await starting;
        } catch (error) {
          return commandResponse(command, false, {
            error: `Pi could not finish starting: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const session = this.events.sessionSummary(sessionId);
      const hasPendingInteraction = this.events.pendingInteractionsForSession(sessionId).length > 0;
      const commandInFlight = (this.activeCommandCounts.get(sessionId) ?? 0) > 0;
      if (
        session?.status === "running" ||
        session?.status === "waiting" ||
        hasPendingInteraction ||
        commandInFlight ||
        this.runningTools(sessionId).length > 0
      ) {
        return commandResponse(command, false, {
          error: "Wait for Pi to finish and resolve any pending requests before settling this thread",
        });
      }
    }

    this.events.setSessionSettled(
      sessionId,
      command.payload.settled,
      domainEvent("session.settled", { settled: command.payload.settled }, sessionId),
    );
    if (command.payload.settled) await this.stopSessionRuntime(sessionId);
    return commandResponse(command, true);
  }

  private async deleteProject(
    command: Extract<AnvilClientCommand, { type: "project.delete" }>,
  ): Promise<AnvilCommandResponse> {
    const projectId = command.payload.projectId;
    const project = this.events.projectSummary(projectId);
    if (isGeneralProject(project)) {
      return commandResponse(command, false, { error: "The General home workspace cannot be removed" });
    }
    if (!project) {
      return commandResponse(command, false, { error: "Project not found" });
    }
    if (!this.options.terminalCleanup && this.database.listTerminalRecords(projectId).length > 0) {
      return commandResponse(command, false, { error: "Project terminals cannot be stopped right now" });
    }

    let sessionIds = this.events.sessionSummariesForProject(projectId).map((session) => session.id);
    this.deletingProjects.add(projectId);
    for (const sessionId of sessionIds) this.deleting.add(sessionId);
    let terminalRemoval: PreparedProjectTerminalRemoval | undefined;
    const preparedParentIds = new Set<string>();
    try {
      const parentSessionIds = sessionIds.filter((sessionId) => !this.database.getSession(sessionId)?.session.internal);
      for (const parentSessionId of parentSessionIds) {
        await this.options.deleteOwnedSubagents?.(parentSessionId);
        preparedParentIds.add(parentSessionId);
      }
      await Promise.all(sessionIds.map((sessionId) =>
        this.withSessionLifecycle(sessionId, () => this.stopSessionRuntime(sessionId)),
      ));
      await this.waitForProjectCommands(projectId, command.id);

      // A session creation that began immediately before the removal barrier may
      // have committed while runtimes were stopping. Include it before deleting.
      const refreshedSessionIds = this.events.sessionSummariesForProject(projectId).map((session) => session.id);
      const addedSessionIds = refreshedSessionIds.filter((sessionId) => !sessionIds.includes(sessionId));
      for (const sessionId of addedSessionIds) this.deleting.add(sessionId);
      for (const sessionId of addedSessionIds) {
        if (!this.database.getSession(sessionId)?.session.internal) {
          await this.options.deleteOwnedSubagents?.(sessionId);
          preparedParentIds.add(sessionId);
        }
      }
      await Promise.all(addedSessionIds.map((sessionId) =>
        this.withSessionLifecycle(sessionId, () => this.stopSessionRuntime(sessionId)),
      ));
      sessionIds = refreshedSessionIds;
      for (const sessionId of sessionIds) {
        for (const request of this.events.pendingInteractionsForSession(sessionId)) {
          const timer = this.interactionTimers.get(request.id);
          if (timer) clearTimeout(timer);
          this.interactionTimers.delete(request.id);
        }
      }

      terminalRemoval = await this.options.terminalCleanup?.prepareProjectRemoval(projectId);
      const deleted = this.events.deleteProject(
        projectId,
        domainEvent("project.deleted", { projectId }, null),
      );
      terminalRemoval?.finalize();
      terminalRemoval = undefined;
      for (const sessionId of deleted.sessionIds) {
        try {
          rmSync(join(this.config.sessionDir, sessionId), { recursive: true, force: true });
        } catch (error) {
          process.stderr.write(
            `[pi:${sessionId}] Project removed; session file cleanup will retry after restart: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      return commandResponse(command, true);
    } finally {
      terminalRemoval?.cancel();
      for (const parentSessionId of preparedParentIds) {
        this.options.finishParentSubagentDeletion?.(parentSessionId);
      }
      for (const sessionId of sessionIds) this.deleting.delete(sessionId);
      this.deletingProjects.delete(projectId);
    }
  }

  private async deleteSession(
    command: Extract<AnvilClientCommand, { type: "session.delete" }>,
  ): Promise<AnvilCommandResponse> {
    const sessionId = command.payload.sessionId;
    const stored = this.database.getSession(sessionId);
    if (!stored) return commandResponse(command, false, { error: "Session not found" });

    this.deleting.add(sessionId);
    let parentDeletionPrepared = false;
    try {
      if (stored.session.internal) {
        await this.options.prepareChildSubagentDeletion?.(sessionId);
      } else {
        await this.options.deleteOwnedSubagents?.(sessionId);
        parentDeletionPrepared = true;
      }
      await this.stopAndDeleteSession(sessionId);
      return commandResponse(command, true);
    } finally {
      if (parentDeletionPrepared) this.options.finishParentSubagentDeletion?.(sessionId);
      this.deleting.delete(sessionId);
    }
  }

  private async stopAndDeleteSession(sessionId: string): Promise<void> {
    const starting = this.starting.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await this.stopRuntime(runtime);
    if (starting) await starting.catch(() => undefined);
    const settledRuntime = this.runtimes.get(sessionId);
    if (settledRuntime && settledRuntime !== runtime) await this.stopRuntime(settledRuntime);
    this.runtimes.delete(sessionId);

    for (const request of this.events.pendingInteractionsForSession(sessionId)) {
      const timer = this.interactionTimers.get(request.id);
      if (timer) clearTimeout(timer);
      this.interactionTimers.delete(request.id);
    }
    if (!this.database.getSession(sessionId)) return;
    this.events.deleteSession(sessionId, domainEvent("session.deleted", { sessionId }, sessionId));
    try {
      rmSync(join(this.config.sessionDir, sessionId), { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `[pi:${sessionId}] Session deleted; file cleanup will retry after restart: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private async stopSessionRuntime(sessionId: string): Promise<void> {
    const starting = this.starting.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await this.stopRuntime(runtime);
    if (starting) await starting.catch(() => undefined);
    const startedRuntime = this.runtimes.get(sessionId);
    if (startedRuntime && startedRuntime !== runtime) await this.stopRuntime(startedRuntime);
    this.runtimes.delete(sessionId);
  }

  private async stopRuntime(runtime: ManagedSession): Promise<void> {
    runtime.stopping = true;
    this.clearIdleTimer(runtime);
    this.flushPendingStreamEvent(runtime);
    this.clearToolTimers(runtime);
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
    const project = this.projectResolver.resolveProject(stored.session.projectId);
    if (!project) return undefined;
    const runtime = this.runtimes.get(sessionId);
    const cached = { projectPath: project.path, context: stored.contextUsage };
    if (!runtime?.rpc.running) return cached;
    let response: RpcRecord;
    try {
      response = await this.sendSuppressedRequest(runtime, { type: "get_session_stats" });
    } catch {
      return cached;
    }
    if (rpcFailure(response)) return cached;
    const context = rpcData(response).contextUsage;
    const item = context && typeof context === "object" && !Array.isArray(context)
      ? context as Record<string, unknown>
      : undefined;
    const contextWindow = typeof item?.contextWindow === "number" ? item.contextWindow : undefined;
    if (contextWindow === undefined) return cached;
    const current = {
      tokens: typeof item?.tokens === "number" ? item.tokens : null,
      contextWindow,
      percent: typeof item?.percent === "number" ? item.percent : null,
    };
    // The conditional update in ForgeDatabase avoids a disk write when the
    // periodic indicator poll returns the same values.
    this.database.updateSessionContextUsage(sessionId, current);
    return { projectPath: project.path, context: current };
  }

  private async ensureRuntime(stored: RuntimeSessionRecord): Promise<ManagedSession> {
    const existing = this.runtimes.get(stored.session.id);
    if (existing?.rpc.running) {
      this.clearIdleTimer(existing);
      return existing;
    }
    const pending = this.starting.get(stored.session.id);
    if (pending) return pending;

    const starting = this.startRuntime(stored).finally(() => this.starting.delete(stored.session.id));
    this.starting.set(stored.session.id, starting);
    return starting;
  }

  private async startRuntime(stored: RuntimeSessionRecord): Promise<ManagedSession> {
    const project = this.projectResolver.resolveProject(stored.session.projectId);
    if (!project) throw new Error("The session project is no longer configured");
    const baseTimestamp = Date.now();
    const adapter = createPiRpcAdapterState({
      fixtureId: `pi-${stored.session.id}`,
      sessionId: stored.session.id,
      baseTimestamp: new Date(baseTimestamp).toISOString(),
    });
    const sessionDir = join(this.config.sessionDir, stored.session.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const runtimeEnvironment = {
      ...(this.options.runtimeEnvironment?.(stored) ?? process.env),
    };
    delete runtimeEnvironment.OCODE_SESSION_ID;
    if (!stored.session.internal) runtimeEnvironment.OCODE_SESSION_ID = stored.session.id;
    const rpc = createPiRpcProcess({
      executable: this.config.piExecutable,
      cwd: project.path,
      sessionDir,
      env: runtimeEnvironment,
      extraArgs: [
        "--exclude-tools",
        stored.session.internal ? "subagent,ocode_subagent" : "subagent",
        ...(this.config.piExtensionPath ? ["--extension", this.config.piExtensionPath] : []),
      ],
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
      const models = await rpc.sendRequest({ type: "get_available_models" });
      const modelsError = rpcFailure(models);
      if (modelsError) throw new Error(`Pi could not load models: ${modelsError}`);
      await rpc.sendRequest({ type: "get_commands" });

      this.syncSession(stored.session.id, {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
      });
      if (data.isStreaming !== true) this.scheduleIdleStop(stored.session.id, runtime);
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
    const handoff = ocodeHandoffRequest(record);
    if (handoff) {
      void this.handleOcodeHandoffRequest(sessionId, runtime, handoff).catch((error) => {
        this.respondToOcodeHandoff(runtime, handoff.requestId, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    try {
      const at = Math.max(0, Date.now() - runtime.baseTimestamp);
      const normalized = normalizePiRpcRecord(runtime.adapter, record, at);
      if (normalized.some((event) => event.type === "session.configured" && event.payload.title !== undefined)) {
        this.provisionalTitleOwners.delete(sessionId);
      }
      this.appendNormalizedEvents(sessionId, runtime, normalized);
      if (record.type === "agent_start") this.clearIdleTimer(runtime);
      if (record.type === "tool_execution_start") this.armToolTimer(sessionId, runtime, record);
      if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
        this.clearToolTimer(runtime, record.toolCallId);
      }
      if (record.type === "agent_settled") {
        const session = this.events.sessionSummary(sessionId);
        if (session) this.refreshProjectBranch(session.projectId);
      }
      if (normalized.some((event) => SESSION_SUMMARY_EVENT_TYPES.has(event.type))) {
        this.syncSession(sessionId);
      }
      if (record.type === "agent_settled") {
        if (this.runningTools(sessionId).length > 0) {
          this.failRuntime(sessionId, runtime, "Pi settled without reporting a result for a running tool");
        } else {
          this.scheduleIdleStop(sessionId, runtime);
        }
      }
    } catch (error) {
      const message = `Failed to persist RPC record: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`[pi:${sessionId}] ${message}\n`);
      this.failRuntime(sessionId, runtime, message);
    }
  }

  private async handleOcodeHandoffRequest(
    sourceSessionId: string,
    sourceRuntime: ManagedSession,
    request: { requestId: string; handoffPath?: string; error?: string },
  ): Promise<void> {
    if (request.error || !request.handoffPath) {
      this.respondToOcodeHandoff(sourceRuntime, request.requestId, {
        error: request.error ?? "The handoff file is unavailable",
      });
      return;
    }

    const source = this.database.getSession(sourceSessionId);
    if (!source || source.session.internal) {
      this.respondToOcodeHandoff(sourceRuntime, request.requestId, {
        error: "Only an ordinary ocode thread can create a handoff",
      });
      return;
    }

    const sessionId = randomUUID();
    const handoffCreatedAt = new Date().toISOString();
    const handoffDetails = {
      kind: "ocode.handoff",
      schemaVersion: 1,
      sourceSessionId,
      targetSessionId: sessionId,
    } as const;
    this.pendingSessionCreationEvents.set(sessionId, [
      domainEvent("timeline.event", {
        entry: {
          id: `handoff-outgoing-${sessionId}`,
          kind: "event",
          category: "lifecycle",
          tone: "success",
          title: "Handoff created",
          details: { ...handoffDetails, direction: "outgoing" },
          createdAt: handoffCreatedAt,
        },
      }, sourceSessionId),
      domainEvent("timeline.event", {
        entry: {
          id: `handoff-incoming-${sessionId}`,
          kind: "event",
          category: "lifecycle",
          tone: "info",
          title: "Continued from another thread",
          details: { ...handoffDetails, direction: "incoming" },
          createdAt: handoffCreatedAt,
        },
      }, sessionId),
    ]);
    let created: AnvilCommandResponse;
    try {
      created = await this.handleCommand({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: randomUUID(),
        sessionId: null,
        timestamp: handoffCreatedAt,
        type: "session.create",
        payload: { projectId: source.session.projectId, sessionId },
      });
    } finally {
      this.pendingSessionCreationEvents.delete(sessionId);
    }
    if (!created.success) throw new Error(created.error ?? "Forge could not create the handoff thread");

    const fresh = this.database.getSession(sessionId);
    if (!fresh) throw new Error("The handoff thread disappeared during creation");
    await this.ensureRuntime(fresh);

    const catalog = this.events.catalogForSession(sessionId);
    if (
      source.session.modelId !== "unknown" &&
      source.session.modelId !== this.events.sessionSummary(sessionId)?.modelId &&
      catalog?.models.some((model) => model.id === source.session.modelId)
    ) {
      await this.handleCommand({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "model.set",
        payload: { modelId: source.session.modelId },
      });
    }

    const activeModelId = this.events.sessionSummary(sessionId)?.modelId;
    const activeModel = catalog?.models.find((model) => model.id === activeModelId);
    if (
      activeModel?.supportedThinkingLevels.includes(source.session.thinkingLevel) &&
      this.events.sessionSummary(sessionId)?.thinkingLevel !== source.session.thinkingLevel
    ) {
      await this.handleCommand({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "thinking.set",
        payload: { level: source.session.thinkingLevel },
      });
    }

    this.events.append([domainEvent("session.selected", { sessionId }, sourceSessionId)]);
    const kickoff = `Read and understand this handoff file: ${request.handoffPath}\n\nExplain back to me CONCISELY what it is, then wait for my next instruction.`;
    const prompted = await this.handleCommand({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: "prompt.send",
      payload: { content: kickoff, delivery: "prompt" },
    });
    if (!prompted.success) throw new Error(prompted.error ?? "Forge could not start the handoff thread");

    this.respondToOcodeHandoff(sourceRuntime, request.requestId, { sessionId });
  }

  private respondToOcodeHandoff(
    runtime: ManagedSession,
    requestId: string,
    result: { sessionId?: string; error?: string },
  ): void {
    if (!runtime.rpc.running) return;
    const value = JSON.stringify({
      kind: "ocode.handoff.result",
      schemaVersion: 1,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.error ? { error: result.error.slice(0, 1_000) } : {}),
    });
    try {
      runtime.rpc.send({ type: "extension_ui_response", id: requestId, value });
    } catch {
      // Runtime exit handling owns any failure after the originating thread disappears.
    }
  }

  private onExit(sessionId: string, runtime: ManagedSession): void {
    let flushError: unknown;
    try {
      this.flushPendingStreamEvent(runtime);
    } catch (error) {
      flushError = error;
    }
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
    if (runtime.stopping || runtime.failureReported) {
      if (flushError) {
        process.stderr.write(
          `[pi:${sessionId}] Failed to persist buffered output while stopping: ${flushError instanceof Error ? flushError.message : String(flushError)}\n`,
        );
      }
      return;
    }
    this.failRuntime(
      sessionId,
      runtime,
      flushError
        ? `Failed to persist buffered RPC output: ${flushError instanceof Error ? flushError.message : String(flushError)}`
        : "Pi subprocess exited unexpectedly",
    );
  }

  private failRuntime(sessionId: string, runtime: ManagedSession, message: string): void {
    if (runtime.failureReported) return;
    runtime.failureReported = true;
    this.clearIdleTimer(runtime);
    this.flushPendingStreamEvent(runtime);
    this.clearToolTimers(runtime);
    const pending = this.events.pendingInteractionsForSession(sessionId);
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

  private scheduleIdleStop(sessionId: string, runtime: ManagedSession): void {
    this.clearIdleTimer(runtime);
    const timeoutMs = this.options.idleRuntimeTimeoutMs ?? DEFAULT_IDLE_RUNTIME_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined;
      void this.withSessionLifecycle(sessionId, async () => {
        if (this.runtimes.get(sessionId) !== runtime || runtime.stopping) return;
        const session = this.events.sessionSummary(sessionId);
        if (
          session?.status !== "idle" ||
          this.events.pendingInteractionsForSession(sessionId).length > 0 ||
          (this.activeCommandCounts.get(sessionId) ?? 0) > 0 ||
          this.runningTools(sessionId).length > 0
        ) {
          return;
        }
        await this.stopSessionRuntime(sessionId);
      }).catch((error) => {
        process.stderr.write(
          `[pi:${sessionId}] Failed to stop idle runtime: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, Math.min(timeoutMs, 2_147_483_647));
    runtime.idleTimer.unref();
  }

  private clearIdleTimer(runtime: ManagedSession): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }

  private appendNormalizedEvents(
    sessionId: string,
    runtime: ManagedSession,
    events: UnsequencedAnvilEvent[],
  ): void {
    events = this.annotateMessageOrigins(sessionId, events);
    const [event] = events;
    if (events.length === 1 && event && this.isStreamDeltaEvent(event)) {
      const pending = runtime.pendingStreamEvent;
      if (pending && this.canMergeStreamEvents(pending, event)) {
        runtime.pendingStreamEvent = {
          ...event,
          payload: { ...event.payload, delta: pending.payload.delta + event.payload.delta },
        } as StreamDeltaEvent;
      } else {
        this.flushPendingStreamEvent(runtime);
        runtime.pendingStreamEvent = event;
      }
      if (Buffer.byteLength(runtime.pendingStreamEvent.payload.delta) >= MAX_STREAM_BATCH_BYTES) {
        this.flushPendingStreamEvent(runtime);
        return;
      }
      if (!runtime.streamFlushTimer) {
        runtime.streamFlushTimer = setTimeout(() => {
          runtime.streamFlushTimer = undefined;
          try {
            this.flushPendingStreamEvent(runtime);
          } catch (error) {
            const message = `Failed to persist buffered RPC output: ${error instanceof Error ? error.message : String(error)}`;
            process.stderr.write(`[pi:${sessionId}] ${message}\n`);
            this.failRuntime(sessionId, runtime, message);
          }
        }, STREAM_BATCH_MS);
        runtime.streamFlushTimer.unref();
      }
      return;
    }

    this.flushPendingStreamEvent(runtime);
    if (events.length > 0) this.events.append(events);
  }

  private annotateMessageOrigins(
    sessionId: string,
    events: UnsequencedAnvilEvent[],
  ): UnsequencedAnvilEvent[] {
    if (!events.some((event) => event.type === "message.started" && event.payload.message.role === "user")) {
      return events;
    }
    const runs = this.database.subagents.list(sessionId);
    if (runs.length === 0) return events;
    return events.map((event) => {
      if (event.type !== "message.started" || event.payload.message.role !== "user" || event.payload.message.origin) {
        return event;
      }
      const origin = subagentCompletionOrigin(sessionId, event.payload.message, runs);
      return origin
        ? { ...event, payload: { message: { ...event.payload.message, origin } } }
        : event;
    });
  }

  private isStreamDeltaEvent(event: UnsequencedAnvilEvent): event is StreamDeltaEvent {
    return event.type === "reasoning.delta" ||
      (event.type === "message.delta" && event.payload.artifact === undefined);
  }

  private canMergeStreamEvents(previous: StreamDeltaEvent, next: StreamDeltaEvent): boolean {
    if (previous.type !== next.type) return false;
    if (previous.type === "reasoning.delta" && next.type === "reasoning.delta") {
      return previous.payload.reasoningId === next.payload.reasoningId;
    }
    if (previous.type === "message.delta" && next.type === "message.delta") {
      return previous.payload.messageId === next.payload.messageId &&
        previous.payload.blockId === next.payload.blockId &&
        previous.payload.modelId === next.payload.modelId;
    }
    return false;
  }

  private flushPendingStreamEvent(runtime: ManagedSession): void {
    if (runtime.streamFlushTimer) clearTimeout(runtime.streamFlushTimer);
    runtime.streamFlushTimer = undefined;
    const pending = runtime.pendingStreamEvent;
    runtime.pendingStreamEvent = undefined;
    if (pending) this.events.append([pending]);
  }

  private runningTools(sessionId: string): ToolEntry[] {
    return this.events.timelineForSession(sessionId).filter(
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
    const project = this.projectResolver.resolveProject(projectId);
    if (!project) return;
    const branch = gitBranch(project.path);
    const affected = this.events.sessionSummariesForProject(projectId).filter(
      (session) => session.branch !== branch,
    );
    if (affected.length === 0) return;
    this.events.append(affected.map((session) => domainEvent(
      "session.configured",
      { branch: branch ?? null },
      session.id,
    )));
    for (const previous of affected) {
      const session = this.events.sessionSummary(previous.id);
      if (session) this.database.updateSession(session);
    }
  }

  private syncSession(sessionId: string, piState?: { sessionId?: string; sessionFile?: string }): void {
    const session = this.events.sessionSummary(sessionId);
    if (!session) return;
    if (piState?.sessionFile) {
      const ownedDirectory = `${resolve(this.config.sessionDir, sessionId)}${sep}`;
      const sessionFile = resolve(piState.sessionFile);
      if (!sessionFile.startsWith(ownedDirectory)) {
        throw new Error("Pi reported a session file outside its ocode session directory");
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

  private projectIdForCommand(command: AnvilClientCommand): string | undefined {
    if (command.type === "session.create") return command.payload.projectId;
    // Project deletions are already serialized by withProjectLifecycle. Tracking
    // them here would make one deletion wait on another queued behind itself.
    if (command.type === "project.delete") return undefined;
    const sessionId = command.type === "session.delete" ? command.payload.sessionId : command.sessionId;
    return sessionId ? this.database.getSession(sessionId)?.session.projectId : undefined;
  }

  private async waitForProjectCommands(projectId: string, excludedCommandId: string): Promise<void> {
    const commands = [...this.inFlightCommands.entries()]
      .filter(([commandId]) => commandId !== excludedCommandId && this.inFlightCommandProjects.get(commandId) === projectId)
      .map(([, execution]) => execution);
    await Promise.allSettled(commands);
  }

  private afterSessionLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const barrier = this.lifecycleTails.get(sessionId);
    return barrier ? barrier.then(operation, operation) : operation();
  }

  private withProjectLifecycle<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectLifecycleTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.projectLifecycleTails.set(projectId, tail);
    return result.finally(() => {
      if (this.projectLifecycleTails.get(projectId) === tail) this.projectLifecycleTails.delete(projectId);
    });
  }

  private withSessionLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.lifecycleTails.set(sessionId, tail);
    return result.finally(() => {
      if (this.lifecycleTails.get(sessionId) === tail) this.lifecycleTails.delete(sessionId);
    });
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
