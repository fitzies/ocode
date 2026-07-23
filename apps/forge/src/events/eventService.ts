import { EventEmitter } from "node:events";

import type { UnsequencedAnvilEvent } from "@anvil/pi-rpc";
import { ANVIL_PROTOCOL_VERSION, type AnvilBootstrap, type AnvilEvent, type AnvilSnapshot, type ProjectSummary, type SessionSummary } from "@anvil/protocol";
import { applyAnvilEvents, createEmptySnapshot } from "@anvil/state";

import { ForgeDatabase } from "../store/database.ts";

export class ForgeEventService extends EventEmitter {
  private snapshot: AnvilSnapshot;
  private eventsSinceSnapshot = 0;

  constructor(
    private readonly database: ForgeDatabase,
    projects: ProjectSummary[],
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

  append(events: readonly UnsequencedAnvilEvent[]): AnvilEvent[] {
    return this.acceptCommitted(this.database.appendEvents(events));
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

  deleteSession(sessionId: string, event: UnsequencedAnvilEvent): AnvilEvent {
    const committed = this.database.deleteSessionWithEvent(sessionId, event);
    this.acceptCommitted([committed]);
    this.checkpoint();
    return committed;
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
