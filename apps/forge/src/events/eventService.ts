import { EventEmitter } from "node:events";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilBootstrap,
  type AnvilEvent,
  type ArtifactReference,
  type AnvilSessionDetail,
  type AnvilSessionDetailSync,
  type AnvilSnapshot,
  type AnvilSummaryBootstrap,
  type ProjectSummary,
  type SessionSummary,
  type ThreadSearchMatch,
} from "@anvil/protocol";
import { applyAnvilEvents, createEmptySnapshot, restoreLegacyUserActivity } from "@anvil/state";

import { ArtifactStore } from "../artifacts/artifactStore.ts";
import { detectProjectWorkspaceKind } from "../projects/workspaceKind.ts";
import { ForgeDatabase } from "../store/database.ts";
import { subagentCompletionOrigin } from "../subagents/completionMessage.ts";

function restoreSubagentMessageOrigins(snapshot: AnvilSnapshot, database: ForgeDatabase): AnvilSnapshot {
  const timelines = Object.fromEntries(Object.entries(snapshot.timelines).map(([sessionId, entries]) => {
    const runs = database.subagents.list(sessionId);
    if (runs.length === 0) return [sessionId, entries];
    return [sessionId, entries.map((entry) => {
      if (entry.kind !== "message" || entry.origin) return entry;
      const origin = subagentCompletionOrigin(sessionId, entry, runs);
      return origin ? { ...entry, origin } : entry;
    })];
  }));
  return { ...snapshot, timelines };
}

export class ForgeEventService extends EventEmitter {
  private snapshot: AnvilSnapshot;
  private readonly internalSessionIds = new Set<string>();
  private eventsSinceSnapshot = 0;
  private generalProjectId?: string;

  constructor(
    private readonly database: ForgeDatabase,
    projects: ProjectSummary[],
    private readonly artifacts?: ArtifactStore,
    private readonly snapshotInterval = 250,
  ) {
    super();
    database.seedConfigProjectsOnce(projects);
    const persistedProjects = database.listProjects().map((project) => ({
      ...project,
      workspaceKind: detectProjectWorkspaceKind(project.path),
    }));
    const stored = database.latestSnapshot();
    const compactedThrough = database.compactedThrough();
    if (compactedThrough > 0 && (!stored || stored.cursor < compactedThrough)) {
      const available = stored ? `latest compatible snapshot is at sequence ${stored.cursor}` : "no compatible snapshot is available";
      throw new Error(
        `Cannot restore compacted event journal through sequence ${compactedThrough}: ${available}`,
      );
    }
    let restored = stored?.snapshot ?? createEmptySnapshot({ projects: persistedProjects });
    while (true) {
      const tail = database.readEventsAfter(restored.lastSequence, 10_000);
      if (tail.length === 0) break;
      restored = applyAnvilEvents(restored, tail);
      if (tail.length < 10_000) break;
    }
    restored = restoreSubagentMessageOrigins(restored, database);
    restored = restoreLegacyUserActivity(restored);
    restored = {
      ...restored,
      sessions: restored.sessions.map((session) => ({
        ...session,
        readThroughSequence: database.getSession(session.id)?.session.readThroughSequence ??
          session.readThroughSequence ??
          0,
      })),
    };
    this.snapshot = {
      ...restored,
      connection: "connected",
      projects: persistedProjects,
      sequenceGap: null,
    };
    for (const session of this.snapshot.sessions) {
      if (session.internal) this.internalSessionIds.add(session.id);
    }
    if (artifacts) {
      const staleUploads = database.deleteStaleUploads(new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString());
      artifacts.remove(staleUploads);
      const unavailableArtifacts = artifacts.reconcile(database.listArtifacts());
      if (unavailableArtifacts.length > 0) {
        process.stderr.write(
          `[forge] ${unavailableArtifacts.length} durable artifact(s) are missing or corrupt; affected downloads will be unavailable\n`,
        );
      }
    }
  }

  markGeneralProject(projectId: string): void {
    if (!this.snapshot.projects.some((project) => project.id === projectId)) {
      throw new Error("General project not found");
    }
    this.generalProjectId = projectId;
    this.snapshot = {
      ...this.snapshot,
      projects: this.snapshot.projects.map((project) => project.id === projectId
        ? { ...project, workspaceKind: "general" }
        : project),
    };
  }

  currentSnapshot(): AnvilSnapshot {
    return structuredClone(this.snapshot);
  }

  projectSummary(projectId: string): ProjectSummary | undefined {
    const project = this.snapshot.projects.find((candidate) => candidate.id === projectId);
    return project ? { ...project } : undefined;
  }

  projectSummaries(): ProjectSummary[] {
    return this.snapshot.projects.map((project) => ({ ...project }));
  }

  sessionSummary(sessionId: string): SessionSummary | undefined {
    const session = this.snapshot.sessions.find((candidate) => candidate.id === sessionId);
    return session ? { ...session } : undefined;
  }

  sessionSummariesForProject(projectId: string): SessionSummary[] {
    return this.snapshot.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => ({ ...session }));
  }

  pendingInteractionsForSession(sessionId: string): AnvilSnapshot["pendingInteractions"] {
    return structuredClone(
      this.snapshot.pendingInteractions.filter((request) => request.sessionId === sessionId),
    );
  }

  hasPendingInteraction(sessionId: string, requestId?: string): boolean {
    return this.snapshot.pendingInteractions.some(
      (request) => request.sessionId === sessionId && (requestId === undefined || request.id === requestId),
    );
  }

  catalogForSession(sessionId: string): AnvilSnapshot["catalogs"][string] | undefined {
    const catalog = this.snapshot.catalogs[sessionId];
    return catalog ? structuredClone(catalog) : undefined;
  }

  timelineForSession(sessionId: string): AnvilSnapshot["timelines"][string] {
    return structuredClone(this.snapshot.timelines[sessionId] ?? []);
  }

  searchThreads(query: string, limit = 50): ThreadSearchMatch[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length < 2 || normalizedQuery.length > 200) return [];

    const matches: Array<ThreadSearchMatch & { sessionUpdatedAt: string }> = [];
    for (const session of this.snapshot.sessions) {
      if (session.internal) continue;
      const candidates = (this.snapshot.timelines[session.id] ?? []).flatMap((entry) => {
        if (
          entry.kind !== "message" ||
          entry.status !== "complete" ||
          (entry.role !== "user" && entry.role !== "assistant") ||
          (entry.role === "user" && entry.origin !== undefined)
        ) return [];
        const text = entry.content
          .filter((block) => block.type === "text")
          .map((block) => block.type === "text" ? block.text : "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const matchIndex = text.toLocaleLowerCase().indexOf(normalizedQuery);
        if (matchIndex < 0) return [];
        const bodyLength = 236;
        const start = Math.min(Math.max(0, matchIndex - 72), Math.max(0, text.length - bodyLength));
        const end = Math.min(text.length, start + bodyLength);
        return [{
          sessionId: session.id,
          role: entry.role,
          snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
          messageCreatedAt: entry.createdAt,
          sessionUpdatedAt: session.updatedAt,
        }];
      });
      const preferred = candidates
        .sort((left, right) => {
          if (left.role !== right.role) return left.role === "user" ? -1 : 1;
          return right.messageCreatedAt.localeCompare(left.messageCreatedAt);
        })[0];
      if (preferred) matches.push(preferred);
    }

    return matches
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "user" ? -1 : 1;
        return right.sessionUpdatedAt.localeCompare(left.sessionUpdatedAt) || left.sessionId.localeCompare(right.sessionId);
      })
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map(({ sessionUpdatedAt: _sessionUpdatedAt, ...match }) => match);
  }

  bootstrap(): AnvilBootstrap {
    const snapshot = this.currentSnapshot();
    const internalSessionIds = new Set(
      snapshot.sessions.filter((session) => session.internal).map((session) => session.id),
    );
    snapshot.sessions = snapshot.sessions.filter((session) => !session.internal);
    if (snapshot.activeSessionId && internalSessionIds.has(snapshot.activeSessionId)) snapshot.activeSessionId = null;
    snapshot.timelines = this.withoutSessionKeys(snapshot.timelines, internalSessionIds);
    snapshot.catalogs = this.withoutSessionKeys(snapshot.catalogs, internalSessionIds);
    snapshot.queues = this.withoutSessionKeys(snapshot.queues, internalSessionIds);
    snapshot.composerDrafts = this.withoutSessionKeys(snapshot.composerDrafts, internalSessionIds);
    snapshot.runStates = this.withoutSessionKeys(snapshot.runStates, internalSessionIds);
    snapshot.subagentRuns = this.withoutSessionKeys(snapshot.subagentRuns, internalSessionIds);
    snapshot.pendingInteractions = snapshot.pendingInteractions.filter((request) => !internalSessionIds.has(request.sessionId));
    snapshot.extensionStatuses = snapshot.extensionStatuses.filter((status) => !internalSessionIds.has(status.sessionId));
    snapshot.widgets = snapshot.widgets.filter((widget) => !internalSessionIds.has(widget.sessionId));
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      snapshot,
      events: [],
      cursor: this.snapshot.lastSequence,
    };
  }

  summaryBootstrap(): AnvilSummaryBootstrap {
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: this.snapshot.capturedAt,
      connection: "connected",
      projects: structuredClone(this.snapshot.projects),
      sessions: structuredClone(this.snapshot.sessions.filter((session) => !session.internal)),
      cursor: this.snapshot.lastSequence,
    };
  }

  sessionDetail(sessionId: string): AnvilSessionDetail | undefined {
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) return undefined;
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      sessionId,
      throughSequence: this.snapshot.lastSequence,
      timeline: structuredClone(this.snapshot.timelines[sessionId] ?? []),
      catalog: structuredClone(this.snapshot.catalogs[sessionId] ?? { models: [], commands: [], skills: [] }),
      pendingInteractions: structuredClone(this.snapshot.pendingInteractions.filter((request) => request.sessionId === sessionId)),
      extensionStatuses: structuredClone(this.snapshot.extensionStatuses.filter((status) => status.sessionId === sessionId)),
      widgets: structuredClone(this.snapshot.widgets.filter((widget) => widget.sessionId === sessionId)),
      queue: structuredClone(this.snapshot.queues[sessionId] ?? { steering: [], followUp: [] }),
      composerDraft: this.snapshot.composerDrafts[sessionId] ?? "",
      runState: this.snapshot.runStates[sessionId] ?? "idle",
      subagentRuns: structuredClone(this.snapshot.subagentRuns[sessionId] ?? []),
    };
  }

  sessionDetailSync(sessionId: string, afterSequence?: number): AnvilSessionDetailSync | undefined {
    const detail = this.sessionDetail(sessionId);
    if (!detail) return undefined;
    if (
      afterSequence === undefined ||
      afterSequence < this.compactedThrough() ||
      afterSequence > detail.throughSequence
    ) {
      return { protocolVersion: ANVIL_PROTOCOL_VERSION, mode: "reset", detail };
    }
    const events = this.database.readSessionEventsAfter(
      sessionId,
      afterSequence,
      detail.throughSequence,
      10_000,
    );
    if (events.length === 10_000) {
      return { protocolVersion: ANVIL_PROTOCOL_VERSION, mode: "reset", detail };
    }
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "delta",
      sessionId,
      fromSequence: afterSequence,
      throughSequence: detail.throughSequence,
      events,
      subagentRuns: detail.subagentRuns,
    };
  }

  commandOutcome(commandId: string) {
    return this.database.commandOutcome(commandId);
  }

  append(events: readonly UnsequencedAnvilEvent[]): AnvilEvent[] {
    if (!this.artifacts) return this.acceptCommitted(this.database.appendEvents(events));
    const prepared = this.artifacts.externalize(events);
    try {
      return this.acceptCommitted(this.database.appendEvents(prepared.events, prepared.artifacts));
    } catch (error) {
      this.artifacts.remove(prepared.artifacts.map((artifact) => artifact.id));
      throw error;
    }
  }

  createProject(project: ProjectSummary, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.createProjectWithEvent(project, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  deleteProject(projectId: string, event: UnsequencedAnvilEvent): { sessionIds: string[] } {
    if (projectId === this.generalProjectId) throw new Error("The General home workspace cannot be removed");
    const deleted = this.database.deleteProjectWithEvent(projectId, event);
    this.acceptCommitted([deleted.event]);
    this.artifacts?.remove(deleted.artifactIds);
    this.checkpoint(true);
    return { sessionIds: deleted.sessionIds };
  }

  createSession(session: SessionSummary, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.createSessionWithEvent(session, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  acceptSubagentEvents(committed: AnvilEvent[]): AnvilEvent[] {
    return this.acceptCommitted(committed);
  }

  renameSession(sessionId: string, title: string, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.renameSessionWithEvent(sessionId, title, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  setSessionSettled(sessionId: string, settled: boolean, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.setSessionSettledWithEvent(sessionId, settled, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  markSessionRead(sessionId: string, throughSequence: number): AnvilEvent | undefined {
    const committed = this.database.markSessionReadWithEvent(
      sessionId,
      throughSequence,
      new Date().toISOString(),
    );
    if (committed) this.acceptCommitted([committed]);
    return committed;
  }

  markSessionUnread(sessionId: string): AnvilEvent | undefined {
    const committed = this.database.markSessionUnreadWithEvent(sessionId, new Date().toISOString());
    if (committed) this.acceptCommitted([committed]);
    return committed;
  }

  deleteSession(sessionId: string, event: UnsequencedAnvilEvent): AnvilEvent {
    const artifactIds = this.database.artifactIdsForSession(sessionId);
    const committed = this.database.deleteSessionWithEvent(sessionId, event);
    this.acceptCommitted([committed]);
    this.artifacts?.remove(artifactIds);
    this.checkpoint(true);
    return committed;
  }

  ingestAttachment(
    sessionId: string,
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): ArtifactReference {
    if (!this.artifacts) throw new Error("Artifact storage is unavailable");
    if (!this.snapshot.sessions.some((session) => session.id === sessionId)) {
      throw new Error("Session not found");
    }
    const ingested = this.artifacts.ingest(sessionId, bytes, mediaType, name);
    try {
      this.database.appendEvents([], [ingested.record]);
      return ingested.reference;
    } catch (error) {
      this.artifacts.remove([ingested.record.id]);
      throw error;
    }
  }

  consumeAttachments(sessionId: string, ids: readonly string[]): void {
    this.database.consumeUploadedArtifacts(sessionId, ids);
  }

  deleteAttachment(sessionId: string, id: string): boolean {
    const deleted = this.database.deleteUploadedArtifact(sessionId, id);
    if (deleted) this.artifacts?.remove([id]);
    return deleted;
  }

  artifact(id: string) {
    return this.database.getArtifact(id);
  }

  artifactPath(id: string): string | undefined {
    return this.artifacts?.pathFor(id);
  }

  private acceptCommitted(committed: AnvilEvent[]): AnvilEvent[] {
    if (committed.length === 0) return [];
    for (const event of committed) {
      if (event.type === "session.upserted" && event.payload.session.internal) {
        this.internalSessionIds.add(event.payload.session.id);
      }
    }
    this.snapshot = applyAnvilEvents(this.snapshot, committed);
    if (this.snapshot.sequenceGap) {
      throw new Error(`Committed journal contains a sequence gap at ${this.snapshot.sequenceGap.expected}`);
    }
    this.eventsSinceSnapshot += committed.length;
    if (this.eventsSinceSnapshot >= this.snapshotInterval) this.checkpoint();
    for (const event of committed) this.emit("event", event);
    return committed;
  }

  eventsAfter(cursor: number, limit = 1_000): AnvilEvent[] {
    return this.database.readEventsAfter(cursor, limit);
  }

  /** Preserve global sequence continuity without exposing internal child timelines. */
  externalEvent(event: AnvilEvent): AnvilEvent {
    const internal = event.type === "session.upserted"
      ? event.payload.session.internal === true
      : event.sessionId !== null && this.internalSessionIds.has(event.sessionId);
    if (!internal) return event;
    return {
      protocolVersion: event.protocolVersion,
      id: event.id,
      sequence: event.sequence,
      sessionId: null,
      timestamp: event.timestamp,
      type: "unknown",
      payload: { eventType: "internal.session", payload: null },
    };
  }

  latestSequence(): number {
    return this.snapshot.lastSequence;
  }

  compactedThrough(): number {
    return this.database.compactedThrough();
  }

  checkpoint(discardPreviousSnapshots = false): void {
    this.database.saveSnapshot(this.snapshot, { discardPreviousSnapshots });
    this.eventsSinceSnapshot = 0;
  }

  private withoutSessionKeys<T>(record: Record<string, T>, sessionIds: Set<string>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([sessionId]) => !sessionIds.has(sessionId)));
  }
}
