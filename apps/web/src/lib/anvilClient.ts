import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilClientCommand,
  type AnvilEvent,
  type AnvilSnapshot,
  type InteractionResponse,
  type JsonValue,
  type SessionSummary,
  type ThinkingLevel,
  type TimelineEntry,
} from "@anvil/protocol";

import { fixtureById, fixtureCatalog, fixtures, type FixtureDefinition } from "../fixtures";
import {
  createPiRpcAdapterState,
  normalizePiRpcRecord,
  normalizeRecordedRpcItems,
  type PiRpcAdapterState,
} from "./piRpcAdapter";
import {
  applyAnvilEvent,
  applyAnvilEvents,
  createEmptySnapshot,
  resetSessionState,
} from "./anvilState";

export type DeliveryMode = "prompt" | "steer" | "followUp";

export interface ReplayStatus {
  fixtureId: string;
  playing: boolean;
  cursor: number;
  total: number;
  speed: number;
}

export interface AnvilClientSnapshot extends AnvilSnapshot {
  replay: ReplayStatus;
}

export interface AnvilClient {
  getSnapshot(): AnvilClientSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(command: AnvilClientCommand): void;
  selectSession(sessionId: string): void;
  createSession(): void;
  sendPrompt(content: string, mode?: DeliveryMode): void;
  cancelActiveRun(): void;
  setModel(modelId: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  respondToInteraction(response: InteractionResponse): void;
  clearComposerDraft(): void;
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

function textBlock(id: string, text: string) {
  return { id, type: "text" as const, text };
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
      catalog: fixtureCatalog,
      activeSessionId: fixtures[0]?.session.id ?? null,
      capturedAt: fixtures[0]?.baseTimestamp,
    });

    for (const fixture of fixtures) {
      const adapter = createPiRpcAdapterState({
        fixtureId: fixture.id,
        sessionId: fixture.session.id,
        baseTimestamp: fixture.baseTimestamp,
      });
      base = applyAnvilEvents(base, normalizeRecordedRpcItems(adapter, fixture.records));
    }

    const initialFixture = fixtures[0]!;
    this.snapshot = {
      ...base,
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
      case "session.select":
        this.selectSession(command.payload.sessionId);
        break;
      case "session.create":
        this.createSession();
        break;
      case "prompt.send":
        this.sendPrompt(command.payload.content, command.payload.delivery);
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

  createSession = () => {
    this.pauseReplay();
    const id = `session-${Date.now()}`;
    const activeSession = this.activeSession();
    const model = this.snapshot.catalog.models[0];
    const session: SessionSummary = {
      id,
      projectId: activeSession?.projectId ?? this.snapshot.projects[0]?.id ?? "anvil",
      title: "New session",
      updatedAt: timestamp(),
      status: "idle",
      modelId: model?.id ?? "unknown",
      thinkingLevel: model?.supportedThinkingLevels.includes("high") ? "high" : "off",
      branch: "main",
    };
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: id,
      sessions: [session, ...this.snapshot.sessions],
      timelines: { ...this.snapshot.timelines, [id]: [] },
      queues: { ...this.snapshot.queues, [id]: { steering: [], followUp: [] } },
      runStates: { ...this.snapshot.runStates, [id]: "idle" },
    };
    this.emit();
  };

  sendPrompt = (content: string, mode: DeliveryMode = "prompt") => {
    const prompt = content.trim();
    const session = this.activeSession();
    if (!prompt || !session) return;

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
      return;
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
        this.applyLocal("run.status", { status: "idle" }, session.id);
        this.simulationTimers.delete(session.id);
      }, 1_420),
    );
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
    this.applyLocal("run.status", { status: "idle" }, session.id, false);
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
    const model = this.snapshot.catalog.models.find((candidate) => candidate.id === modelId);
    if (!session || !model) return;
    const thinkingLevel = model.supportedThinkingLevels.includes(session.thinkingLevel)
      ? session.thinkingLevel
      : model.supportedThinkingLevels[0] ?? "off";
    this.upsertLocalSession({ ...session, modelId, thinkingLevel, updatedAt: timestamp() });
  };

  setThinkingLevel = (thinkingLevel: ThinkingLevel) => {
    const session = this.activeSession();
    const model = this.snapshot.catalog.models.find(
      (candidate) => candidate.id === session?.modelId,
    );
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

  clearComposerDraft = () => {
    const sessionId = this.snapshot.activeSessionId;
    if (!sessionId || !this.snapshot.composerDrafts[sessionId]) return;
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
    const rebuilt = applyAnvilEvents(reset, normalizeRecordedRpcItems(adapter, fixture.records));
    this.snapshot = {
      ...rebuilt,
      activeSessionId: fixture.session.id,
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
        normalizePiRpcRecord(this.replayAdapter, item.record, item.at),
      );
      const nextCursor = cursor + 1;
      this.snapshot = {
        ...base,
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
    const key = sessionId ?? "__global__";
    const sequence = (this.snapshot.lastSequenceBySession[key] ?? 0) + 1;
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
    this.snapshot = { ...applyAnvilEvent(this.snapshot, event), replay };
    if (emit) this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const anvilClient = new FixtureAnvilClient();

export type { AnvilSnapshot, JsonValue, TimelineEntry };
