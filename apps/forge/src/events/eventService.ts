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
} from "@anvil/protocol";
import { applyAnvilEvents, createEmptySnapshot } from "@anvil/state";

import { ArtifactStore } from "../artifacts/artifactStore.ts";
import { ForgeDatabase } from "../store/database.ts";

export class ForgeEventService extends EventEmitter {
  private snapshot: AnvilSnapshot;
  private eventsSinceSnapshot = 0;

  constructor(
    private readonly database: ForgeDatabase,
    projects: ProjectSummary[],
    private readonly artifacts?: ArtifactStore,
    private readonly snapshotInterval = 250,
  ) {
    super();
    database.syncProjects(projects);
    const persistedProjects = database.listProjects();
    const stored = database.latestSnapshot();
    let restored = stored?.snapshot ?? createEmptySnapshot({ projects: persistedProjects });
    while (true) {
      const tail = database.readEventsAfter(restored.lastSequence, 10_000);
      if (tail.length === 0) break;
      restored = applyAnvilEvents(restored, tail);
      if (tail.length < 10_000) break;
    }
    this.snapshot = {
      ...restored,
      connection: "connected",
      projects: persistedProjects,
      sequenceGap: null,
    };
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

  currentSnapshot(): AnvilSnapshot {
    return structuredClone(this.snapshot);
  }

  bootstrap(): AnvilBootstrap {
    return {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      snapshot: this.currentSnapshot(),
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
      sessions: structuredClone(this.snapshot.sessions),
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
    };
  }

  sessionDetailSync(sessionId: string, afterSequence?: number): AnvilSessionDetailSync | undefined {
    const detail = this.sessionDetail(sessionId);
    if (!detail) return undefined;
    if (afterSequence === undefined || afterSequence < 0 || afterSequence > detail.throughSequence) {
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

  createSession(session: SessionSummary, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.createSessionWithEvent(session, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  setSessionSettled(sessionId: string, settled: boolean, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.setSessionSettledWithEvent(sessionId, settled, event);
    this.acceptCommitted([committed]);
    return committed;
  }

  deleteSession(sessionId: string, event: UnsequencedAnvilEvent): AnvilEvent {
    const artifactIds = this.database.artifactIdsForSession(sessionId);
    const committed = this.database.deleteSessionWithEvent(sessionId, event);
    this.acceptCommitted([committed]);
    this.artifacts?.remove(artifactIds);
    this.checkpoint();
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

  checkpoint(): void {
    this.database.saveSnapshot(this.snapshot);
    this.eventsSinceSnapshot = 0;
  }
}
