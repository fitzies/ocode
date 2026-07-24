import {
  ANVIL_PROTOCOL_VERSION,
  decodeAnvilEvent,
  isAnvilBootstrap,
  isAnvilSessionDetailSync,
  isAnvilSummaryBootstrap,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type AnvilSessionDetail,
  type AnvilSnapshot,
  type ArtifactReference,
  type InteractionResponse,
  type JsonValue,
  type SessionSummary,
  type ThinkingLevel,
  type TimelineEntry,
} from "@anvil/protocol";
import {
  createPiRpcAdapterState,
  normalizePiRpcRecord,
  normalizeRecordedRpcItems,
  type PiRpcAdapterState,
  type UnsequencedAnvilEvent,
} from "@anvil/pi-rpc";
import {
  applyAnvilEvent,
  applyAnvilEvents,
  createEmptySnapshot,
  reconcileSnapshotAndTail,
  resetSessionState,
  sortSessionsByActivity,
} from "@anvil/state";

import { PromptOutbox } from "./promptOutbox";
import { ThreadCache, summaryBootstrapFromSnapshot } from "./threadCache";
import { fixtureById, fixtureCatalog, fixtures, type FixtureDefinition } from "../fixtures";

export type DeliveryMode = "prompt" | "steer" | "followUp";

export interface WorkspaceFile {
  path: string;
}

export interface ReplayStatus {
  fixtureId: string;
  playing: boolean;
  cursor: number;
  total: number;
  speed: number;
}

export interface AnvilClientSnapshot extends AnvilSnapshot {
  replay: ReplayStatus;
  clientError?: string;
  readThroughSequences: Record<string, number>;
  hydratingSessionIds: string[];
}

interface PendingSessionCreate {
  session: SessionSummary;
  command: Extract<AnvilClientCommand, { type: "session.create" }>;
  previousActiveSessionId: string | null;
  state: "creating" | "acknowledged" | "failed";
  requestInFlight: boolean;
  error?: string;
  settled: Promise<boolean>;
  resolveSettled(created: boolean): void;
}

export interface AnvilClient {
  getSnapshot(): AnvilClientSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(command: AnvilClientCommand): void;
  selectSession(sessionId: string): void;
  createProject(name: string, path: string): Promise<void>;
  createSession(projectId: string): void;
  deleteSession(sessionId: string): Promise<void>;
  setSessionSettled(sessionId: string, settled: boolean): Promise<void>;
  sendPrompt(content: string, mode?: DeliveryMode, attachments?: ArtifactReference[]): Promise<boolean>;
  uploadAttachment(sessionId: string, file: File): Promise<ArtifactReference>;
  deleteAttachment(sessionId: string, artifactId: string): Promise<void>;
  searchFiles(sessionId: string, query: string): Promise<WorkspaceFile[]>;
  rebuildWebApp(): Promise<void>;
  cancelActiveRun(): void;
  setModel(modelId: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  respondToInteraction(response: InteractionResponse): void;
  clearComposerDraft(sessionId: string): void;
  isSessionPending(sessionId: string): boolean;
  getSessionCreationError(sessionId: string): string | undefined;
  markSessionRead(sessionId: string): void;
  cycleConnectionState(): void;
  selectReplayFixture(fixtureId: string): void;
  toggleReplay(): void;
  restartReplay(): void;
  instantReplay(): void;
  setReplaySpeed(speed: number): void;
}

const uniqueById = <T extends { id: string }>(items: T[]) =>
  [...new Map(items.map((item) => [item.id, item])).values()];

const initialProjects = uniqueById(fixtures.map((fixture) => fixture.project));
const initialSessions = fixtures.map((fixture) => fixture.session);

function timestamp() {
  return new Date().toISOString();
}

function promoteSession(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
): AnvilClientSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return snapshot;
  return {
    ...snapshot,
    sessions: sortSessionsByActivity([
      {
        ...session,
        updatedAt: timestamp(),
        lastActivitySequence: Math.max(session.lastActivitySequence ?? 0, snapshot.lastSequence + 1),
      },
      ...snapshot.sessions.filter((candidate) => candidate.id !== sessionId),
    ]),
  };
}

function addOptimisticSession<TSnapshot extends AnvilSnapshot>(
  snapshot: TSnapshot,
  session: SessionSummary,
): TSnapshot {
  return {
    ...snapshot,
    activeSessionId: session.id,
    sessions: [session, ...snapshot.sessions.filter((candidate) => candidate.id !== session.id)],
    timelines: { ...snapshot.timelines, [session.id]: snapshot.timelines[session.id] ?? [] },
    catalogs: {
      ...snapshot.catalogs,
      [session.id]: snapshot.catalogs[session.id] ?? { models: [], commands: [], skills: [] },
    },
    queues: {
      ...snapshot.queues,
      [session.id]: snapshot.queues[session.id] ?? { steering: [], followUp: [] },
    },
    runStates: { ...snapshot.runStates, [session.id]: snapshot.runStates[session.id] ?? "idle" },
  } as TSnapshot;
}

function withoutSessionKey<T>(record: Record<string, T>, sessionId: string): Record<string, T> {
  const next = { ...record };
  delete next[sessionId];
  return next;
}

const optimisticMessageId = (commandId: string) => `optimistic-${commandId}`;

function addOptimisticPrompt(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  commandId: string,
  content: string,
): AnvilClientSnapshot {
  const id = optimisticMessageId(commandId);
  if ((snapshot.timelines[sessionId] ?? []).some((entry) => entry.id === id)) return snapshot;
  return {
    ...snapshot,
    timelines: {
      ...snapshot.timelines,
      [sessionId]: [
        ...(snapshot.timelines[sessionId] ?? []),
        {
          id,
          kind: "message",
          role: "user",
          content: [{ id: `${id}-text`, type: "text", text: content }],
          status: "streaming",
          createdAt: timestamp(),
        },
      ],
    },
  };
}

function settleOptimisticPrompt(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  error?: string,
  expectedContent?: string,
): AnvilClientSnapshot {
  const timeline = snapshot.timelines[sessionId] ?? [];
  const index = timeline.findIndex((entry) =>
    entry.kind === "message" &&
    entry.status === "streaming" &&
    entry.id.startsWith("optimistic-") &&
    (expectedContent === undefined || entry.content.some((block) => block.type === "text" && expectedContent.startsWith(block.text))),
  );
  if (index < 0) return snapshot;
  const next = [...timeline];
  if (error) {
    const entry = next[index]!;
    next[index] = entry.kind === "message" ? { ...entry, status: "failed", error } : entry;
  } else {
    next.splice(index, 1);
  }
  return { ...snapshot, timelines: { ...snapshot.timelines, [sessionId]: next } };
}

function removeOptimisticSession(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  fallbackSessionId: string | null,
): AnvilClientSnapshot {
  const sessions = snapshot.sessions.filter((session) => session.id !== sessionId);
  const fallback = fallbackSessionId && sessions.some((session) => session.id === fallbackSessionId)
    ? fallbackSessionId
    : sessions[0]?.id ?? null;
  return {
    ...snapshot,
    sessions,
    activeSessionId: snapshot.activeSessionId === sessionId ? fallback : snapshot.activeSessionId,
    timelines: withoutSessionKey(snapshot.timelines, sessionId),
    catalogs: withoutSessionKey(snapshot.catalogs, sessionId),
    pendingInteractions: snapshot.pendingInteractions.filter((request) => request.sessionId !== sessionId),
    extensionStatuses: snapshot.extensionStatuses.filter((status) => status.sessionId !== sessionId),
    widgets: snapshot.widgets.filter((widget) => widget.sessionId !== sessionId),
    queues: withoutSessionKey(snapshot.queues, sessionId),
    composerDrafts: withoutSessionKey(snapshot.composerDrafts, sessionId),
    runStates: withoutSessionKey(snapshot.runStates, sessionId),
  };
}

function mergeSessionDetail<TSnapshot extends AnvilSnapshot>(
  snapshot: TSnapshot,
  detail: AnvilSessionDetail,
): TSnapshot {
  return {
    ...snapshot,
    timelines: { ...snapshot.timelines, [detail.sessionId]: detail.timeline },
    catalogs: { ...snapshot.catalogs, [detail.sessionId]: detail.catalog },
    pendingInteractions: [
      ...snapshot.pendingInteractions.filter((request) => request.sessionId !== detail.sessionId),
      ...detail.pendingInteractions,
    ],
    extensionStatuses: [
      ...snapshot.extensionStatuses.filter((status) => status.sessionId !== detail.sessionId),
      ...detail.extensionStatuses,
    ],
    widgets: [
      ...snapshot.widgets.filter((widget) => widget.sessionId !== detail.sessionId),
      ...detail.widgets,
    ],
    queues: { ...snapshot.queues, [detail.sessionId]: detail.queue },
    composerDrafts: { ...snapshot.composerDrafts, [detail.sessionId]: detail.composerDraft },
    runStates: { ...snapshot.runStates, [detail.sessionId]: detail.runState },
  } as TSnapshot;
}

function withoutSessionDetail<TSnapshot extends AnvilSnapshot>(
  snapshot: TSnapshot,
  sessionId: string,
): TSnapshot {
  return {
    ...snapshot,
    timelines: withoutSessionKey(snapshot.timelines, sessionId),
    catalogs: withoutSessionKey(snapshot.catalogs, sessionId),
    pendingInteractions: snapshot.pendingInteractions.filter((request) => request.sessionId !== sessionId),
    extensionStatuses: snapshot.extensionStatuses.filter((status) => status.sessionId !== sessionId),
    widgets: snapshot.widgets.filter((widget) => widget.sessionId !== sessionId),
    queues: withoutSessionKey(snapshot.queues, sessionId),
    composerDrafts: withoutSessionKey(snapshot.composerDrafts, sessionId),
  } as TSnapshot;
}

function detailFromSnapshot(
  snapshot: AnvilSnapshot,
  sessionId: string,
  throughSequence: number,
): AnvilSessionDetail {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    sessionId,
    throughSequence,
    timeline: snapshot.timelines[sessionId] ?? [],
    catalog: snapshot.catalogs[sessionId] ?? { models: [], commands: [], skills: [] },
    pendingInteractions: snapshot.pendingInteractions.filter((request) => request.sessionId === sessionId),
    extensionStatuses: snapshot.extensionStatuses.filter((status) => status.sessionId === sessionId),
    widgets: snapshot.widgets.filter((widget) => widget.sessionId === sessionId),
    queue: snapshot.queues[sessionId] ?? { steering: [], followUp: [] },
    composerDraft: snapshot.composerDrafts[sessionId] ?? "",
    runState: snapshot.runStates[sessionId] ?? "idle",
  };
}

function applyDetailDelta(
  detail: AnvilSessionDetail,
  session: SessionSummary,
  events: AnvilEvent[],
  throughSequence: number,
): AnvilSessionDetail {
  let temporary = mergeSessionDetail(
    { ...createEmptySnapshot({ sessions: [session], activeSessionId: session.id }), lastSequence: detail.throughSequence },
    detail,
  );
  for (const event of events) {
    temporary = applyAnvilEvent(
      { ...temporary, lastSequence: event.sequence - 1, sequenceGap: null },
      event,
    );
  }
  return detailFromSnapshot(temporary, session.id, throughSequence);
}

function textBlock(id: string, text: string) {
  return { id, type: "text" as const, text };
}

function sequenceEvents(
  events: UnsequencedAnvilEvent[],
  after: number,
  idPrefix: string,
): AnvilEvent[] {
  return events.map((event, index) => ({
    ...event,
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: `${idPrefix}-${after + index + 1}`,
    sequence: after + index + 1,
  } as AnvilEvent));
}

export class FixtureAnvilClient implements AnvilClient {
  private snapshot: AnvilClientSnapshot;
  private readonly listeners = new Set<() => void>();
  private replayTimer?: ReturnType<typeof setTimeout>;
  private replayAdapter?: PiRpcAdapterState;
  private readonly simulationTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();
  private localId = 0;

  constructor() {
    let base = createEmptySnapshot({
      projects: initialProjects,
      sessions: initialSessions,
      catalogs: Object.fromEntries(
        initialSessions.map((session) => [session.id, fixtureCatalog]),
      ),
      activeSessionId: fixtures[0]?.session.id ?? null,
      capturedAt: fixtures[0]?.baseTimestamp,
    });

    for (const fixture of fixtures) {
      const adapter = createPiRpcAdapterState({
        fixtureId: fixture.id,
        sessionId: fixture.session.id,
        baseTimestamp: fixture.baseTimestamp,
      });
      base = applyAnvilEvents(
        base,
        sequenceEvents(
          normalizeRecordedRpcItems(adapter, fixture.records),
          base.lastSequence,
          fixture.id,
        ),
      );
    }

    const initialFixture = fixtures[0]!;
    this.snapshot = {
      ...base,
      readThroughSequences: Object.fromEntries(
        base.sessions.flatMap((session) => session.lastTerminalSequence
          ? [[session.id, session.lastTerminalSequence] as const]
          : []),
      ),
      hydratingSessionIds: [],
      replay: {
        fixtureId: initialFixture.id,
        playing: false,
        cursor: initialFixture.records.length,
        total: initialFixture.records.length,
        speed: 1,
      },
    };
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (command: AnvilClientCommand) => {
    switch (command.type) {
      case "project.create":
        this.createProject(command.payload.name, command.payload.path);
        break;
      case "session.select":
        this.selectSession(command.payload.sessionId);
        break;
      case "session.create":
        this.createSession(command.payload.projectId);
        break;
      case "session.delete":
        this.deleteSession(command.payload.sessionId);
        break;
      case "session.settled":
        if (command.sessionId) this.setSessionSettled(command.sessionId, command.payload.settled);
        break;
      case "prompt.send":
        this.sendPrompt(command.payload.content, command.payload.delivery, command.payload.attachments);
        break;
      case "run.cancel":
        this.cancelActiveRun();
        break;
      case "model.set":
        this.setModel(command.payload.modelId);
        break;
      case "thinking.set":
        this.setThinkingLevel(command.payload.level);
        break;
      case "interaction.respond":
        this.respondToInteraction(command.payload);
        break;
    }
  };

  selectSession = (sessionId: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    this.pauseReplay();
    const fixture = fixtureById.get(sessionId);
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: sessionId,
      replay: fixture
        ? {
            ...this.snapshot.replay,
            fixtureId: fixture.id,
            cursor: fixture.records.length,
            total: fixture.records.length,
          }
        : this.snapshot.replay,
    };
    this.emit();
  };

  createProject = async (name: string, path: string) => {
    const cleanName = name.trim();
    const cleanPath = path.trim();
    if (!cleanName || !cleanPath) return;
    const project = {
      id: `workspace-${Date.now()}`,
      name: cleanName,
      path: cleanPath,
    };
    this.applyLocal("project.upserted", { project }, null);
  };

  createSession = (projectId: string) => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    this.pauseReplay();
    const id = `session-${Date.now()}`;
    const model = fixtureCatalog.models[0];
    const session: SessionSummary = {
      id,
      projectId,
      title: "New session",
      updatedAt: timestamp(),
      status: "idle",
      modelId: model?.id ?? "unknown",
      thinkingLevel: model?.supportedThinkingLevels.includes("high") ? "high" : "off",
      branch: "main",
      lastActivitySequence: this.snapshot.lastSequence + 1,
    };
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: id,
      sessions: [session, ...this.snapshot.sessions],
      timelines: { ...this.snapshot.timelines, [id]: [] },
      queues: { ...this.snapshot.queues, [id]: { steering: [], followUp: [] } },
      catalogs: { ...this.snapshot.catalogs, [id]: fixtureCatalog },
      runStates: { ...this.snapshot.runStates, [id]: "idle" },
    };
    this.emit();
  };

  deleteSession = async (sessionId: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    for (const timer of this.simulationTimers.get(sessionId) ?? []) clearTimeout(timer);
    this.simulationTimers.delete(sessionId);
    this.applyLocal("session.deleted", { sessionId }, sessionId);
  };

  setSessionSettled = async (sessionId: string, settled: boolean) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    this.applyLocal("session.settled", { settled }, sessionId);
  };

  sendPrompt = (content: string, mode: DeliveryMode = "prompt", attachments: ArtifactReference[] = []): Promise<boolean> => {
    const prompt = content.trim() || (attachments.length ? "Review the attached files." : "");
    const session = this.activeSession();
    if (!prompt || !session) return Promise.resolve(false);

    this.snapshot = promoteSession(this.snapshot, session.id);
    this.emit();

    if (this.snapshot.runStates[session.id] === "running" && mode !== "prompt") {
      const current = this.snapshot.queues[session.id] ?? { steering: [], followUp: [] };
      const queue =
        mode === "steer"
          ? { ...current, steering: [...current.steering, prompt] }
          : { ...current, followUp: [...current.followUp, prompt] };
      this.applyLocal("queue.updated", queue, session.id);
      this.applyLocal(
        "timeline.event",
        {
          entry: {
            id: `queued-${++this.localId}`,
            kind: "event",
            category: "lifecycle",
            tone: "info",
            title: mode === "steer" ? "Steering message queued" : "Follow-up queued",
            message: prompt,
            createdAt: timestamp(),
          },
        },
        session.id,
      );
      return Promise.resolve(true);
    }

    const runId = `${Date.now()}-${++this.localId}`;
    const messageId = `local-user-${runId}`;
    this.applyLocal(
      "message.started",
      {
        message: {
          id: messageId,
          kind: "message",
          role: "user",
          content: [textBlock(`${messageId}-text`, prompt)],
          status: "complete",
          createdAt: timestamp(),
        },
      },
      session.id,
    );
    this.applyLocal("run.status", { status: "running" }, session.id);

    const reasoningId = `local-reasoning-${runId}`;
    this.applyLocal(
      "reasoning.started",
      {
        reasoning: {
          id: reasoningId,
          kind: "reasoning",
          messageId: `local-assistant-${runId}`,
          content: "",
          status: "streaming",
          createdAt: timestamp(),
        },
      },
      session.id,
    );

    this.addSimulationTimer(
      session.id,
      setTimeout(() => {
        this.applyLocal(
          "reasoning.delta",
          { reasoningId, delta: "Routing the prompt through the fixture-driven client boundary." },
          session.id,
        );
      }, 320),
    );

    const toolCallId = `fixture-${runId}`;
    this.addSimulationTimer(
      session.id,
      setTimeout(() => {
        this.applyLocal("reasoning.completed", { reasoningId }, session.id);
        this.applyLocal(
          "tool.started",
          {
            tool: {
              id: `tool-${toolCallId}`,
              kind: "tool",
              toolCallId,
              name: "fixture_runtime",
              summary: "Replay normalized Pi events",
              status: "running",
              arguments: { prompt },
              output: [],
              createdAt: timestamp(),
              startedAt: timestamp(),
              batchId: `local-assistant-${runId}`,
            },
          },
          session.id,
        );
      }, 700),
    );

    this.addSimulationTimer(
      session.id,
      setTimeout(() => {
        this.applyLocal(
          "tool.completed",
          {
            toolCallId,
            output: [textBlock(`${toolCallId}-result`, "Fixture event stream completed")],
            details: { mode: "fixture", durable: true },
            status: "completed",
          },
          session.id,
        );
        const assistantId = `local-assistant-${runId}`;
        this.applyLocal(
          "message.started",
          {
            message: {
              id: assistantId,
              kind: "message",
              role: "assistant",
              content: [],
              status: "streaming",
              modelId: session.modelId,
              createdAt: timestamp(),
            },
          },
          session.id,
        );
        this.applyLocal(
          "message.delta",
          {
            messageId: assistantId,
            blockId: `${assistantId}-text`,
            delta:
              "This response is running through the Phase 1 event reducer. Replace the fixture transport with Forge in Phase 2; the UI contract stays the same.",
            modelId: session.modelId,
          },
          session.id,
        );
      }, 1_080),
    );

    this.addSimulationTimer(
      session.id,
      setTimeout(() => {
        this.applyLocal(
          "message.completed",
          { messageId: `local-assistant-${runId}`, status: "complete" },
          session.id,
        );
        this.applyLocal("run.status", { status: "idle", outcome: "completed" }, session.id);
        this.simulationTimers.delete(session.id);
      }, 1_420),
    );
    return Promise.resolve(true);
  };

  uploadAttachment = async (_sessionId: string, file: File): Promise<ArtifactReference> => {
    const artifactId = crypto.randomUUID();
    return {
      type: "artifactReference",
      artifactId,
      url: `/api/v1/artifacts/${artifactId}`,
      mediaType: file.type || "application/octet-stream",
      byteLength: file.size,
      name: file.name,
    };
  };

  deleteAttachment = async () => undefined;

  searchFiles = async (_sessionId: string, query: string): Promise<WorkspaceFile[]> => [
    "AGENTS.md",
    "apps/web/src/components/Composer.tsx",
    "apps/forge/src/runtime/sessionManager.ts",
    "packages/protocol/src/index.ts",
  ].filter((path) => {
    let cursor = 0;
    const target = path.toLowerCase();
    return [...query.toLowerCase()].every((character) => {
      const index = target.indexOf(character, cursor);
      if (index < 0) return false;
      cursor = index + 1;
      return true;
    });
  }).map((path) => ({ path }));

  rebuildWebApp = async (): Promise<void> => {
    throw new Error("Web app rebuild is unavailable while replaying fixtures");
  };

  cancelActiveRun = () => {
    const session = this.activeSession();
    if (!session) return;
    this.simulationTimers.get(session.id)?.forEach(clearTimeout);
    this.simulationTimers.delete(session.id);

    const entries = this.snapshot.timelines[session.id] ?? [];
    for (const entry of entries) {
      if (entry.kind === "reasoning" && entry.status === "streaming") {
        this.applyLocal(
          "reasoning.completed",
          { reasoningId: entry.id, status: "cancelled" },
          session.id,
          false,
        );
      }
      if (entry.kind === "tool" && entry.status === "running") {
        this.applyLocal(
          "tool.completed",
          {
            toolCallId: entry.toolCallId,
            output: entry.output,
            details: entry.details,
            status: "cancelled",
          },
          session.id,
          false,
        );
      }
      if (entry.kind === "message" && entry.status === "streaming") {
        this.applyLocal(
          "message.completed",
          { messageId: entry.id, status: "cancelled", error: "Stopped by user" },
          session.id,
          false,
        );
      }
    }
    this.applyLocal("run.status", { status: "idle", outcome: "cancelled" }, session.id, false);
    this.applyLocal(
      "timeline.event",
      {
        entry: {
          id: `cancelled-${++this.localId}`,
          kind: "event",
          category: "lifecycle",
          tone: "warning",
          title: "Run stopped",
          message: "Cancelled by the user.",
          createdAt: timestamp(),
        },
      },
      session.id,
    );
  };

  setModel = (modelId: string) => {
    const session = this.activeSession();
    const model = session
      ? this.snapshot.catalogs[session.id]?.models.find((candidate) => candidate.id === modelId)
      : undefined;
    if (!session || !model) return;
    const thinkingLevel = model.supportedThinkingLevels.includes(session.thinkingLevel)
      ? session.thinkingLevel
      : model.supportedThinkingLevels[0] ?? "off";
    this.upsertLocalSession({ ...session, modelId, thinkingLevel, updatedAt: timestamp() });
  };

  setThinkingLevel = (thinkingLevel: ThinkingLevel) => {
    const session = this.activeSession();
    const model = session
      ? this.snapshot.catalogs[session.id]?.models.find(
          (candidate) => candidate.id === session.modelId,
        )
      : undefined;
    if (!session || !model?.supportedThinkingLevels.includes(thinkingLevel)) return;
    this.upsertLocalSession({ ...session, thinkingLevel, updatedAt: timestamp() });
  };

  respondToInteraction = (response: InteractionResponse) => {
    const request = this.snapshot.pendingInteractions.find(
      (candidate) => candidate.id === response.requestId,
    );
    if (!request) return;
    const status =
      request.method === "unknown" && !request.fields
        ? "unsupported"
        : response.cancelled
          ? "cancelled"
          : "answered";
    this.applyLocal(
      "interaction.resolved",
      { requestId: request.id, response, status },
      request.sessionId,
    );
  };

  isSessionPending = () => false;
  getSessionCreationError = () => undefined;

  markSessionRead = (sessionId: string) => {
    const sequence = this.snapshot.sessions.find((session) => session.id === sessionId)?.lastTerminalSequence;
    if (!sequence || (this.snapshot.readThroughSequences[sessionId] ?? 0) >= sequence) return;
    this.snapshot = {
      ...this.snapshot,
      readThroughSequences: { ...this.snapshot.readThroughSequences, [sessionId]: sequence },
    };
    this.emit();
  };

  clearComposerDraft = (sessionId: string) => {
    if (!this.snapshot.composerDrafts[sessionId]) return;
    this.snapshot = {
      ...this.snapshot,
      composerDrafts: { ...this.snapshot.composerDrafts, [sessionId]: "" },
    };
    this.emit();
  };

  cycleConnectionState = () => {
    const connection =
      this.snapshot.connection === "connected"
        ? "reconnecting"
        : this.snapshot.connection === "reconnecting"
          ? "offline"
          : "connected";
    this.applyLocal("connection.changed", { connection }, null);
  };

  selectReplayFixture = (fixtureId: string) => {
    const fixture = fixtureById.get(fixtureId);
    if (!fixture) return;
    this.pauseReplay();
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: fixture.session.id,
      replay: {
        ...this.snapshot.replay,
        fixtureId,
        cursor: fixture.records.length,
        total: fixture.records.length,
      },
    };
    this.emit();
  };

  toggleReplay = () => {
    if (this.snapshot.replay.playing) this.pauseReplay(true);
    else this.playReplay();
  };

  restartReplay = () => {
    const fixture = this.activeFixture();
    if (!fixture) return;
    this.pauseReplay();
    this.snapshot = {
      ...resetSessionState(this.snapshot, fixture.session.id),
      activeSessionId: fixture.session.id,
      readThroughSequences: this.snapshot.readThroughSequences,
      hydratingSessionIds: [],
      replay: {
        ...this.snapshot.replay,
        fixtureId: fixture.id,
        playing: true,
        cursor: 0,
        total: fixture.records.length,
      },
    };
    this.replayAdapter = createPiRpcAdapterState({
      fixtureId: fixture.id,
      sessionId: fixture.session.id,
      baseTimestamp: fixture.baseTimestamp,
    });
    this.emit();
    this.scheduleNextRecord();
  };

  instantReplay = () => {
    const fixture = this.activeFixture();
    if (!fixture) return;
    this.pauseReplay();
    const reset = resetSessionState(this.snapshot, fixture.session.id);
    const adapter = createPiRpcAdapterState({
      fixtureId: fixture.id,
      sessionId: fixture.session.id,
      baseTimestamp: fixture.baseTimestamp,
    });
    const rebuilt = applyAnvilEvents(
      reset,
      sequenceEvents(
        normalizeRecordedRpcItems(adapter, fixture.records),
        reset.lastSequence,
        fixture.id,
      ),
    );
    this.snapshot = {
      ...rebuilt,
      activeSessionId: fixture.session.id,
      readThroughSequences: this.snapshot.readThroughSequences,
      hydratingSessionIds: [],
      replay: {
        ...this.snapshot.replay,
        fixtureId: fixture.id,
        playing: false,
        cursor: fixture.records.length,
        total: fixture.records.length,
      },
    };
    this.replayAdapter = adapter;
    this.emit();
  };

  setReplaySpeed = (speed: number) => {
    if (![0.5, 1, 2, 4].includes(speed)) return;
    const wasPlaying = this.snapshot.replay.playing;
    this.pauseReplay();
    this.snapshot = { ...this.snapshot, replay: { ...this.snapshot.replay, speed } };
    this.emit();
    if (wasPlaying) this.playReplay();
  };

  private playReplay() {
    const fixture = this.activeFixture();
    if (!fixture) return;
    if (this.snapshot.replay.cursor >= fixture.records.length) {
      this.restartReplay();
      return;
    }
    if (!this.replayAdapter) {
      this.replayAdapter = createPiRpcAdapterState({
        fixtureId: fixture.id,
        sessionId: fixture.session.id,
        baseTimestamp: fixture.baseTimestamp,
      });
      for (const item of fixture.records.slice(0, this.snapshot.replay.cursor)) {
        normalizePiRpcRecord(this.replayAdapter, item.record, item.at);
      }
    }
    this.snapshot = {
      ...this.snapshot,
      replay: { ...this.snapshot.replay, playing: true },
    };
    this.emit();
    this.scheduleNextRecord();
  }

  private pauseReplay(emit = false) {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    if (!this.snapshot?.replay.playing) return;
    this.snapshot = {
      ...this.snapshot,
      replay: { ...this.snapshot.replay, playing: false },
    };
    if (emit) this.emit();
  }

  private scheduleNextRecord() {
    const fixture = this.activeFixture();
    if (!fixture || !this.snapshot.replay.playing || !this.replayAdapter) return;
    const cursor = this.snapshot.replay.cursor;
    const item = fixture.records[cursor];
    if (!item) {
      this.snapshot = {
        ...this.snapshot,
        replay: { ...this.snapshot.replay, playing: false },
      };
      this.emit();
      return;
    }
    const previousAt = cursor > 0 ? fixture.records[cursor - 1]?.at ?? 0 : 0;
    const delay = Math.max(20, (item.at - previousAt) / this.snapshot.replay.speed);
    this.replayTimer = setTimeout(() => {
      if (!this.replayAdapter) return;
      const base = applyAnvilEvents(
        this.snapshot,
        sequenceEvents(
          normalizePiRpcRecord(this.replayAdapter, item.record, item.at),
          this.snapshot.lastSequence,
          fixture.id,
        ),
      );
      const nextCursor = cursor + 1;
      this.snapshot = {
        ...base,
        readThroughSequences: this.snapshot.readThroughSequences,
        hydratingSessionIds: this.snapshot.hydratingSessionIds,
        replay: {
          ...this.snapshot.replay,
          cursor: nextCursor,
          playing: nextCursor < fixture.records.length,
        },
      };
      this.emit();
      if (nextCursor < fixture.records.length) this.scheduleNextRecord();
    }, delay);
  }

  private activeFixture(): FixtureDefinition | undefined {
    return fixtureById.get(this.snapshot.replay.fixtureId);
  }

  private activeSession(): SessionSummary | undefined {
    return this.snapshot.sessions.find(
      (session) => session.id === this.snapshot.activeSessionId,
    );
  }

  private upsertLocalSession(session: SessionSummary) {
    this.applyLocal("session.upserted", { session }, session.id);
  }

  private addSimulationTimer(sessionId: string, timer: ReturnType<typeof setTimeout>) {
    this.simulationTimers.set(sessionId, [
      ...(this.simulationTimers.get(sessionId) ?? []),
      timer,
    ]);
  }

  private applyLocal<T extends AnvilEvent["type"]>(
    type: T,
    payload: Extract<AnvilEvent, { type: T }>["payload"],
    sessionId: string | null,
    emit = true,
  ) {
    const sequence = this.snapshot.lastSequence + 1;
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: `local-${++this.localId}`,
      sequence,
      sessionId,
      timestamp: timestamp(),
      type,
      payload,
    } as AnvilEvent;
    const replay = this.snapshot.replay;
    this.snapshot = {
      ...applyAnvilEvent(this.snapshot, event),
      replay,
      readThroughSequences: this.snapshot.readThroughSequences,
      hydratingSessionIds: this.snapshot.hydratingSessionIds,
    };
    if (emit) this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export interface ForgeAnvilClientOptions {
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSource;
  autoConnect?: boolean;
}

export class ForgeAnvilClient implements AnvilClient {
  private snapshot: AnvilClientSnapshot = {
    ...createEmptySnapshot(),
    connection: "reconnecting",
    readThroughSequences: {},
    hydratingSessionIds: [],
    replay: { fixtureId: "live", playing: false, cursor: 0, total: 0, speed: 1 },
  };
  private readonly listeners = new Set<() => void>();
  private readonly fetcher: typeof fetch;
  private readonly createEventSource: (url: string) => EventSource;
  private stream?: EventSource;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1_000;
  private bootstrapPromise?: Promise<void>;
  private readonly pendingCreates = new Map<string, PendingSessionCreate>();
  private readonly pendingThinkingChanges = new Map<string, {
    confirmedLevel: ThinkingLevel;
    desiredLevel: ThinkingLevel;
    inFlightLevel?: ThinkingLevel;
  }>();
  private readonly cache = new ThreadCache();
  private readonly promptOutbox = new PromptOutbox({
    cache: this.cache,
    send: (command) => this.sendCommand(command),
    onRejected: (sessionId, prompt, response) => {
      const existingDraft = this.snapshot.composerDrafts[sessionId];
      this.snapshot = settleOptimisticPrompt(
        this.snapshot,
        sessionId,
        response.error ?? "Message could not be sent",
      );
      this.snapshot = {
        ...this.snapshot,
        composerDrafts: {
          ...this.snapshot.composerDrafts,
          [sessionId]: existingDraft ? `${existingDraft}\n\n${prompt.content}` : prompt.content,
        },
      };
      this.emit();
    },
  });
  private readonly hydratedThrough = new Map<string, number>();
  private readonly hydrationBuffers = new Map<string, AnvilEvent[]>();
  private readonly hydrationTokens = new Map<string, symbol>();
  private bootstrapGeneration = 0;
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly detailAccess = new Map<string, number>();
  private detailApiEnabled = false;

  constructor(options: ForgeAnvilClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url));
    if (options.autoConnect !== false) void this.bootstrap();
    if (typeof window !== "undefined") {
      window.addEventListener("offline", () => this.setConnection("offline"));
      window.addEventListener("online", () => void this.bootstrap());
    }
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch = (command: AnvilClientCommand) => {
    if (command.type === "session.select") {
      this.selectSession(command.payload.sessionId);
      return;
    }
    void this.sendCommand(command);
  };

  selectSession = (sessionId: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    this.snapshot = { ...this.snapshot, activeSessionId: sessionId };
    this.emit();
    if (this.detailApiEnabled) void this.hydrateSession(sessionId);
    this.touchDetail(sessionId);
    void this.persistShell();
  };

  createProject = async (name: string, path: string) => {
    const cleanName = name.trim();
    const cleanPath = path.trim();
    if (!cleanName || !cleanPath) return;
    await this.sendCommand(
      this.command("project.create", null, { name: cleanName, path: cleanPath }),
      true,
    );
  };

  createSession = (projectId: string) => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    const sessionId = crypto.randomUUID();
    let resolveSettled!: (created: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      resolveSettled = resolve;
    });
    const command = this.command("session.create", null, { projectId, sessionId }) as Extract<
      AnvilClientCommand,
      { type: "session.create" }
    >;
    const pending: PendingSessionCreate = {
      session: {
        id: sessionId,
        projectId,
        title: "New session",
        updatedAt: timestamp(),
        status: "idle" as const,
        modelId: "unknown",
        thinkingLevel: "off" as const,
        lastActivitySequence: this.snapshot.lastSequence + 1,
      },
      command,
      previousActiveSessionId: this.snapshot.activeSessionId,
      state: "creating",
      requestInFlight: false,
      settled,
      resolveSettled,
    };
    this.pendingCreates.set(sessionId, pending);
    this.snapshot = addOptimisticSession(this.snapshot, pending.session);
    this.emit();
    void this.sendCommand(command, false, pending);
  };

  setSessionSettled = async (sessionId: string, settled: boolean) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    await this.sendCommand(this.command("session.settled", sessionId, { settled }), true);
  };

  deleteSession = async (sessionId: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    const pending = this.pendingCreates.get(sessionId);
    if (pending?.state === "creating") {
      const created = await pending.settled;
      if (!created) {
        this.pendingCreates.delete(sessionId);
        this.snapshot = removeOptimisticSession(
          this.snapshot,
          sessionId,
          pending.previousActiveSessionId,
        );
        this.emit();
        return;
      }
    } else if (pending?.state === "failed") {
      this.pendingCreates.delete(sessionId);
      this.snapshot = removeOptimisticSession(
        this.snapshot,
        sessionId,
        pending.previousActiveSessionId,
      );
      this.emit();
      return;
    }
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    await this.sendCommand(this.command("session.delete", null, { sessionId }), true);
    if (this.pendingCreates.delete(sessionId)) {
      this.snapshot = { ...this.snapshot };
      this.emit();
    }
  };

  sendPrompt = (content: string, delivery: DeliveryMode = "prompt", attachments: ArtifactReference[] = []): Promise<boolean> => {
    const prompt = content.trim() || (attachments.length ? "Review the attached files." : "");
    const sessionId = this.snapshot.activeSessionId;
    if (!prompt || !sessionId) return Promise.resolve(false);
    const command = this.command("prompt.send", sessionId, {
      content: prompt,
      delivery,
      ...(attachments.length ? { attachments } : {}),
    }) as Extract<AnvilClientCommand, { type: "prompt.send" }>;
    this.snapshot = addOptimisticPrompt(promoteSession(this.snapshot, sessionId), sessionId, command.id, prompt);
    this.emit();

    const accepted = this.promptOutbox.enqueue({ command, content: prompt });
    const pending = this.pendingCreates.get(sessionId);
    if (pending?.state === "creating") return accepted;
    if (pending?.state === "failed") {
      this.restoreQueuedPrompt(sessionId);
      this.emit();
      return accepted;
    }
    this.promptOutbox.drain(sessionId);
    return accepted;
  };

  uploadAttachment = async (sessionId: string, file: File): Promise<ArtifactReference> => {
    const response = await this.fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-anvil-file-name": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
      const detail = typeof error?.message === "string" ? `: ${error.message}` : "";
      throw new Error(`Attachment upload failed with HTTP ${response.status}${detail}`);
    }
    return await response.json() as ArtifactReference;
  };

  deleteAttachment = async (sessionId: string, artifactId: string): Promise<void> => {
    const response = await this.fetcher(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(artifactId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Attachment deletion failed with HTTP ${response.status}`);
    }
  };

  rebuildWebApp = async (): Promise<void> => {
    const response = await this.fetcher("/api/v1/admin/rebuild", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const result = await response.json().catch(() => undefined) as { message?: string } | undefined;
    if (!response.ok) {
      throw new Error(result?.message ?? `Web app rebuild failed with HTTP ${response.status}`);
    }
  };

  searchFiles = async (sessionId: string, query: string): Promise<WorkspaceFile[]> => {
    const response = await this.fetcher(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/files?q=${encodeURIComponent(query)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) return [];
    const value = await response.json() as { files?: unknown };
    return Array.isArray(value.files)
      ? value.files.filter((item): item is WorkspaceFile => (
          Boolean(item) && typeof item === "object" && typeof (item as WorkspaceFile).path === "string"
        ))
      : [];
  };

  cancelActiveRun = () => {
    if (!this.snapshot.activeSessionId) return;
    void this.sendCommand(this.command("run.cancel", this.snapshot.activeSessionId, {}));
  };

  setModel = (modelId: string) => {
    if (!this.snapshot.activeSessionId) return;
    void this.sendCommand(this.command("model.set", this.snapshot.activeSessionId, { modelId }));
  };

  setThinkingLevel = (level: ThinkingLevel) => {
    const sessionId = this.snapshot.activeSessionId;
    if (!sessionId) return;
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.thinkingLevel === level) return;

    const pending = this.pendingThinkingChanges.get(sessionId) ?? {
      confirmedLevel: session.thinkingLevel,
      desiredLevel: level,
    };
    pending.desiredLevel = level;
    this.pendingThinkingChanges.set(sessionId, pending);

    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((candidate) => candidate.id === sessionId
        ? { ...candidate, thinkingLevel: level, updatedAt: timestamp() }
        : candidate),
    };
    this.emit();
    void this.flushThinkingLevel(sessionId);
  };

  private async flushThinkingLevel(sessionId: string): Promise<void> {
    const pending = this.pendingThinkingChanges.get(sessionId);
    if (!pending || pending.inFlightLevel) return;

    const requestedLevel = pending.desiredLevel;
    pending.inFlightLevel = requestedLevel;
    const response = await this.sendCommand(this.command("thinking.set", sessionId, { level: requestedLevel }));
    const tracked = this.pendingThinkingChanges.get(sessionId);
    if (tracked !== pending) return;

    pending.inFlightLevel = undefined;
    if (response?.success) pending.confirmedLevel = requestedLevel;
    if (pending.desiredLevel !== requestedLevel) {
      void this.flushThinkingLevel(sessionId);
      return;
    }

    this.pendingThinkingChanges.delete(sessionId);
    if (!response) {
      void this.bootstrap();
      return;
    }
    if (response.success) return;

    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((candidate) => candidate.id === sessionId
        ? { ...candidate, thinkingLevel: pending.confirmedLevel, updatedAt: timestamp() }
        : candidate),
    };
    this.emit();
  }

  respondToInteraction = (response: InteractionResponse) => {
    const request = this.snapshot.pendingInteractions.find((item) => item.id === response.requestId);
    if (!request) return;
    void this.sendCommand(this.command("interaction.respond", request.sessionId, response));
  };

  clearComposerDraft = (sessionId: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    this.snapshot = {
      ...this.snapshot,
      composerDrafts: { ...this.snapshot.composerDrafts, [sessionId]: "" },
    };
    this.emit();
  };

  isSessionPending = (sessionId: string) => this.pendingCreates.get(sessionId)?.state === "creating";

  getSessionCreationError = (sessionId: string) => {
    const pending = this.pendingCreates.get(sessionId);
    return pending?.state === "failed" ? pending.error : undefined;
  };

  markSessionRead = (sessionId: string) => {
    const sequence = this.snapshot.sessions.find((session) => session.id === sessionId)?.lastTerminalSequence;
    if (!sequence || (this.snapshot.readThroughSequences[sessionId] ?? 0) >= sequence) return;
    this.snapshot = {
      ...this.snapshot,
      readThroughSequences: { ...this.snapshot.readThroughSequences, [sessionId]: sequence },
    };
    this.emit();
    void this.cache.writeReadThrough(sessionId, sequence);
  };

  cycleConnectionState = () => undefined;
  selectReplayFixture = () => undefined;
  toggleReplay = () => undefined;
  restartReplay = () => undefined;
  instantReplay = () => undefined;
  setReplaySpeed = () => undefined;

  private restoreQueuedPrompt(sessionId: string): void {
    const content = this.promptOutbox.rejectSession(sessionId);
    if (!content) return;
    this.snapshot = {
      ...this.snapshot,
      composerDrafts: { ...this.snapshot.composerDrafts, [sessionId]: content },
    };
  }

  private bootstrap(): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.bootstrapPromise = this.loadBootstrap().finally(() => {
      this.bootstrapPromise = undefined;
    });
    return this.bootstrapPromise;
  }

  private async loadBootstrap(): Promise<void> {
    this.bootstrapGeneration++;
    this.detailApiEnabled = false;
    this.stream?.close();
    this.hydrationTokens.clear();
    this.hydrationBuffers.clear();
    this.snapshot = { ...this.snapshot, hydratingSessionIds: [] };
    this.setConnection("reconnecting");
    try {
      await this.restoreCachedShell();
      const response = await this.fetcher("/api/v1/bootstrap", {
        headers: { accept: "application/vnd.anvil.summary+json, application/json" },
      });
      if (!response.ok) throw new Error(`Forge bootstrap failed with HTTP ${response.status}`);
      const value: unknown = await response.json();
      await this.promptOutbox.restore();
      const previousActiveSessionId = this.snapshot.activeSessionId;
      const createsToRetry: PendingSessionCreate[] = [];
      let cursor: number;

      if (isAnvilBootstrap(value)) {
        this.detailApiEnabled = false;
        const restored = reconcileSnapshotAndTail(this.snapshot, value.snapshot, value.events);
        this.snapshot = {
          ...restored,
          readThroughSequences: this.snapshot.readThroughSequences,
          hydratingSessionIds: [],
          replay: this.snapshot.replay,
        };
        cursor = value.cursor;
        for (const session of restored.sessions) this.hydratedThrough.set(session.id, cursor);
      } else if (isAnvilSummaryBootstrap(value)) {
        this.detailApiEnabled = true;
        cursor = value.cursor;
        const sessionIds = new Set(value.sessions.map((session) => session.id));
        this.snapshot = {
          ...this.snapshot,
          protocolVersion: value.protocolVersion,
          capturedAt: value.capturedAt,
          connection: value.connection,
          projects: value.projects,
          sessions: sortSessionsByActivity(value.sessions),
          timelines: Object.fromEntries(Object.entries(this.snapshot.timelines).filter(([id]) => sessionIds.has(id))),
          catalogs: Object.fromEntries(Object.entries(this.snapshot.catalogs).filter(([id]) => sessionIds.has(id))),
          pendingInteractions: this.snapshot.pendingInteractions.filter((request) => sessionIds.has(request.sessionId)),
          extensionStatuses: this.snapshot.extensionStatuses.filter((status) => sessionIds.has(status.sessionId)),
          widgets: this.snapshot.widgets.filter((widget) => sessionIds.has(widget.sessionId)),
          queues: Object.fromEntries(Object.entries(this.snapshot.queues).filter(([id]) => sessionIds.has(id))),
          composerDrafts: Object.fromEntries(Object.entries(this.snapshot.composerDrafts).filter(([id]) => sessionIds.has(id))),
          runStates: Object.fromEntries(Object.entries(this.snapshot.runStates).filter(([id]) => sessionIds.has(id))),
          lastSequence: cursor,
          sequenceGap: null,
          hydratingSessionIds: [],
        };
      } else {
        throw new Error("Forge returned an invalid bootstrap payload");
      }

      let restored = this.snapshot;
      for (const [sessionId, pending] of this.pendingCreates) {
        if (restored.sessions.some((session) => session.id === sessionId)) {
          pending.state = "acknowledged";
          pending.requestInFlight = false;
          pending.resolveSettled(true);
          this.pendingCreates.delete(sessionId);
          this.promptOutbox.drain(sessionId);
        } else {
          restored = addOptimisticSession(restored, pending.session);
          if (pending.state === "creating" && !pending.requestInFlight) createsToRetry.push(pending);
        }
      }
      for (const prompt of this.promptOutbox.queued()) {
        if (prompt.command.sessionId) {
          restored = addOptimisticPrompt(restored, prompt.command.sessionId, prompt.command.id, prompt.content);
        }
      }
      const preferredSessionId = [previousActiveSessionId, restored.activeSessionId]
        .find((sessionId) => sessionId && restored.sessions.some((session) => session.id === sessionId)) ??
        restored.sessions[0]?.id ?? null;
      this.snapshot = {
        ...restored,
        activeSessionId: preferredSessionId,
        connection: "connected",
        clientError: undefined,
      };
      this.retryDelay = 1_000;
      this.emit();
      this.startStream(cursor);
      void this.loadReadState(this.snapshot.sessions.map((session) => ({
        sessionId: session.id,
        terminalSequenceAtBootstrap: session.lastTerminalSequence ?? 0,
      })));
      void this.persistShell();
      if (this.detailApiEnabled && preferredSessionId) void this.hydrateSession(preferredSessionId);
      for (const session of this.snapshot.sessions) {
        if (this.pendingCreates.get(session.id)?.state !== "creating") this.promptOutbox.drain(session.id);
      }
      for (const pending of createsToRetry) void this.sendCommand(pending.command, false, pending);
    } catch (error) {
      console.error(error);
      this.setConnection(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "reconnecting");
      this.retryTimer = setTimeout(() => void this.bootstrap(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    }
  }

  private async restoreCachedShell(): Promise<void> {
    if (this.snapshot.sessions.length > 0) return;
    const cached = await this.cache.readShell();
    if (!cached) return;
    const activeSessionId = cached.activeSessionId && cached.bootstrap.sessions.some(
      (session) => session.id === cached.activeSessionId,
    ) ? cached.activeSessionId : cached.bootstrap.sessions[0]?.id ?? null;
    this.snapshot = {
      ...this.snapshot,
      capturedAt: cached.bootstrap.capturedAt,
      projects: cached.bootstrap.projects,
      sessions: sortSessionsByActivity(cached.bootstrap.sessions),
      activeSessionId,
      connection: "reconnecting",
      lastSequence: 0,
    };
    if (activeSessionId) {
      const detail = await this.cache.readDetail(activeSessionId);
      if (detail) {
        this.snapshot = mergeSessionDetail(this.snapshot, detail);
        this.hydratedThrough.set(activeSessionId, detail.throughSequence);
        this.touchDetail(activeSessionId);
      }
    }
    this.emit();
  }

  private touchDetail(sessionId: string): void {
    this.detailAccess.delete(sessionId);
    this.detailAccess.set(sessionId, Date.now());
    this.evictDetails();
  }

  private evictDetails(): void {
    const now = Date.now();
    const candidates = [...this.detailAccess.entries()];
    for (const [sessionId, accessedAt] of candidates) {
      const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
      const protectedSession = sessionId === this.snapshot.activeSessionId ||
        session?.status === "running" || session?.status === "waiting" ||
        this.hydrationBuffers.has(sessionId);
      const overLimit = this.detailAccess.size > 8;
      const expired = now - accessedAt > 5 * 60_000;
      if (protectedSession || (!overLimit && !expired)) continue;
      const throughSequence = this.hydratedThrough.get(sessionId);
      if (throughSequence !== undefined && this.snapshot.runStates[sessionId] !== "running") {
        void this.cache.writeDetail(detailFromSnapshot(this.snapshot, sessionId, throughSequence));
      }
      this.snapshot = withoutSessionDetail(this.snapshot, sessionId);
      this.hydratedThrough.delete(sessionId);
      this.detailAccess.delete(sessionId);
    }
  }

  private async hydrateSession(sessionId: string): Promise<void> {
    if (!this.detailApiEnabled || this.hydrationTokens.has(sessionId)) return;
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;

    const generation = this.bootstrapGeneration;
    const token = Symbol(sessionId);
    const isCurrent = () => this.bootstrapGeneration === generation &&
      this.hydrationTokens.get(sessionId) === token;
    this.hydrationTokens.set(sessionId, token);
    this.hydrationBuffers.set(sessionId, []);
    this.snapshot = {
      ...this.snapshot,
      hydratingSessionIds: [...new Set([...this.snapshot.hydratingSessionIds, sessionId])],
    };
    this.emit();

    try {
      let baseline = this.hydratedThrough.get(sessionId);
      let cachedDetail: AnvilSessionDetail | undefined;
      if (baseline === undefined) {
        cachedDetail = await this.cache.readDetail(sessionId);
        if (!isCurrent()) return;
        if (cachedDetail && this.snapshot.sessions.some((candidate) => candidate.id === sessionId)) {
          baseline = cachedDetail.throughSequence;
          this.hydratedThrough.set(sessionId, baseline);
          this.snapshot = mergeSessionDetail(this.snapshot, cachedDetail);
          this.touchDetail(sessionId);
          this.emit();
        }
      } else {
        cachedDetail = detailFromSnapshot(this.snapshot, sessionId, baseline);
      }

      const suffix = baseline === undefined ? "" : `?after=${baseline}`;
      let response = await this.fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/detail${suffix}`, {
        headers: { accept: "application/json" },
      });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(`Forge detail failed with HTTP ${response.status}`);
      let value: unknown = await response.json();
      if (!isCurrent()) return;
      if (!isAnvilSessionDetailSync(value)) throw new Error("Forge returned an invalid session detail");

      if (value.mode === "delta" && !cachedDetail) {
        response = await this.fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/detail`, {
          headers: { accept: "application/json" },
        });
        if (!isCurrent()) return;
        if (!response.ok) throw new Error(`Forge detail reset failed with HTTP ${response.status}`);
        value = await response.json();
        if (!isCurrent()) return;
        if (!isAnvilSessionDetailSync(value) || value.mode !== "reset") {
          throw new Error("Forge did not return a full session detail");
        }
      }

      const currentSession = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
      if (!currentSession || !isCurrent()) return;
      let detail = value.mode === "reset"
        ? value.detail
        : applyDetailDelta(cachedDetail!, currentSession, value.events, value.throughSequence);
      const buffered = (this.hydrationBuffers.get(sessionId) ?? [])
        .filter((event) => event.sequence > detail.throughSequence);
      if (buffered.length > 0) {
        detail = applyDetailDelta(detail, currentSession, buffered, this.snapshot.lastSequence);
      } else {
        detail = { ...detail, throughSequence: Math.max(detail.throughSequence, this.snapshot.lastSequence) };
      }
      if (!isCurrent()) return;
      this.snapshot = mergeSessionDetail(this.snapshot, detail);
      this.hydratedThrough.set(sessionId, detail.throughSequence);
      this.touchDetail(sessionId);
      this.schedulePersist(sessionId);
    } catch (error) {
      if (!isCurrent()) return;
      console.error(error);
      this.snapshot = {
        ...this.snapshot,
        clientError: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (this.hydrationTokens.get(sessionId) !== token) return;
      this.hydrationTokens.delete(sessionId);
      this.hydrationBuffers.delete(sessionId);
      this.snapshot = {
        ...this.snapshot,
        hydratingSessionIds: this.snapshot.hydratingSessionIds.filter((id) => id !== sessionId),
      };
      this.emit();
    }
  }

  private async loadReadState(
    sessions: Array<{ sessionId: string; terminalSequenceAtBootstrap: number }>,
  ): Promise<void> {
    const entries = await Promise.all(sessions.map(async (session) => ({
      ...session,
      persistedSequence: await this.cache.readThrough(session.sessionId),
    })));
    const readThroughSequences = { ...this.snapshot.readThroughSequences };
    for (const { sessionId, terminalSequenceAtBootstrap, persistedSequence } of entries) {
      const sequence = persistedSequence ?? terminalSequenceAtBootstrap;
      if (sequence > (readThroughSequences[sessionId] ?? 0)) readThroughSequences[sessionId] = sequence;
      if (persistedSequence === undefined) void this.cache.writeReadThrough(sessionId, sequence);
    }
    this.snapshot = { ...this.snapshot, readThroughSequences };
    this.emit();
  }

  private async persistShell(): Promise<void> {
    await this.cache.writeShell(summaryBootstrapFromSnapshot(
      this.snapshot.capturedAt,
      this.snapshot.connection,
      this.snapshot.projects,
      this.snapshot.sessions,
      this.snapshot.lastSequence,
    ), this.snapshot.activeSessionId);
  }

  private schedulePersist(sessionId: string): void {
    const existing = this.persistTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.persistTimers.delete(sessionId);
      const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
      const throughSequence = this.hydratedThrough.get(sessionId);
      if (!session || throughSequence === undefined || this.snapshot.runStates[sessionId] === "running") return;
      void this.cache.writeDetail(detailFromSnapshot(this.snapshot, sessionId, throughSequence));
    }, 750);
    this.persistTimers.set(sessionId, timer);
  }

  private startStream(cursor: number): void {
    this.stream?.close();
    const stream = this.createEventSource(`/api/v1/events?after=${cursor}`);
    this.stream = stream;
    stream.onopen = () => this.setConnection("connected");
    stream.onerror = () => this.setConnection(
      typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "reconnecting",
    );
    stream.addEventListener("anvil", (message) => {
      try {
        const event = decodeAnvilEvent(JSON.parse((message as MessageEvent<string>).data));
        if (!event) throw new Error("Forge streamed an invalid event");
        const replay = this.snapshot.replay;
        const previousSnapshot = this.snapshot;
        if (event.sessionId && this.hydrationBuffers.has(event.sessionId)) {
          this.hydrationBuffers.get(event.sessionId)!.push(event);
        }
        const confirmedPrompt = event.type === "message.started" && event.payload.message.role === "user"
          ? event.payload.message.content.find((block) => block.type === "text")?.text
          : undefined;
        const snapshotForEvent = event.type === "message.started" && event.sessionId && event.payload.message.role === "user"
          ? settleOptimisticPrompt(this.snapshot, event.sessionId, undefined, confirmedPrompt)
          : this.snapshot;
        let next = applyAnvilEvent(snapshotForEvent, event);
        const detailWatermark = event.sessionId ? this.hydratedThrough.get(event.sessionId) : undefined;
        if (
          event.sessionId &&
          detailWatermark !== undefined &&
          event.sequence <= detailWatermark &&
          !this.hydrationBuffers.has(event.sessionId)
        ) {
          next = mergeSessionDetail(next, detailFromSnapshot(previousSnapshot, event.sessionId, detailWatermark));
        }
        const pendingThinking = event.sessionId
          ? this.pendingThinkingChanges.get(event.sessionId)
          : undefined;
        if (pendingThinking && event.type === "session.configured" && event.payload.thinkingLevel !== undefined) {
          next = {
            ...next,
            sessions: next.sessions.map((session) => session.id === event.sessionId
              ? { ...session, thinkingLevel: pendingThinking.desiredLevel }
              : session),
          };
        }
        const eventApplied = next.lastSequence === event.sequence;
        this.snapshot = {
          ...next,
          connection: "connected",
          replay,
          readThroughSequences: this.snapshot.readThroughSequences,
          hydratingSessionIds: this.snapshot.hydratingSessionIds,
        };
        if (
          eventApplied &&
          this.detailApiEnabled &&
          event.sessionId &&
          event.sessionId !== this.snapshot.activeSessionId &&
          !this.hydratedThrough.has(event.sessionId) &&
          !this.hydrationBuffers.has(event.sessionId)
        ) {
          this.snapshot = withoutSessionDetail(this.snapshot, event.sessionId);
        }
        if (eventApplied) {
          for (const sessionId of this.hydratedThrough.keys()) {
            if (!this.hydrationBuffers.has(sessionId)) {
              this.hydratedThrough.set(sessionId, Math.max(this.hydratedThrough.get(sessionId) ?? 0, event.sequence));
            }
          }
          if (event.type === "run.status" && event.sessionId && event.payload.outcome) {
            this.schedulePersist(event.sessionId);
          }
          if (event.type === "session.deleted") {
            this.hydratedThrough.delete(event.payload.sessionId);
            void this.cache.deleteSession(event.payload.sessionId);
          }
          if (["session.upserted", "session.deleted", "session.settled", "run.status", "message.started", "interaction.requested"].includes(event.type)) {
            void this.persistShell();
          }
        }
        if (eventApplied && event.type === "session.upserted") {
          const pending = this.pendingCreates.get(event.payload.session.id);
          if (pending) {
            pending.state = "acknowledged";
            pending.requestInFlight = false;
            pending.resolveSettled(true);
            this.pendingCreates.delete(event.payload.session.id);
            this.promptOutbox.drain(event.payload.session.id);
          }
        } else if (eventApplied && event.type === "session.deleted") {
          const pending = this.pendingCreates.get(event.payload.sessionId);
          pending?.resolveSettled(false);
          this.pendingCreates.delete(event.payload.sessionId);
        }
        this.emit();
        if (this.snapshot.sequenceGap) void this.bootstrap();
      } catch (error) {
        console.error(error);
        stream.close();
        void this.bootstrap();
      }
    });
    stream.addEventListener("reset", () => {
      stream.close();
      void this.bootstrap();
    });
  }

  private async sendCommand(
    command: AnvilClientCommand,
    throwOnError = false,
    pendingCreate?: PendingSessionCreate,
  ): Promise<AnvilCommandResponse | undefined> {
    let definitiveFailure = false;
    let receivedResponse: AnvilCommandResponse | undefined;
    if (pendingCreate) pendingCreate.requestInFlight = true;
    try {
      const response = await this.fetcher("/api/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(command),
      });
      const value = await response.json() as AnvilCommandResponse;
      receivedResponse = value;
      if (!response.ok || !value.success) {
        definitiveFailure = value.outcome === "completed";
        throw new Error(value.error ?? `Forge command failed with HTTP ${response.status}`);
      }
      if (this.snapshot.clientError) {
        this.snapshot = { ...this.snapshot, clientError: undefined };
        this.emit();
      }
      if (command.type === "session.create" && pendingCreate) {
        const sessionId = value.data && typeof value.data === "object" && !Array.isArray(value.data)
          ? (value.data as Record<string, JsonValue>).sessionId
          : undefined;
        if (sessionId !== pendingCreate.session.id) {
          definitiveFailure = true;
          throw new Error("Forge returned an unexpected session id");
        }
        const tracked = this.pendingCreates.get(pendingCreate.session.id);
        if (tracked) {
          tracked.state = "acknowledged";
          tracked.requestInFlight = false;
          tracked.resolveSettled(true);
          this.promptOutbox.drain(tracked.session.id);
          this.snapshot = { ...this.snapshot };
          this.emit();
        }
      }
      return value;
    } catch (error) {
      console.error(error);
      const failure = error instanceof Error ? error : new Error(String(error));
      const tracked = pendingCreate
        ? this.pendingCreates.get(pendingCreate.session.id)
        : undefined;
      if (tracked) {
        tracked.requestInFlight = false;
        if (definitiveFailure) {
          tracked.state = "failed";
          tracked.error = failure.message;
          tracked.resolveSettled(false);
          this.restoreQueuedPrompt(tracked.session.id);
          this.snapshot = {
            ...this.snapshot,
            sessions: this.snapshot.sessions.map((session) => session.id === tracked.session.id
              ? { ...session, status: "failed", updatedAt: timestamp() }
              : session),
          };
        } else {
          void this.bootstrap();
        }
      }
      this.snapshot = { ...this.snapshot, clientError: failure.message };
      this.emit();
      if (throwOnError) throw failure;
      return receivedResponse;
    }
  }

  private command<T extends AnvilClientCommand["type"]>(
    type: T,
    sessionId: string | null,
    payload: Extract<AnvilClientCommand, { type: T }>["payload"],
  ): AnvilClientCommand {
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      sessionId,
      timestamp: timestamp(),
      type,
      payload,
    } as AnvilClientCommand;
  }

  private setConnection(connection: AnvilSnapshot["connection"]): void {
    if (this.snapshot.connection === connection) return;
    this.snapshot = { ...this.snapshot, connection };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const useFixtureTransport = import.meta.env.VITE_ANVIL_TRANSPORT === "fixture" ||
  (import.meta.env.DEV && import.meta.env.VITE_ANVIL_TRANSPORT !== "forge");

export const anvilClient: AnvilClient = useFixtureTransport
  ? new FixtureAnvilClient()
  : new ForgeAnvilClient();

export type { AnvilSnapshot, JsonValue, TimelineEntry };
