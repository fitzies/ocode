import {
  ANVIL_PROTOCOL_VERSION,
  decodeAnvilEvent,
  DEFAULT_SESSION_TITLE,
  isAnvilBootstrap,
  isAnvilSessionDetailSync,
  isAnvilSummaryBootstrap,
  isGitHubRepositoryPage,
  isProjectDirectoryCatalog,
  isSubagentRun,
  isTerminalSubagentStatus,
  normalizeProjectSlug,
  normalizeSessionTitle,
  provisionalSessionTitleFromPrompt,
  SESSION_TITLE_MAX_LENGTH,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type AnvilSessionDetail,
  type AnvilSnapshot,
  type ArtifactReference,
  type GitHubRepositoryPage,
  type GitHubRepositorySummary,
  type InteractionResponse,
  type JsonValue,
  type ProjectDirectoryCatalog,
  type ProjectResourceContentBlock,
  type SessionSummary,
  type SubagentRun,
  type ThinkingLevel,
  type ThreadSearchMatch,
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
import {
  locationForSession,
  reconcileWorkspaceLocation,
  type WorkspaceLocation,
} from "./workspace";
import { fixtureById, fixtureCatalog, fixtures, type FixtureDefinition } from "../fixtures";

export type DeliveryMode = "prompt" | "steer" | "followUp";
export type ProjectCreateResult =
  | { status: "created" }
  | { status: "existing"; path: string };

export interface WorkspaceFile {
  path: string;
}

export type LiveProjectResourceCompletion = {
  sessionId: string;
  sequence: number;
  toolCallId: string;
  blocks: ProjectResourceContentBlock[];
};

export interface ReplayStatus {
  fixtureId: string;
  playing: boolean;
  cursor: number;
  total: number;
  speed: number;
}

export interface AnvilClientSnapshot extends AnvilSnapshot {
  workspaceLocation: WorkspaceLocation | null;
  replay: ReplayStatus;
  clientError?: string;
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
  subscribeProjectResourceCompletions(listener: (completion: LiveProjectResourceCompletion) => void): () => void;
  dispatch(command: AnvilClientCommand): void;
  selectProject(projectId: string): void;
  selectSession(sessionId: string): void;
  loadSubagentSession(parentSessionId: string, runId: string): Promise<string>;
  openSubagentSession(parentSessionId: string, runId: string): Promise<void>;
  cancelSubagent(parentSessionId: string, runId: string): Promise<void>;
  createProject(name: string): Promise<ProjectCreateResult>;
  cloneProject(name: string, repository: string): Promise<void>;
  addExistingProject(name: string, path: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  listGitHubRepositories(page?: number, query?: string): Promise<GitHubRepositoryPage>;
  listProjectDirectories(): Promise<ProjectDirectoryCatalog>;
  getProjectsRoot(): Promise<string>;
  setProjectsRoot(path: string): Promise<string>;
  createSession(projectId: string): void;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionSettled(sessionId: string, settled: boolean): Promise<void>;
  sendPrompt(content: string, mode?: DeliveryMode, attachments?: ArtifactReference[]): Promise<boolean>;
  uploadAttachment(sessionId: string, file: File): Promise<ArtifactReference>;
  deleteAttachment(sessionId: string, artifactId: string): Promise<void>;
  searchFiles(sessionId: string, query: string): Promise<WorkspaceFile[]>;
  searchThreads(query: string): Promise<ThreadSearchMatch[]>;
  rebuildWebApp(): Promise<void>;
  cancelActiveRun(): void;
  setModel(sessionId: string, modelId: string): void;
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void;
  respondToInteraction(response: InteractionResponse): void;
  clearClientError(): void;
  clearComposerDraft(sessionId: string): void;
  isSessionPending(sessionId: string): boolean;
  getSessionCreationError(sessionId: string): string | undefined;
  markSessionRead(sessionId: string): void;
  markSessionUnread(sessionId: string): void;
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
const fixtureGitHubRepositories: GitHubRepositorySummary[] = [
  {
    nameWithOwner: "ocode-labs/forge-console",
    name: "forge-console",
    owner: "ocode-labs",
    private: true,
    updatedAt: "2026-07-22T18:30:00Z",
  },
  {
    nameWithOwner: "collaborator/design-system",
    name: "design-system",
    owner: "collaborator",
    private: false,
    updatedAt: "2026-07-20T09:15:00Z",
  },
  {
    nameWithOwner: "octocat/Hello-World",
    name: "Hello-World",
    owner: "octocat",
    private: false,
    updatedAt: "2026-07-12T12:00:00Z",
  },
];

function reconcileClientWorkspace(snapshot: AnvilClientSnapshot): AnvilClientSnapshot {
  const workspaceLocation = reconcileWorkspaceLocation(
    snapshot.workspaceLocation ?? undefined,
    snapshot.projects,
    snapshot.sessions,
    snapshot.activeSessionId,
  );
  const activeSessionId = workspaceLocation?.sessionId ?? null;
  return workspaceLocation === snapshot.workspaceLocation && activeSessionId === snapshot.activeSessionId
    ? snapshot
    : { ...snapshot, workspaceLocation, activeSessionId };
}

function timestamp() {
  return new Date().toISOString();
}

function promoteSession(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  sentAt = timestamp(),
): AnvilClientSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return snapshot;
  return {
    ...snapshot,
    sessions: sortSessionsByActivity([
      {
        ...session,
        updatedAt: sentAt,
        lastUserMessageAt: sentAt,
        lastUserMessageSequence: Math.max(session.lastUserMessageSequence ?? 0, snapshot.lastSequence + 1),
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

function withProvisionalSessionTitle(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  content: string,
  delivery: DeliveryMode,
): AnvilClientSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  const alreadyPrompted = Boolean(session?.lastUserMessageAt || session?.lastUserMessageSequence) ||
    (snapshot.timelines[sessionId] ?? []).some(
      (entry) => entry.kind === "message" && entry.role === "user" && entry.origin?.type !== "subagentCompletion" && entry.status !== "failed",
    );
  if (delivery !== "prompt" || session?.title !== DEFAULT_SESSION_TITLE || alreadyPrompted) return snapshot;
  const title = provisionalSessionTitleFromPrompt(content);
  if (!title) return snapshot;
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((candidate) => (
      candidate.id === sessionId ? { ...candidate, title } : candidate
    )),
  };
}

function addOptimisticPrompt(
  snapshot: AnvilClientSnapshot,
  sessionId: string,
  commandId: string,
  content: string,
  createdAt = timestamp(),
  delivery: DeliveryMode = "prompt",
): AnvilClientSnapshot {
  const id = optimisticMessageId(commandId);
  if ((snapshot.timelines[sessionId] ?? []).some((entry) => entry.id === id)) return snapshot;
  const next = withProvisionalSessionTitle(snapshot, sessionId, content, delivery);
  return {
    ...next,
    timelines: {
      ...next.timelines,
      [sessionId]: [
        ...(next.timelines[sessionId] ?? []),
        {
          id,
          kind: "message",
          role: "user",
          content: [{ id: `${id}-text`, type: "text", text: content }],
          status: "streaming",
          createdAt,
          raw: { delivery },
        },
      ],
    },
  };
}

const EXPANDED_SKILL_PROMPT = /^<skill name="([^"]+)" location="[^"]+">\r?\n[\s\S]*?\r?\n<\/skill>(?:[\t ]*\r?\n){0,2}([\s\S]*)$/;
const COMPACT_SKILL_PROMPT = /^\/skill:([^\s]+)(?:[\t\n\r ]+([\s\S]*))?$/;

export function promptConfirmsOptimistic(expectedContent: string, optimisticContent: string): boolean {
  if (expectedContent.startsWith(optimisticContent)) return true;
  const expanded = EXPANDED_SKILL_PROMPT.exec(expectedContent);
  const compact = COMPACT_SKILL_PROMPT.exec(optimisticContent);
  return Boolean(
    expanded &&
    compact &&
    expanded[1] === compact[1] &&
    (expanded[2] ?? "").trim() === (compact[2] ?? "").trim(),
  );
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
    (expectedContent === undefined || entry.content.some((block) => block.type === "text" && promptConfirmsOptimistic(expectedContent, block.text))),
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
    subagentRuns: withoutSessionKey(snapshot.subagentRuns, sessionId),
  };
}

function subagentSessionStatus(run: SubagentRun): SessionSummary["status"] {
  if (run.status === "failed" || run.status === "interrupted") return "failed";
  if (run.status === "needs_attention") return "waiting";
  if (["queued", "starting", "running"].includes(run.status)) return "running";
  return "idle";
}

function replaceSubagentRun<TSnapshot extends AnvilSnapshot>(snapshot: TSnapshot, run: SubagentRun): TSnapshot {
  const runs = snapshot.subagentRuns[run.parentSessionId] ?? [];
  return {
    ...snapshot,
    subagentRuns: {
      ...snapshot.subagentRuns,
      [run.parentSessionId]: runs.some((candidate) => candidate.id === run.id)
        ? runs.map((candidate) => candidate.id === run.id ? run : candidate)
        : [...runs, run],
    },
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
    subagentRuns: { ...snapshot.subagentRuns, [detail.sessionId]: detail.subagentRuns },
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
    subagentRuns: withoutSessionKey(snapshot.subagentRuns, sessionId),
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
    subagentRuns: snapshot.subagentRuns[sessionId] ?? [],
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
  private projectsRoot = "/home/forge/code";
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
      base = {
        ...base,
        subagentRuns: { ...base.subagentRuns, [fixture.session.id]: fixture.subagentRuns ?? [] },
      };
    }

    const initialFixture = fixtures[0]!;
    this.snapshot = {
      ...base,
      sessions: base.sessions.map((session) => ({
        ...session,
        readThroughSequence: session.readThroughSequence ?? session.lastTerminalSequence ?? 0,
      })),
      workspaceLocation: initialFixture.session ? locationForSession(initialFixture.session) : null,
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

  subscribeProjectResourceCompletions = (_listener: (completion: LiveProjectResourceCompletion) => void) => () => undefined;

  dispatch = (command: AnvilClientCommand) => {
    switch (command.type) {
      case "project.create":
        this.createProject(command.payload.name);
        break;
      case "project.clone":
        this.cloneProject(command.payload.name, command.payload.repository);
        break;
      case "project.addExisting":
        this.addExistingProject(command.payload.name, command.payload.path);
        break;
      case "project.delete":
        this.deleteProject(command.payload.projectId);
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
      case "session.rename":
        if (command.sessionId) this.renameSession(command.sessionId, command.payload.title);
        break;
      case "session.settled":
        if (command.sessionId) this.setSessionSettled(command.sessionId, command.payload.settled);
        break;
      case "session.markRead":
        if (command.sessionId) this.markSessionRead(command.sessionId);
        break;
      case "session.markUnread":
        if (command.sessionId) this.markSessionUnread(command.sessionId);
        break;
      case "prompt.send":
        this.sendPrompt(command.payload.content, command.payload.delivery, command.payload.attachments);
        break;
      case "run.cancel":
        this.cancelActiveRun();
        break;
      case "model.set":
        if (command.sessionId) this.setModel(command.sessionId, command.payload.modelId);
        break;
      case "thinking.set":
        if (command.sessionId) this.setThinkingLevel(command.sessionId, command.payload.level);
        break;
      case "interaction.respond":
        this.respondToInteraction(command.payload);
        break;
      case "subagent.cancel":
        if (command.sessionId) void this.cancelSubagent(command.sessionId, command.payload.runId);
        break;
    }
  };

  selectProject = (projectId: string) => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    this.pauseReplay();
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: { projectId, sessionId: null },
      activeSessionId: null,
    };
    this.emit();
  };

  selectSession = (sessionId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    this.pauseReplay();
    const fixture = fixtureById.get(sessionId);
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: locationForSession(session),
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

  loadSubagentSession = async (parentSessionId: string, runId: string): Promise<string> => {
    const parent = this.snapshot.sessions.find((session) => session.id === parentSessionId && !session.internal);
    const run = this.snapshot.subagentRuns[parentSessionId]?.find((candidate) => candidate.id === runId);
    if (!parent || !run) throw new Error("Subagent run is no longer available");
    const child: SessionSummary = {
      id: run.childSessionId,
      projectId: parent.projectId,
      title: `${run.role} · ${run.taskPreview}`.slice(0, SESSION_TITLE_MAX_LENGTH),
      updatedAt: run.updatedAt,
      status: subagentSessionStatus(run),
      modelId: parent.modelId,
      thinkingLevel: parent.thinkingLevel,
      internal: true,
      parentSessionId,
    };
    const timeline: TimelineEntry[] = [
      {
        id: `${run.id}:task`, kind: "message", role: "user", status: "complete", createdAt: run.createdAt,
        content: [{ id: `${run.id}:task:text`, type: "text", text: run.taskPreview }],
      },
      ...((run.resultPreview || run.error) ? [{
        id: `${run.id}:preview`, kind: "message" as const, role: "assistant" as const,
        status: run.error ? "failed" as const : "complete" as const,
        createdAt: run.endedAt ?? run.updatedAt,
        content: [{ id: `${run.id}:preview:text`, type: "text" as const, text: run.error ?? run.resultPreview! }],
        ...(run.error ? { error: run.error } : {}),
      }] : []),
    ];
    const sessions = this.snapshot.sessions.some((session) => session.id === child.id)
      ? this.snapshot.sessions.map((session) => session.id === child.id ? child : session)
      : [...this.snapshot.sessions, child];
    this.snapshot = {
      ...this.snapshot,
      sessions,
      timelines: { ...this.snapshot.timelines, [child.id]: timeline },
      catalogs: { ...this.snapshot.catalogs, [child.id]: fixtureCatalog },
      queues: { ...this.snapshot.queues, [child.id]: { steering: [], followUp: [] } },
      composerDrafts: { ...this.snapshot.composerDrafts, [child.id]: "" },
      runStates: { ...this.snapshot.runStates, [child.id]: child.status === "running" ? "running" : "idle" },
      subagentRuns: { ...this.snapshot.subagentRuns, [child.id]: [] },
    };
    this.emit();
    return child.id;
  };

  openSubagentSession = async (parentSessionId: string, runId: string): Promise<void> => {
    const childSessionId = await this.loadSubagentSession(parentSessionId, runId);
    this.selectSession(childSessionId);
  };

  cancelSubagent = async (parentSessionId: string, runId: string): Promise<void> => {
    const run = this.snapshot.subagentRuns[parentSessionId]?.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Subagent run is no longer available");
    if (isTerminalSubagentStatus(run.status)) return;
    const endedAt = timestamp();
    this.applyLocal("subagent.updated", {
      run: { ...run, status: "cancelled", updatedAt: endedAt, endedAt },
    }, parentSessionId);
  };

  createProject = async (name: string): Promise<ProjectCreateResult> => {
    const cleanName = name.trim();
    const slug = normalizeProjectSlug(cleanName);
    if (!cleanName || !slug) throw new Error("Enter a project name that can form a directory name");
    const project = {
      id: `project-${Date.now()}`,
      name: cleanName,
      path: `${this.projectsRoot.replace(/\/$/, "")}/${slug}`,
    };
    this.applyLocal("project.upserted", { project }, null);
    return { status: "created" };
  };

  cloneProject = async (name: string, _repository: string): Promise<void> => {
    await this.createProject(name);
  };

  addExistingProject = async (name: string, _path: string): Promise<void> => {
    await this.createProject(name);
  };

  deleteProject = async (projectId: string): Promise<void> => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    const sessionIds = this.snapshot.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id);
    for (const sessionId of sessionIds) {
      for (const timer of this.simulationTimers.get(sessionId) ?? []) clearTimeout(timer);
      this.simulationTimers.delete(sessionId);
    }
    this.applyLocal("project.deleted", { projectId }, null);
  };

  listGitHubRepositories = async (page = 1, query = ""): Promise<GitHubRepositoryPage> => {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("GitHub repository page must be a positive integer");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? fixtureGitHubRepositories.filter((repository) => repository.nameWithOwner.toLocaleLowerCase().includes(normalizedQuery))
      : fixtureGitHubRepositories;
    const pageSize = 10;
    const start = (page - 1) * pageSize;
    return {
      repositories: matches.slice(start, start + pageSize).map((repository) => ({ ...repository })),
      page,
      hasMore: start + pageSize < matches.length,
    };
  };

  listProjectDirectories = async (): Promise<ProjectDirectoryCatalog> => ({ directories: [
    { name: "new-workspace", path: `${this.projectsRoot}/new-workspace` },
    { name: "sample-app", path: `${this.projectsRoot}/sample-app` },
  ] });

  getProjectsRoot = async (): Promise<string> => this.projectsRoot;

  setProjectsRoot = async (path: string): Promise<string> => {
    const cleanPath = path.trim().replace(/\/$/, "") || "/";
    if (!cleanPath.startsWith("/")) throw new Error("Projects root must be an absolute path");
    this.projectsRoot = cleanPath;
    return cleanPath;
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
      readThroughSequence: 0,
    };
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: locationForSession(session),
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

  renameSession = async (sessionId: string, value: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    const title = normalizeSessionTitle(value);
    if (!title) throw new Error(`Thread title must be non-empty and at most ${SESSION_TITLE_MAX_LENGTH} characters`);
    this.applyLocal("session.configured", { title }, sessionId);
  };

  setSessionSettled = async (sessionId: string, settled: boolean) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    this.applyLocal("session.settled", { settled }, sessionId);
  };

  sendPrompt = (content: string, mode: DeliveryMode = "prompt", attachments: ArtifactReference[] = []): Promise<boolean> => {
    const prompt = content.trim() || (attachments.length ? "Review the attached files." : "");
    const session = this.activeSession();
    if (!prompt || !session) return Promise.resolve(false);

    this.snapshot = withProvisionalSessionTitle(this.snapshot, session.id, prompt, mode);
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

  searchThreads = async (query: string): Promise<ThreadSearchMatch[]> => {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length < 2) return [];
    return this.snapshot.sessions.flatMap((session) => {
      if (session.internal) return [];
      const match = (this.snapshot.timelines[session.id] ?? []).find((entry) =>
        entry.kind === "message" &&
        entry.status === "complete" &&
        (entry.role === "assistant" || (entry.role === "user" && entry.origin === undefined)) &&
        entry.content.some((block) => block.type === "text" && block.text.toLocaleLowerCase().includes(normalized))
      );
      if (!match || match.kind !== "message" || (match.role !== "user" && match.role !== "assistant")) return [];
      const text = match.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(" ");
      return [{ sessionId: session.id, role: match.role, snippet: text.slice(0, 240), messageCreatedAt: match.createdAt }];
    });
  };

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

  setModel = (sessionId: string, modelId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const model = this.snapshot.catalogs[sessionId]?.models.find((candidate) => candidate.id === modelId);
    if (!session || !model || session.modelId === modelId) return;
    const thinkingLevel = model.supportedThinkingLevels.includes(session.thinkingLevel)
      ? session.thinkingLevel
      : model.supportedThinkingLevels[0] ?? "off";
    this.upsertLocalSession({ ...session, modelId, thinkingLevel, updatedAt: timestamp() });
  };

  setThinkingLevel = (sessionId: string, thinkingLevel: ThinkingLevel) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const model = this.snapshot.catalogs[sessionId]?.models.find(
      (candidate) => candidate.id === session?.modelId,
    );
    if (!session || session.thinkingLevel === thinkingLevel || !model?.supportedThinkingLevels.includes(thinkingLevel)) return;
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

  clearClientError = () => {
    if (!this.snapshot.clientError) return;
    this.snapshot = { ...this.snapshot, clientError: undefined };
    this.emit();
  };

  markSessionRead = (sessionId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.lastTerminalSequence || (session.readThroughSequence ?? 0) >= session.lastTerminalSequence) return;
    this.applyLocal("session.readState", { readThroughSequence: session.lastTerminalSequence }, sessionId);
  };

  markSessionUnread = (sessionId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.lastTerminalSequence) return;
    const readThroughSequence = Math.max(0, session.lastTerminalSequence - 1);
    if ((session.readThroughSequence ?? 0) === readThroughSequence) return;
    this.applyLocal("session.readState", { readThroughSequence }, sessionId);
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
      workspaceLocation: locationForSession(fixture.session),
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
      subagentRuns: {
        ...this.snapshot.subagentRuns,
        [fixture.session.id]: fixture.subagentRuns ?? [],
      },
      workspaceLocation: locationForSession(fixture.session),
      activeSessionId: fixture.session.id,
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
      {
        ...reset,
        subagentRuns: { ...reset.subagentRuns, [fixture.session.id]: fixture.subagentRuns ?? [] },
      },
      sequenceEvents(
        normalizeRecordedRpcItems(adapter, fixture.records),
        reset.lastSequence,
        fixture.id,
      ),
    );
    this.snapshot = {
      ...rebuilt,
      workspaceLocation: locationForSession(fixture.session),
      activeSessionId: fixture.session.id,
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
        workspaceLocation: this.snapshot.workspaceLocation,
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
      workspaceLocation: this.snapshot.workspaceLocation,
      replay,
      hydratingSessionIds: this.snapshot.hydratingSessionIds,
    };
    if (emit) this.emit();
  }

  private emit() {
    this.snapshot = reconcileClientWorkspace(this.snapshot);
    this.listeners.forEach((listener) => listener());
  }
}

export interface ForgeAnvilClientOptions {
  fetch?: typeof fetch;
  createEventSource?: (url: string) => EventSource;
  autoConnect?: boolean;
  internalDetailPollMs?: number;
}

export class ForgeAnvilClient implements AnvilClient {
  private snapshot: AnvilClientSnapshot = {
    ...createEmptySnapshot(),
    workspaceLocation: null,
    connection: "reconnecting",
    hydratingSessionIds: [],
    replay: { fixtureId: "live", playing: false, cursor: 0, total: 0, speed: 1 },
  };
  private readonly listeners = new Set<() => void>();
  private readonly projectResourceListeners = new Set<(completion: LiveProjectResourceCompletion) => void>();
  private readonly fetcher: typeof fetch;
  private readonly createEventSource: (url: string) => EventSource;
  private readonly internalDetailPollMs: number;
  private stream?: EventSource;
  private internalDetailPollTimer?: ReturnType<typeof setTimeout>;
  private internalDetailPollController?: AbortController;
  private internalDetailPollSessionId?: string;
  private internalDetailFinalSessionId?: string;
  private watchedSubagentSessionId?: string;
  private internalDetailPollInFlight = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1_000;
  private bootstrapPromise?: Promise<void>;
  private readonly pendingCreates = new Map<string, PendingSessionCreate>();
  private readonly provisionalSessionTitles = new Map<string, string>();
  private readonly rejectedProvisionalSessionTitles = new Map<string, string>();
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
      const provisionalTitle = this.provisionalSessionTitles.get(sessionId);
      if (provisionalTitle) {
        this.snapshot = {
          ...this.snapshot,
          sessions: this.snapshot.sessions.map((session) => (
            session.id === sessionId && session.title === provisionalTitle
              ? { ...session, title: DEFAULT_SESSION_TITLE }
              : session
          )),
        };
        this.provisionalSessionTitles.delete(sessionId);
        this.rejectedProvisionalSessionTitles.set(sessionId, provisionalTitle);
      }
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
    this.internalDetailPollMs = options.internalDetailPollMs ?? 1_000;
    if (options.autoConnect !== false) void this.bootstrap();
    if (typeof window !== "undefined") {
      window.addEventListener("offline", () => this.setConnection("offline"));
      window.addEventListener("online", () => void this.bootstrap());
    }
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.syncInternalDetailPolling();
    return () => {
      this.listeners.delete(listener);
      this.syncInternalDetailPolling();
    };
  };

  subscribeProjectResourceCompletions = (listener: (completion: LiveProjectResourceCompletion) => void) => {
    this.projectResourceListeners.add(listener);
    return () => this.projectResourceListeners.delete(listener);
  };

  dispatch = (command: AnvilClientCommand) => {
    if (command.type === "session.select") {
      this.selectSession(command.payload.sessionId);
      return;
    }
    void this.sendCommand(command);
  };

  selectProject = (projectId: string) => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: { projectId, sessionId: null },
      activeSessionId: null,
    };
    this.emit();
    void this.persistShell();
  };

  selectSession = (sessionId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: locationForSession(session),
      activeSessionId: sessionId,
    };
    this.emit();
    if (this.detailApiEnabled) void this.hydrateSession(sessionId);
    this.touchDetail(sessionId);
    void this.persistShell();
  };

  loadSubagentSession = async (parentSessionId: string, runId: string): Promise<string> => {
    const parent = this.snapshot.sessions.find((session) => session.id === parentSessionId && !session.internal);
    const run = this.snapshot.subagentRuns[parentSessionId]?.find((candidate) => candidate.id === runId);
    if (!parent || !run) throw new Error("Subagent run is no longer available");

    const response = await this.fetcher(`/api/v1/sessions/${encodeURIComponent(run.childSessionId)}/detail`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Forge detail failed with HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isAnvilSessionDetailSync(value) || value.mode !== "reset" || value.detail.sessionId !== run.childSessionId) {
      throw new Error("Forge returned an invalid child session detail");
    }

    const child: SessionSummary = {
      id: run.childSessionId,
      projectId: parent.projectId,
      title: `${run.role} · ${run.taskPreview}`.slice(0, SESSION_TITLE_MAX_LENGTH),
      updatedAt: run.updatedAt,
      status: subagentSessionStatus(run),
      modelId: parent.modelId,
      thinkingLevel: parent.thinkingLevel,
      internal: true,
      parentSessionId,
    };
    const sessions = this.snapshot.sessions.some((session) => session.id === child.id)
      ? this.snapshot.sessions.map((session) => session.id === child.id ? child : session)
      : [...this.snapshot.sessions, child];
    this.snapshot = mergeSessionDetail({ ...this.snapshot, sessions }, value.detail);
    this.hydratedThrough.set(child.id, value.detail.throughSequence);
    this.watchedSubagentSessionId = child.id;
    this.touchDetail(child.id);
    this.emit();
    return child.id;
  };

  openSubagentSession = async (parentSessionId: string, runId: string): Promise<void> => {
    const childSessionId = await this.loadSubagentSession(parentSessionId, runId);
    this.watchedSubagentSessionId = undefined;
    const child = this.snapshot.sessions.find((session) => session.id === childSessionId);
    if (!child) throw new Error("Subagent child session is no longer available");
    this.snapshot = {
      ...this.snapshot,
      workspaceLocation: locationForSession(child),
      activeSessionId: child.id,
    };
    this.touchDetail(child.id);
    this.emit();
    void this.persistShell();
  };

  cancelSubagent = async (parentSessionId: string, runId: string): Promise<void> => {
    const run = this.snapshot.subagentRuns[parentSessionId]?.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Subagent run is no longer available");
    if (isTerminalSubagentStatus(run.status)) return;
    const response = await this.sendCommand(this.command("subagent.cancel", parentSessionId, { runId }), true);
    if (
      isSubagentRun(response?.data) &&
      response.data.id === runId &&
      response.data.parentSessionId === parentSessionId
    ) {
      this.snapshot = replaceSubagentRun(this.snapshot, response.data);
      this.emit();
    }
  };

  createProject = async (name: string): Promise<ProjectCreateResult> => {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Project name is required");
    const response = await this.sendCommand(
      this.command("project.create", null, { name: cleanName }),
      true,
    );
    const status = response?.data && typeof response.data === "object" && !Array.isArray(response.data)
      ? (response.data as Record<string, JsonValue>).status
      : undefined;
    const path = response?.data && typeof response.data === "object" && !Array.isArray(response.data)
      ? (response.data as Record<string, JsonValue>).path
      : undefined;
    return status === "existing" && typeof path === "string"
      ? { status: "existing", path }
      : { status: "created" };
  };

  cloneProject = async (name: string, repository: string): Promise<void> => {
    const cleanName = name.trim();
    const cleanRepository = repository.trim();
    if (!cleanName) throw new Error("Project name is required");
    if (!cleanRepository) throw new Error("GitHub repository is required");
    await this.sendCommand(
      this.command("project.clone", null, { name: cleanName, repository: cleanRepository }),
      true,
    );
  };

  addExistingProject = async (name: string, path: string): Promise<void> => {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Project name is required");
    await this.sendCommand(
      this.command("project.addExisting", null, { name: cleanName, path }),
      true,
    );
  };

  deleteProject = async (projectId: string): Promise<void> => {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) return;
    await this.sendCommand(this.command("project.delete", null, { projectId }), true);
  };

  listGitHubRepositories = async (page = 1, query = ""): Promise<GitHubRepositoryPage> => {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("GitHub repository page must be a positive integer");
    const params = new URLSearchParams({ page: String(page) });
    if (query.trim()) params.set("q", query.trim());
    const response = await this.fetcher(`/api/v1/github/repositories?${params}`, {
      headers: { accept: "application/json" },
    });
    const result = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>).message
        : undefined;
      throw new Error(
        typeof message === "string"
          ? message
          : `GitHub repository request failed with HTTP ${response.status}`,
      );
    }
    if (!isGitHubRepositoryPage(result) || result.page !== page) {
      throw new Error("Forge returned an invalid GitHub repository page");
    }
    return result;
  };

  listProjectDirectories = async (): Promise<ProjectDirectoryCatalog> => {
    const response = await this.fetcher("/api/v1/projects/directories", {
      headers: { accept: "application/json" },
    });
    const result = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>).message
        : undefined;
      throw new Error(typeof message === "string" ? message : `Project directory request failed with HTTP ${response.status}`);
    }
    if (!isProjectDirectoryCatalog(result)) throw new Error("Forge returned an invalid project directory list");
    return result;
  };

  getProjectsRoot = async (): Promise<string> => {
    const response = await this.fetcher("/api/v1/settings/projects-root", {
      headers: { accept: "application/json" },
    });
    const result = await response.json().catch(() => undefined) as { path?: unknown; message?: unknown } | undefined;
    if (!response.ok || typeof result?.path !== "string") {
      throw new Error(typeof result?.message === "string" ? result.message : `Projects root request failed with HTTP ${response.status}`);
    }
    return result.path;
  };

  setProjectsRoot = async (path: string): Promise<string> => {
    const response = await this.fetcher("/api/v1/settings/projects-root", {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ path: path.trim() }),
    });
    const result = await response.json().catch(() => undefined) as { path?: unknown; message?: unknown } | undefined;
    if (!response.ok || typeof result?.path !== "string") {
      throw new Error(typeof result?.message === "string" ? result.message : `Projects root update failed with HTTP ${response.status}`);
    }
    return result.path;
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
        readThroughSequence: 0,
      },
      command,
      previousActiveSessionId: this.snapshot.activeSessionId,
      state: "creating",
      requestInFlight: false,
      settled,
      resolveSettled,
    };
    this.pendingCreates.set(sessionId, pending);
    this.snapshot = {
      ...addOptimisticSession(this.snapshot, pending.session),
      workspaceLocation: locationForSession(pending.session),
    };
    this.emit();
    void this.sendCommand(command, false, pending);
  };

  renameSession = async (sessionId: string, value: string) => {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return;
    const title = normalizeSessionTitle(value);
    if (!title) throw new Error(`Thread title must be non-empty and at most ${SESSION_TITLE_MAX_LENGTH} characters`);
    await this.sendCommand(this.command("session.rename", sessionId, { title }), true);
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
    const previousTitle = this.snapshot.sessions.find((session) => session.id === sessionId)?.title;
    this.snapshot = addOptimisticPrompt(
      this.snapshot,
      sessionId,
      command.id,
      prompt,
      command.timestamp,
      delivery,
    );
    const optimisticTitle = this.snapshot.sessions.find((session) => session.id === sessionId)?.title;
    if (previousTitle === DEFAULT_SESSION_TITLE && optimisticTitle && optimisticTitle !== previousTitle) {
      this.provisionalSessionTitles.set(sessionId, optimisticTitle);
    }
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

  searchThreads = async (query: string): Promise<ThreadSearchMatch[]> => {
    const response = await this.fetcher(`/api/v1/threads/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const value = await response.json() as { matches?: unknown };
    return Array.isArray(value.matches)
      ? value.matches.filter((item): item is ThreadSearchMatch => {
          if (!item || typeof item !== "object") return false;
          const match = item as Partial<ThreadSearchMatch>;
          return typeof match.sessionId === "string" &&
            (match.role === "user" || match.role === "assistant") &&
            typeof match.snippet === "string" &&
            typeof match.messageCreatedAt === "string";
        })
      : [];
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

  setModel = (sessionId: string, modelId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const available = this.snapshot.catalogs[sessionId]?.models.some((model) => model.id === modelId);
    if (!session || !available || session.modelId === modelId) return;
    void this.sendCommand(this.command("model.set", sessionId, { modelId }));
  };

  setThinkingLevel = (sessionId: string, level: ThinkingLevel) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const model = this.snapshot.catalogs[sessionId]?.models.find(
      (candidate) => candidate.id === session?.modelId,
    );
    if (!session || session.thinkingLevel === level || !model?.supportedThinkingLevels.includes(level)) return;

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

  clearClientError = () => {
    if (!this.snapshot.clientError) return;
    this.snapshot = { ...this.snapshot, clientError: undefined };
    this.emit();
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
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.lastTerminalSequence || (session.readThroughSequence ?? 0) >= session.lastTerminalSequence) return;
    void this.sendCommand(this.command("session.markRead", sessionId, {
      throughSequence: session.lastTerminalSequence,
    }));
  };

  markSessionUnread = (sessionId: string) => {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.lastTerminalSequence || (session.readThroughSequence ?? 0) < session.lastTerminalSequence) return;
    void this.sendCommand(this.command("session.markUnread", sessionId, {}));
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
      const previousWorkspaceLocation = this.snapshot.workspaceLocation;
      const createsToRetry: PendingSessionCreate[] = [];
      let cursor: number;

      if (isAnvilBootstrap(value)) {
        this.detailApiEnabled = false;
        const restored = reconcileSnapshotAndTail(this.snapshot, value.snapshot, value.events);
        this.snapshot = {
          ...restored,
          workspaceLocation: previousWorkspaceLocation,
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
      this.provisionalSessionTitles.clear();
      this.rejectedProvisionalSessionTitles.clear();
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
          const sessionId = prompt.command.sessionId;
          const previousTitle = restored.sessions.find((session) => session.id === sessionId)?.title;
          restored = addOptimisticPrompt(
            restored,
            sessionId,
            prompt.command.id,
            prompt.content,
            prompt.command.timestamp,
            prompt.command.payload.delivery,
          );
          const optimisticTitle = restored.sessions.find((session) => session.id === sessionId)?.title;
          if (previousTitle === DEFAULT_SESSION_TITLE && optimisticTitle && optimisticTitle !== previousTitle) {
            this.provisionalSessionTitles.set(sessionId, optimisticTitle);
          }
        }
      }
      const preferredSessionId = [previousActiveSessionId, restored.activeSessionId]
        .find((sessionId) => sessionId && restored.sessions.some((session) => session.id === sessionId)) ??
        restored.sessions[0]?.id ?? null;
      const workspaceLocation = reconcileWorkspaceLocation(
        previousWorkspaceLocation ?? undefined,
        restored.projects,
        restored.sessions,
        preferredSessionId,
      );
      this.snapshot = {
        ...restored,
        workspaceLocation,
        activeSessionId: workspaceLocation?.sessionId ?? null,
        connection: "connected",
        clientError: undefined,
      };
      this.retryDelay = 1_000;
      this.emit();
      this.startStream(cursor);
      void this.persistShell();
      if (this.detailApiEnabled && workspaceLocation?.sessionId) void this.hydrateSession(workspaceLocation.sessionId);
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
    const sessions = sortSessionsByActivity(cached.bootstrap.sessions);
    const workspaceLocation = reconcileWorkspaceLocation(
      cached.workspaceLocation ?? undefined,
      cached.bootstrap.projects,
      sessions,
      activeSessionId,
    );
    this.snapshot = {
      ...this.snapshot,
      capturedAt: cached.bootstrap.capturedAt,
      projects: cached.bootstrap.projects,
      sessions,
      workspaceLocation,
      activeSessionId: workspaceLocation?.sessionId ?? null,
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

  private currentInternalSessionId(): string | undefined {
    if (this.listeners.size === 0 || !this.detailApiEnabled || this.snapshot.connection !== "connected") return undefined;
    const active = this.snapshot.sessions.find((candidate) => (
      candidate.id === this.snapshot.activeSessionId && candidate.internal && candidate.parentSessionId
    ));
    if (active?.parentSessionId) return active.id;
    const watched = this.snapshot.sessions.find((candidate) => (
      candidate.id === this.watchedSubagentSessionId &&
      candidate.internal &&
      candidate.parentSessionId === this.snapshot.workspaceLocation?.sessionId
    ));
    return watched?.id;
  }

  private liveInternalSessionId(): string | undefined {
    const sessionId = this.currentInternalSessionId();
    if (!sessionId) return undefined;
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.parentSessionId) return undefined;
    const run = this.snapshot.subagentRuns[session.parentSessionId]?.find(
      (candidate) => candidate.childSessionId === sessionId,
    );
    return run && !isTerminalSubagentStatus(run.status) ? sessionId : undefined;
  }

  private canSyncInternalDetail(sessionId: string, finalSync: boolean): boolean {
    return finalSync
      ? this.internalDetailFinalSessionId === sessionId && this.currentInternalSessionId() === sessionId
      : this.liveInternalSessionId() === sessionId;
  }

  private syncInternalDetailPolling(): void {
    let finalSessionId = this.internalDetailFinalSessionId;
    if (finalSessionId && this.currentInternalSessionId() !== finalSessionId) {
      this.internalDetailFinalSessionId = undefined;
      finalSessionId = undefined;
    }
    const sessionId = finalSessionId ?? this.liveInternalSessionId();
    if (sessionId !== this.internalDetailPollSessionId) {
      if (this.internalDetailPollTimer) clearTimeout(this.internalDetailPollTimer);
      this.internalDetailPollTimer = undefined;
      this.internalDetailPollController?.abort();
      this.internalDetailPollController = undefined;
      this.internalDetailPollSessionId = sessionId;
    }
    if (finalSessionId && this.internalDetailPollTimer) {
      clearTimeout(this.internalDetailPollTimer);
      this.internalDetailPollTimer = undefined;
    }
    if (!sessionId || this.internalDetailPollTimer || this.internalDetailPollInFlight) return;
    if (finalSessionId) {
      void this.pollInternalSessionDetail(sessionId, true);
      return;
    }
    this.internalDetailPollTimer = setTimeout(() => {
      this.internalDetailPollTimer = undefined;
      void this.pollInternalSessionDetail(sessionId, false);
    }, this.internalDetailPollMs);
  }

  private async pollInternalSessionDetail(sessionId: string, finalSync: boolean): Promise<void> {
    if (!this.canSyncInternalDetail(sessionId, finalSync) || this.internalDetailPollInFlight) return;
    this.internalDetailPollInFlight = true;
    const controller = new AbortController();
    this.internalDetailPollController = controller;
    try {
      const baseline = this.hydratedThrough.get(sessionId);
      const suffix = baseline === undefined ? "" : `?after=${baseline}`;
      const response = await this.fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/detail${suffix}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (controller.signal.aborted || !this.canSyncInternalDetail(sessionId, finalSync)) return;
      if (!response.ok) throw new Error(`Forge child detail failed with HTTP ${response.status}`);
      const value: unknown = await response.json();
      if (controller.signal.aborted || !this.canSyncInternalDetail(sessionId, finalSync)) return;
      if (!isAnvilSessionDetailSync(value) || (
        value.mode === "reset" ? value.detail.sessionId !== sessionId : value.sessionId !== sessionId
      )) {
        throw new Error("Forge returned an invalid live child session detail");
      }
      const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;
      const previous = baseline === undefined ? undefined : detailFromSnapshot(this.snapshot, sessionId, baseline);
      if (value.mode === "delta" && !previous) throw new Error("Forge returned a child detail delta without a baseline");
      let detail = value.mode === "reset"
        ? value.detail
        : applyDetailDelta(previous!, session, value.events, value.throughSequence);
      if (value.mode === "delta" && value.subagentRuns) {
        detail = { ...detail, subagentRuns: value.subagentRuns };
      }
      this.snapshot = mergeSessionDetail(this.snapshot, detail);
      this.hydratedThrough.set(sessionId, detail.throughSequence);
      this.touchDetail(sessionId);
      this.emit();
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
    } finally {
      if (this.internalDetailPollController === controller) this.internalDetailPollController = undefined;
      if (finalSync && this.internalDetailFinalSessionId === sessionId) this.internalDetailFinalSessionId = undefined;
      this.internalDetailPollInFlight = false;
      this.syncInternalDetailPolling();
    }
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
      if (value.mode === "delta" && value.subagentRuns) {
        detail = { ...detail, subagentRuns: value.subagentRuns };
      }
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

  private async persistShell(): Promise<void> {
    const sessions = this.snapshot.sessions.filter((session) => !session.internal);
    const activeSessionId = sessions.some((session) => session.id === this.snapshot.activeSessionId)
      ? this.snapshot.activeSessionId
      : null;
    const workspaceLocation = this.snapshot.workspaceLocation && sessions.some(
      (session) => session.id === this.snapshot.workspaceLocation?.sessionId,
    )
      ? this.snapshot.workspaceLocation
      : this.snapshot.workspaceLocation
        ? { projectId: this.snapshot.workspaceLocation.projectId, sessionId: null }
        : null;
    await this.cache.writeShell(summaryBootstrapFromSnapshot(
      this.snapshot.capturedAt,
      this.snapshot.connection,
      this.snapshot.projects,
      sessions,
      this.snapshot.lastSequence,
    ), activeSessionId, workspaceLocation);
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
        const projectDeletedSessionIds = event.type === "project.deleted"
          ? previousSnapshot.sessions
            .filter((session) => session.projectId === event.payload.projectId)
            .map((session) => session.id)
          : [];
        if (event.sessionId && this.hydrationBuffers.has(event.sessionId)) {
          this.hydrationBuffers.get(event.sessionId)!.push(event);
        }
        const humanPrompt = event.type === "message.started" &&
          event.payload.message.role === "user" &&
          event.payload.message.origin?.type !== "subagentCompletion";
        const confirmedPrompt = humanPrompt
          ? event.payload.message.content.find((block) => block.type === "text")?.text
          : undefined;
        const snapshotForEvent = humanPrompt && event.sessionId
          ? settleOptimisticPrompt(this.snapshot, event.sessionId, undefined, confirmedPrompt)
          : this.snapshot;
        let next = applyAnvilEvent(snapshotForEvent, event);
        const provisionalTitle = event.sessionId
          ? this.provisionalSessionTitles.get(event.sessionId)
          : undefined;
        if (
          provisionalTitle &&
          event.type === "session.upserted" &&
          event.payload.session.title === DEFAULT_SESSION_TITLE
        ) {
          next = {
            ...next,
            sessions: next.sessions.map((session) => (
              session.id === event.sessionId ? { ...session, title: provisionalTitle } : session
            )),
          };
        }
        const rejectedProvisionalTitle = event.sessionId
          ? this.rejectedProvisionalSessionTitles.get(event.sessionId)
          : undefined;
        if (
          rejectedProvisionalTitle &&
          event.type === "session.configured" &&
          event.payload.titleSource === "provisional" &&
          event.payload.title === rejectedProvisionalTitle
        ) {
          next = {
            ...next,
            sessions: next.sessions.map((session) => (
              session.id === event.sessionId ? { ...session, title: DEFAULT_SESSION_TITLE } : session
            )),
          };
        }
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
        let finalInternalSessionId: string | undefined;
        if (eventApplied && event.type === "subagent.updated") {
          const run = event.payload.run;
          const internalSession = previousSnapshot.sessions.find((session) => (
            session.id === run.childSessionId && session.internal && session.parentSessionId === run.parentSessionId
          ));
          if (internalSession) {
            next = {
              ...next,
              sessions: next.sessions.map((session) => session.id === run.childSessionId
                ? { ...session, status: subagentSessionStatus(run), updatedAt: run.updatedAt }
                : session),
            };
            const previousRun = previousSnapshot.subagentRuns[run.parentSessionId]?.find(
              (candidate) => candidate.id === run.id,
            );
            if (
              previousSnapshot.activeSessionId === run.childSessionId &&
              previousRun &&
              !isTerminalSubagentStatus(previousRun.status) &&
              isTerminalSubagentStatus(run.status)
            ) {
              finalInternalSessionId = run.childSessionId;
            }
          }
        }
        const serverSelectedSession = eventApplied &&
          event.type === "session.selected" &&
          event.sessionId === this.snapshot.activeSessionId
          ? next.sessions.find((session) => session.id === event.payload.sessionId)
          : undefined;
        this.snapshot = {
          ...next,
          workspaceLocation: serverSelectedSession
            ? locationForSession(serverSelectedSession)
            : this.snapshot.workspaceLocation,
          connection: "connected",
          replay,
          hydratingSessionIds: this.snapshot.hydratingSessionIds,
        };
        if (finalInternalSessionId) this.internalDetailFinalSessionId = finalInternalSessionId;
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
            const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
            if (!session?.internal && !this.hydrationBuffers.has(sessionId)) {
              this.hydratedThrough.set(sessionId, Math.max(this.hydratedThrough.get(sessionId) ?? 0, event.sequence));
            }
          }
          if (event.type === "run.status" && event.sessionId && event.payload.outcome) {
            this.schedulePersist(event.sessionId);
          }
          if (event.type === "session.deleted") {
            this.hydratedThrough.delete(event.payload.sessionId);
            this.provisionalSessionTitles.delete(event.payload.sessionId);
            this.rejectedProvisionalSessionTitles.delete(event.payload.sessionId);
            void this.cache.deleteSession(event.payload.sessionId);
          }
          if (event.type === "session.prompted" && event.sessionId) {
            this.provisionalSessionTitles.delete(event.sessionId);
          }
          if (
            event.type === "session.configured" &&
            event.sessionId &&
            event.payload.title !== undefined &&
            event.payload.titleSource !== "provisional"
          ) {
            this.provisionalSessionTitles.delete(event.sessionId);
            this.rejectedProvisionalSessionTitles.delete(event.sessionId);
          }
          if (
            event.type === "session.upserted" &&
            event.payload.session.title === DEFAULT_SESSION_TITLE &&
            this.rejectedProvisionalSessionTitles.has(event.payload.session.id)
          ) {
            this.rejectedProvisionalSessionTitles.delete(event.payload.session.id);
          }
          if (event.type === "project.deleted") {
            for (const sessionId of projectDeletedSessionIds) {
              this.hydratedThrough.delete(sessionId);
              this.hydrationBuffers.delete(sessionId);
              this.hydrationTokens.delete(sessionId);
              this.pendingThinkingChanges.delete(sessionId);
              this.provisionalSessionTitles.delete(sessionId);
              this.rejectedProvisionalSessionTitles.delete(sessionId);
              this.detailAccess.delete(sessionId);
              this.promptOutbox.rejectSession(sessionId);
              const timer = this.persistTimers.get(sessionId);
              if (timer) clearTimeout(timer);
              this.persistTimers.delete(sessionId);
              const pending = this.pendingCreates.get(sessionId);
              pending?.resolveSettled(false);
              this.pendingCreates.delete(sessionId);
              void this.cache.deleteSession(sessionId);
            }
            const removedIds = new Set(projectDeletedSessionIds);
            this.snapshot = {
              ...this.snapshot,
              hydratingSessionIds: this.snapshot.hydratingSessionIds.filter((id) => !removedIds.has(id)),
            };
          }
          if (["project.deleted", "session.upserted", "session.deleted", "session.settled", "session.prompted", "session.configured", "run.status", "message.started", "interaction.requested"].includes(event.type)) {
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
        if (
          eventApplied &&
          event.sequence > previousSnapshot.lastSequence &&
          event.type === "tool.completed" &&
          event.payload.status === "completed" &&
          event.sessionId
        ) {
          const blocks = event.payload.output.filter(
            (block): block is ProjectResourceContentBlock => block.type === "projectResource",
          );
          if (blocks.length) {
            const completion = {
              sessionId: event.sessionId,
              sequence: event.sequence,
              toolCallId: event.payload.toolCallId,
              blocks,
            };
            for (const listener of this.projectResourceListeners) listener(completion);
          }
        }
        this.emit();
        if (serverSelectedSession) {
          if (this.detailApiEnabled) void this.hydrateSession(serverSelectedSession.id);
          this.touchDetail(serverSelectedSession.id);
          void this.persistShell();
        }
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
    this.snapshot = reconcileClientWorkspace(this.snapshot);
    this.syncInternalDetailPolling();
    this.listeners.forEach((listener) => listener());
  }
}

const configuredTransport = import.meta.env.VITE_OCODE_TRANSPORT ?? import.meta.env.VITE_ANVIL_TRANSPORT;
const useFixtureTransport = configuredTransport === "fixture" ||
  (import.meta.env.DEV && configuredTransport !== "forge");

export const anvilClient: AnvilClient = useFixtureTransport
  ? new FixtureAnvilClient()
  : new ForgeAnvilClient();

export type { AnvilSnapshot, JsonValue, TimelineEntry };
