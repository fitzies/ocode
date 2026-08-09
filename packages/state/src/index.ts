import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilEvent,
  type AnvilSnapshot,
  type CapabilityCatalog,
  type ContentBlock,
  type MessageEntry,
  type ProjectSummary,
  type SessionStatus,
  type SessionSummary,
  type TimelineEntry,
} from "@anvil/protocol";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

export function createEmptySnapshot(input?: {
  projects?: ProjectSummary[];
  sessions?: SessionSummary[];
  catalogs?: Record<string, CapabilityCatalog>;
  activeSessionId?: string | null;
  capturedAt?: string;
}): AnvilSnapshot {
  const sessions = input?.sessions ?? [];
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    capturedAt: input?.capturedAt ?? new Date(0).toISOString(),
    connection: "connected",
    projects: input?.projects ?? [],
    sessions: sortSessionsByActivity(sessions),
    activeSessionId: input?.activeSessionId ?? sortSessionsByActivity(sessions)[0]?.id ?? null,
    timelines: Object.fromEntries(sessions.map((session) => [session.id, []])),
    catalogs: input?.catalogs ?? Object.fromEntries(
      sessions.map((session) => [session.id, EMPTY_CATALOG]),
    ),
    pendingInteractions: [],
    extensionStatuses: [],
    widgets: [],
    queues: Object.fromEntries(
      sessions.map((session) => [session.id, { steering: [], followUp: [] }]),
    ),
    composerDrafts: {},
    runStates: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        session.status === "running" ? "running" : session.status === "failed" ? "failed" : "idle",
      ]),
    ),
    subagentRuns: Object.fromEntries(sessions.map((session) => [session.id, []])),
    lastSequence: 0,
    sequenceGap: null,
  };
}

function replaceProject(snapshot: AnvilSnapshot, project: ProjectSummary): ProjectSummary[] {
  const exists = snapshot.projects.some((candidate) => candidate.id === project.id);
  return exists
    ? snapshot.projects.map((candidate) => (candidate.id === project.id ? project : candidate))
    : [...snapshot.projects, project];
}

export function sortSessionsByActivity(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const sequenceDifference = (right.lastUserMessageSequence ?? 0) - (left.lastUserMessageSequence ?? 0);
    if (sequenceDifference !== 0) return sequenceDifference;
    const rightTimestamp = right.lastUserMessageAt ? Date.parse(right.lastUserMessageAt) : 0;
    const leftTimestamp = left.lastUserMessageAt ? Date.parse(left.lastUserMessageAt) : 0;
    const timestampDifference = rightTimestamp - leftTimestamp;
    if (Number.isFinite(timestampDifference) && timestampDifference !== 0) return timestampDifference;
    return left.id.localeCompare(right.id);
  });
}

/** Repairs pre-user-activity snapshots from their durable user-message timelines. */
export function restoreLegacyUserActivity(snapshot: AnvilSnapshot): AnvilSnapshot {
  const sessions = snapshot.sessions.map((session) => {
    if (session.lastUserMessageAt) return session;
    const latestUserMessageAt = (snapshot.timelines[session.id] ?? [])
      .filter((entry): entry is MessageEntry =>
        entry.kind === "message" && entry.role === "user" && entry.origin?.type !== "subagentCompletion"
      )
      .map((entry) => entry.createdAt)
      .filter((createdAt) => Number.isFinite(Date.parse(createdAt)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    return latestUserMessageAt ? { ...session, lastUserMessageAt: latestUserMessageAt } : session;
  });
  return { ...snapshot, sessions: sortSessionsByActivity(sessions) };
}

function replaceSession(snapshot: AnvilSnapshot, session: SessionSummary): SessionSummary[] {
  const exists = snapshot.sessions.some((candidate) => candidate.id === session.id);
  return sortSessionsByActivity(exists
    ? snapshot.sessions.map((candidate) => (candidate.id === session.id ? session : candidate))
    : [session, ...snapshot.sessions]);
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function withoutKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

export function removeProjectFromSnapshot(snapshot: AnvilSnapshot, projectId: string): AnvilSnapshot {
  const sessionIds = new Set(
    snapshot.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id),
  );
  const sessions = snapshot.sessions.filter((session) => !sessionIds.has(session.id));
  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
    sessions,
    activeSessionId: snapshot.activeSessionId && sessionIds.has(snapshot.activeSessionId)
      ? sessions[0]?.id ?? null
      : snapshot.activeSessionId,
    timelines: withoutKeys(snapshot.timelines, sessionIds),
    catalogs: withoutKeys(snapshot.catalogs, sessionIds),
    pendingInteractions: snapshot.pendingInteractions.filter(
      (request) => !sessionIds.has(request.sessionId),
    ),
    extensionStatuses: snapshot.extensionStatuses.filter(
      (status) => !sessionIds.has(status.sessionId),
    ),
    widgets: snapshot.widgets.filter((widget) => !sessionIds.has(widget.sessionId)),
    queues: withoutKeys(snapshot.queues, sessionIds),
    composerDrafts: withoutKeys(snapshot.composerDrafts, sessionIds),
    runStates: withoutKeys(snapshot.runStates, sessionIds),
    subagentRuns: Object.fromEntries(Object.entries(snapshot.subagentRuns).filter(
      ([parentSessionId, runs]) => !sessionIds.has(parentSessionId) && !runs.some((run) => sessionIds.has(run.childSessionId)),
    )),
  };
}

function updateSession(
  snapshot: AnvilSnapshot,
  sessionId: string,
  patch: Partial<SessionSummary>,
): SessionSummary[] {
  return snapshot.sessions.map((session) =>
    session.id === sessionId ? { ...session, ...patch } : session,
  );
}

function promoteSession(
  snapshot: AnvilSnapshot,
  sessionId: string,
  patch: Partial<SessionSummary>,
): SessionSummary[] {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return snapshot.sessions;
  return sortSessionsByActivity([
    { ...session, ...patch },
    ...snapshot.sessions.filter((candidate) => candidate.id !== sessionId),
  ]);
}

function updateTimeline(
  snapshot: AnvilSnapshot,
  sessionId: string,
  update: (entries: TimelineEntry[]) => TimelineEntry[],
): Record<string, TimelineEntry[]> {
  return {
    ...snapshot.timelines,
    [sessionId]: update(snapshot.timelines[sessionId] ?? []),
  };
}

function upsertEntry(entries: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  const exists = entries.some((candidate) => candidate.id === entry.id);
  return exists
    ? entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
    : [...entries, entry];
}

function upsertTextBlock(blocks: ContentBlock[], blockId: string, delta: string): ContentBlock[] {
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (!block) return [...blocks, { id: blockId, type: "text", text: delta }];
  if (block.type !== "text") return blocks;
  return blocks.map((candidate) =>
    candidate.id === blockId ? { ...block, text: block.text + delta } : candidate,
  );
}

function fallbackMessage(event: AnvilEvent, messageId: string): MessageEntry {
  return {
    id: messageId,
    kind: "message",
    role: "assistant",
    content: [],
    status: "streaming",
    createdAt: event.timestamp,
    ...(event.raw === undefined ? {} : { raw: event.raw }),
  };
}

export function applyAnvilEvent(snapshot: AnvilSnapshot, event: AnvilEvent): AnvilSnapshot {
  const previousSequence = snapshot.lastSequence;
  if (event.sequence <= previousSequence) return snapshot;
  if (event.sequence > previousSequence + 1) {
    return {
      ...snapshot,
      sequenceGap: {
        expected: previousSequence + 1,
        received: event.sequence,
        detectedAt: event.timestamp,
      },
    };
  }

  const sequenceGap = snapshot.sequenceGap && event.sequence < snapshot.sequenceGap.received
    ? { ...snapshot.sequenceGap, expected: event.sequence + 1 }
    : null;

  let next: AnvilSnapshot = {
    ...snapshot,
    capturedAt: event.timestamp,
    lastSequence: event.sequence,
    sequenceGap,
  };

  switch (event.type) {
    case "connection.changed":
      return { ...next, connection: event.payload.connection };
    case "catalog.updated":
      if (!event.sessionId) return next;
      return {
        ...next,
        catalogs: { ...snapshot.catalogs, [event.sessionId]: event.payload.catalog },
      };
    case "project.upserted":
      return { ...next, projects: replaceProject(snapshot, event.payload.project) };
    case "project.deleted":
      return removeProjectFromSnapshot(next, event.payload.projectId);
    case "session.upserted": {
      const incoming = event.payload.session;
      const existing = snapshot.sessions.find((session) => session.id === incoming.id);
      const session = {
        ...incoming,
        readThroughSequence: incoming.readThroughSequence ??
          existing?.readThroughSequence ??
          incoming.lastTerminalSequence ??
          0,
      };
      const runState =
        snapshot.runStates[session.id] ??
        (session.status === "running" ? "running" : session.status === "failed" ? "failed" : "idle");
      return {
        ...next,
        sessions: replaceSession(snapshot, session),
        timelines: {
          ...snapshot.timelines,
          [session.id]: snapshot.timelines[session.id] ?? [],
        },
        queues: {
          ...snapshot.queues,
          [session.id]: snapshot.queues[session.id] ?? { steering: [], followUp: [] },
        },
        catalogs: {
          ...snapshot.catalogs,
          [session.id]: snapshot.catalogs[session.id] ?? EMPTY_CATALOG,
        },
        runStates: { ...snapshot.runStates, [session.id]: runState },
        subagentRuns: { ...snapshot.subagentRuns, [session.id]: snapshot.subagentRuns[session.id] ?? [] },
      };
    }
    case "session.deleted": {
      const sessionId = event.payload.sessionId;
      const sessions = snapshot.sessions.filter((session) => session.id !== sessionId);
      return {
        ...next,
        sessions,
        activeSessionId: snapshot.activeSessionId === sessionId
          ? sessions[0]?.id ?? null
          : snapshot.activeSessionId,
        timelines: withoutKey(snapshot.timelines, sessionId),
        catalogs: withoutKey(snapshot.catalogs, sessionId),
        pendingInteractions: snapshot.pendingInteractions.filter(
          (request) => request.sessionId !== sessionId,
        ),
        extensionStatuses: snapshot.extensionStatuses.filter(
          (status) => status.sessionId !== sessionId,
        ),
        widgets: snapshot.widgets.filter((widget) => widget.sessionId !== sessionId),
        queues: withoutKey(snapshot.queues, sessionId),
        composerDrafts: withoutKey(snapshot.composerDrafts, sessionId),
        runStates: withoutKey(snapshot.runStates, sessionId),
        subagentRuns: Object.fromEntries(Object.entries(snapshot.subagentRuns)
          .filter(([parentSessionId]) => parentSessionId !== sessionId)
          .map(([parentSessionId, runs]) => [parentSessionId, runs.filter((run) => run.childSessionId !== sessionId)])),
      };
    }
    case "session.settled": {
      if (!event.sessionId) return next;
      return {
        ...next,
        sessions: updateSession(snapshot, event.sessionId, { settled: event.payload.settled }),
      };
    }
    case "session.readState": {
      if (!event.sessionId) return next;
      return {
        ...next,
        sessions: updateSession(snapshot, event.sessionId, {
          readThroughSequence: event.payload.readThroughSequence,
        }),
      };
    }
    case "session.prompted": {
      if (!event.sessionId) return next;
      return {
        ...next,
        sessions: promoteSession(snapshot, event.sessionId, {
          updatedAt: event.timestamp,
          lastUserMessageAt: event.timestamp,
          lastUserMessageSequence: event.sequence,
        }),
      };
    }
    case "session.selected":
      return { ...next, activeSessionId: event.payload.sessionId };
    case "session.configured": {
      if (!event.sessionId) return next;
      const branchOnly = event.payload.branch !== undefined &&
        event.payload.modelId === undefined &&
        event.payload.thinkingLevel === undefined &&
        event.payload.title === undefined;
      const { branch, titleSource: _titleSource, ...configuration } = event.payload;
      return {
        ...next,
        sessions: updateSession(snapshot, event.sessionId, {
          ...configuration,
          ...(branch === undefined ? {} : { branch: branch ?? undefined }),
          ...(branchOnly ? {} : { updatedAt: event.timestamp }),
        }),
      };
    }
    case "run.status": {
      if (!event.sessionId) return next;
      const hasPendingInteraction = snapshot.pendingInteractions.some(
        (request) => request.sessionId === event.sessionId,
      );
      const status: SessionStatus = hasPendingInteraction ? "waiting" : event.payload.status;
      const terminalPatch = event.payload.outcome
        ? {
            lastTerminalSequence: event.sequence,
            lastTerminalOutcome: event.payload.outcome,
          }
        : {};
      const patch = {
        status,
        updatedAt: event.timestamp,
        ...terminalPatch,
      };
      return {
        ...next,
        runStates: { ...snapshot.runStates, [event.sessionId]: event.payload.status },
        sessions: updateSession(snapshot, event.sessionId, patch),
      };
    }
    case "message.started": {
      if (!event.sessionId) return next;
      return {
        ...next,
        sessions: updateSession(snapshot, event.sessionId, { updatedAt: event.timestamp }),
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          upsertEntry(entries, event.payload.message),
        ),
      };
    }
    case "message.delta": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => {
          const existing = entries.find(
            (entry): entry is MessageEntry =>
              entry.kind === "message" && entry.id === event.payload.messageId,
          );
          const message = existing ?? fallbackMessage(event, event.payload.messageId);
          const modelId = event.payload.modelId ?? message.modelId;
          const content = event.payload.artifact
            ? [
                ...message.content.filter((block) => block.id !== event.payload.artifact!.id),
                event.payload.artifact,
              ]
            : upsertTextBlock(
                message.content,
                event.payload.blockId,
                event.payload.delta,
              );
          const replacement: MessageEntry = {
            ...message,
            status: "streaming",
            ...(modelId === undefined ? {} : { modelId }),
            content,
          };
          return upsertEntry(entries, replacement);
        }),
      };
    }
    case "message.completed": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => {
          const existing = entries.find(
            (entry): entry is MessageEntry =>
              entry.kind === "message" && entry.id === event.payload.messageId,
          );
          const message = existing ?? fallbackMessage(event, event.payload.messageId);
          return upsertEntry(entries, {
            ...message,
            content: event.payload.content ?? message.content,
            status: event.payload.status ?? "complete",
            ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
          });
        }),
      };
    }
    case "stream.marker":
      return next;
    case "reasoning.started": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          upsertEntry(entries, event.payload.reasoning),
        ),
      };
    }
    case "reasoning.delta": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => {
          const existing = entries.find(
            (entry) => entry.kind === "reasoning" && entry.id === event.payload.reasoningId,
          );
          if (existing?.kind === "reasoning") {
            return entries.map((entry) =>
              entry.id === existing.id
                ? { ...existing, content: existing.content + event.payload.delta, status: "streaming" }
                : entry,
            );
          }
          return [
            ...entries,
            {
              id: event.payload.reasoningId,
              kind: "reasoning",
              messageId: event.payload.reasoningId.split("-reasoning-")[0] ?? "unknown-message",
              content: event.payload.delta,
              status: "streaming",
              createdAt: event.timestamp,
              ...(event.raw === undefined ? {} : { raw: event.raw }),
            },
          ];
        }),
      };
    }
    case "reasoning.completed": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          entries.map((entry) =>
            entry.kind === "reasoning" && entry.id === event.payload.reasoningId
              ? {
                  ...entry,
                  content: event.payload.content ?? entry.content,
                  status: event.payload.status ?? "complete",
                }
              : entry,
          ),
        ),
      };
    }
    case "tool.started": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          upsertEntry(entries, event.payload.tool),
        ),
      };
    }
    case "tool.updated": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => {
          const exists = entries.some(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId,
          );
          if (!exists) {
            return [
              ...entries,
              {
                id: `tool-${event.payload.toolCallId}`,
                kind: "tool",
                toolCallId: event.payload.toolCallId,
                name: "unknown_tool",
                summary: "Unknown tool execution",
                status: "running",
                arguments: {},
                output: event.payload.output,
                ...(event.payload.details === undefined ? {} : { details: event.payload.details }),
                createdAt: event.timestamp,
                ...(event.raw === undefined ? {} : { raw: event.raw }),
              },
            ];
          }
          return entries.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId
              ? {
                  ...entry,
                  output: event.payload.output,
                  ...(event.payload.details !== undefined
                    ? { details: event.payload.details }
                    : entry.details === undefined ? {} : { details: entry.details }),
                  status: "running",
                }
              : entry,
          );
        }),
      };
    }
    case "tool.completed": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => {
          const exists = entries.some(
            (entry) => entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId,
          );
          if (!exists) {
            return [
              ...entries,
              {
                id: `tool-${event.payload.toolCallId}`,
                kind: "tool",
                toolCallId: event.payload.toolCallId,
                name: "unknown_tool",
                summary: "Unknown tool execution",
                status: event.payload.status,
                arguments: {},
                output: event.payload.output,
                ...(event.payload.details === undefined ? {} : { details: event.payload.details }),
                createdAt: event.timestamp,
                endedAt: event.timestamp,
                ...(event.raw === undefined ? {} : { raw: event.raw }),
              },
            ];
          }
          return entries.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId
              ? {
                  ...entry,
                  output: event.payload.output,
                  ...(event.payload.details !== undefined
                    ? { details: event.payload.details }
                    : entry.details === undefined ? {} : { details: entry.details }),
                  status: event.payload.status,
                  endedAt: event.timestamp,
                }
              : entry,
          );
        }),
      };
    }
    case "timeline.event": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          upsertEntry(entries, event.payload.entry),
        ),
      };
    }
    case "interaction.requested": {
      const request = event.payload.request;
      const interactionEntry: TimelineEntry = {
        id: `interaction-${request.id}`,
        kind: "interaction",
        requestId: request.id,
        method: request.method,
        title: request.title,
        status:
          request.method === "unknown" && !request.fields ? "unsupported" : "pending",
        ...(request.message === undefined ? {} : { summary: request.message }),
        createdAt: event.timestamp,
        ...(request.raw === undefined ? {} : { raw: request.raw }),
      };
      return {
        ...next,
        sessions: updateSession(snapshot, request.sessionId, {
          status: "waiting",
          updatedAt: event.timestamp,
        }),
        pendingInteractions: [
          ...snapshot.pendingInteractions.filter((item) => item.id !== request.id),
          request,
        ],
        timelines: updateTimeline(snapshot, request.sessionId, (entries) =>
          upsertEntry(entries, interactionEntry),
        ),
      };
    }
    case "interaction.resolved": {
      if (!event.sessionId) return next;
      const remaining = snapshot.pendingInteractions.filter(
        (request) => request.id !== event.payload.requestId,
      );
      const stillWaiting = remaining.some((request) => request.sessionId === event.sessionId);
      const runState = snapshot.runStates[event.sessionId] ?? "idle";
      return {
        ...next,
        pendingInteractions: remaining,
        sessions: updateSession(snapshot, event.sessionId, {
          status: stillWaiting ? "waiting" : runState,
          updatedAt: event.timestamp,
        }),
        timelines: updateTimeline(snapshot, event.sessionId, (entries) =>
          entries.map((entry) =>
            entry.kind === "interaction" && entry.requestId === event.payload.requestId
              ? { ...entry, status: event.payload.status }
              : entry,
          ),
        ),
      };
    }
    case "extension.status": {
      if (!event.sessionId) return next;
      const withoutStatus = snapshot.extensionStatuses.filter(
        (status) => !(status.sessionId === event.sessionId && status.key === event.payload.key),
      );
      return {
        ...next,
        extensionStatuses: event.payload.text
          ? [
              ...withoutStatus,
              {
                sessionId: event.sessionId,
                key: event.payload.key,
                text: event.payload.text,
                ...(event.payload.source === undefined ? {} : { source: event.payload.source }),
                updatedAt: event.timestamp,
              },
            ]
          : withoutStatus,
      };
    }
    case "extension.widget": {
      if (!event.sessionId) return next;
      const withoutWidget = snapshot.widgets.filter(
        (widget) => !(widget.sessionId === event.sessionId && widget.key === event.payload.key),
      );
      return {
        ...next,
        widgets: event.payload.lines
          ? [
              ...withoutWidget,
              {
                sessionId: event.sessionId,
                key: event.payload.key,
                lines: event.payload.lines,
                placement: event.payload.placement ?? "aboveEditor",
                updatedAt: event.timestamp,
              },
            ]
          : withoutWidget,
      };
    }
    case "composer.prefill": {
      if (!event.sessionId) return next;
      return {
        ...next,
        composerDrafts: { ...snapshot.composerDrafts, [event.sessionId]: event.payload.text },
      };
    }
    case "queue.updated": {
      if (!event.sessionId) return next;
      return {
        ...next,
        queues: { ...snapshot.queues, [event.sessionId]: event.payload },
      };
    }
    case "subagent.updated": {
      if (!event.sessionId || event.payload.run.parentSessionId !== event.sessionId) return next;
      const runs = snapshot.subagentRuns[event.sessionId] ?? [];
      const exists = runs.some((run) => run.id === event.payload.run.id);
      return {
        ...next,
        subagentRuns: {
          ...snapshot.subagentRuns,
          [event.sessionId]: exists
            ? runs.map((run) => run.id === event.payload.run.id ? event.payload.run : run)
            : [...runs, event.payload.run],
        },
      };
    }
    case "subagent.deleted": {
      if (!event.sessionId || event.payload.parentSessionId !== event.sessionId) return next;
      return {
        ...next,
        subagentRuns: {
          ...snapshot.subagentRuns,
          [event.sessionId]: (snapshot.subagentRuns[event.sessionId] ?? [])
            .filter((run) => run.id !== event.payload.runId),
        },
      };
    }
    case "unknown": {
      if (!event.sessionId) return next;
      return {
        ...next,
        timelines: updateTimeline(snapshot, event.sessionId, (entries) => [
          ...entries,
          {
            id: `unknown-${event.id}`,
            kind: "event",
            category: "unknown",
            tone: "neutral",
            title: `Unknown event: ${event.payload.eventType}`,
            message: "ocode preserved an event it does not recognize.",
            details: event.payload.payload,
            createdAt: event.timestamp,
            ...(event.raw === undefined ? {} : { raw: event.raw }),
          },
        ]),
      };
    }
    default:
      return next;
  }
}

export function applyAnvilEvents(snapshot: AnvilSnapshot, events: AnvilEvent[]): AnvilSnapshot {
  return events.reduce(applyAnvilEvent, snapshot);
}

export function resetSessionState(snapshot: AnvilSnapshot, sessionId: string): AnvilSnapshot {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  return {
    ...snapshot,
    capturedAt: new Date().toISOString(),
    sessions: session
      ? updateSession(snapshot, sessionId, { status: "idle", updatedAt: session.updatedAt })
      : snapshot.sessions,
    timelines: { ...snapshot.timelines, [sessionId]: [] },
    pendingInteractions: snapshot.pendingInteractions.filter(
      (request) => request.sessionId !== sessionId,
    ),
    extensionStatuses: snapshot.extensionStatuses.filter(
      (status) => status.sessionId !== sessionId,
    ),
    widgets: snapshot.widgets.filter((widget) => widget.sessionId !== sessionId),
    queues: { ...snapshot.queues, [sessionId]: { steering: [], followUp: [] } },
    composerDrafts: { ...snapshot.composerDrafts, [sessionId]: "" },
    runStates: { ...snapshot.runStates, [sessionId]: "idle" },
    subagentRuns: { ...snapshot.subagentRuns, [sessionId]: [] },
  };
}

export function reconcileSnapshotAndTail(
  current: AnvilSnapshot,
  incoming: AnvilSnapshot,
  tail: AnvilEvent[],
): AnvilSnapshot {
  if (incoming.protocolVersion !== ANVIL_PROTOCOL_VERSION) return current;
  const restored: AnvilSnapshot = {
    ...incoming,
    projects: [...incoming.projects],
    sessions: [...incoming.sessions],
    timelines: Object.fromEntries(
      Object.entries(incoming.timelines).map(([sessionId, entries]) => [sessionId, [...entries]]),
    ),
    catalogs: Object.fromEntries(
      Object.entries(incoming.catalogs).map(([sessionId, catalog]) => [
        sessionId,
        { models: [...catalog.models], commands: [...catalog.commands], skills: [...catalog.skills] },
      ]),
    ),
    pendingInteractions: [...incoming.pendingInteractions],
    extensionStatuses: [...incoming.extensionStatuses],
    widgets: [...incoming.widgets],
    subagentRuns: Object.fromEntries(
      Object.entries(incoming.subagentRuns).map(([sessionId, runs]) => [sessionId, structuredClone(runs)]),
    ),
    sequenceGap: null,
  };
  return applyAnvilEvents(restored, tail);
}
