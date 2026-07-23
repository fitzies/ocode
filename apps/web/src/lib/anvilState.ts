import {
  ANVIL_PROTOCOL_VERSION,
  type AnvilEvent,
  type AnvilSnapshot,
  type CapabilityCatalog,
  type ContentBlock,
  type MessageEntry,
  type ProjectSummary,
  type SessionSummary,
  type TimelineEntry,
} from "@anvil/protocol";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

export function createEmptySnapshot(input?: {
  projects?: ProjectSummary[];
  sessions?: SessionSummary[];
  catalog?: CapabilityCatalog;
  activeSessionId?: string | null;
  capturedAt?: string;
}): AnvilSnapshot {
  const sessions = input?.sessions ?? [];
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    capturedAt: input?.capturedAt ?? new Date(0).toISOString(),
    connection: "connected",
    projects: input?.projects ?? [],
    sessions,
    activeSessionId: input?.activeSessionId ?? sessions[0]?.id ?? null,
    timelines: Object.fromEntries(sessions.map((session) => [session.id, []])),
    catalog: input?.catalog ?? EMPTY_CATALOG,
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
    lastSequenceBySession: {},
    sequenceGaps: [],
  };
}

function replaceSession(snapshot: AnvilSnapshot, session: SessionSummary): SessionSummary[] {
  const exists = snapshot.sessions.some((candidate) => candidate.id === session.id);
  return exists
    ? snapshot.sessions.map((candidate) => (candidate.id === session.id ? session : candidate))
    : [session, ...snapshot.sessions];
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
    raw: event.raw,
  };
}

export function applyAnvilEvent(snapshot: AnvilSnapshot, event: AnvilEvent): AnvilSnapshot {
  const sequenceKey = event.sessionId ?? "__global__";
  const previousSequence = snapshot.lastSequenceBySession[sequenceKey] ?? 0;
  if (event.sequence <= previousSequence) return snapshot;
  if (event.sequence > previousSequence + 1) {
    const gap = {
      sessionId: event.sessionId,
      expected: previousSequence + 1,
      received: event.sequence,
      detectedAt: event.timestamp,
    };
    return {
      ...snapshot,
      sequenceGaps: [
        ...snapshot.sequenceGaps.filter(
          (candidate) => (candidate.sessionId ?? "__global__") !== sequenceKey,
        ),
        gap,
      ],
    };
  }

  const existingGap = snapshot.sequenceGaps.find(
    (candidate) => (candidate.sessionId ?? "__global__") === sequenceKey,
  );
  const sequenceGaps = existingGap && event.sequence < existingGap.received
    ? snapshot.sequenceGaps.map((candidate) =>
        (candidate.sessionId ?? "__global__") === sequenceKey
          ? { ...candidate, expected: event.sequence + 1 }
          : candidate,
      )
    : snapshot.sequenceGaps.filter(
        (candidate) => (candidate.sessionId ?? "__global__") !== sequenceKey,
      );

  let next: AnvilSnapshot = {
    ...snapshot,
    capturedAt: event.timestamp,
    lastSequenceBySession: {
      ...snapshot.lastSequenceBySession,
      [sequenceKey]: event.sequence,
    },
    sequenceGaps,
  };

  switch (event.type) {
    case "connection.changed":
      return { ...next, connection: event.payload.connection };
    case "catalog.updated":
      return { ...next, catalog: event.payload.catalog };
    case "session.upserted": {
      const session = event.payload.session;
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
        runStates: { ...snapshot.runStates, [session.id]: runState },
      };
    }
    case "session.selected":
      return { ...next, activeSessionId: event.payload.sessionId };
    case "session.configured": {
      if (!event.sessionId) return next;
      return {
        ...next,
        sessions: updateSession(snapshot, event.sessionId, {
          ...event.payload,
          updatedAt: event.timestamp,
        }),
      };
    }
    case "run.status": {
      if (!event.sessionId) return next;
      const hasPendingInteraction = snapshot.pendingInteractions.some(
        (request) => request.sessionId === event.sessionId,
      );
      const status = hasPendingInteraction ? "waiting" : event.payload.status;
      return {
        ...next,
        runStates: { ...snapshot.runStates, [event.sessionId]: event.payload.status },
        sessions: updateSession(snapshot, event.sessionId, {
          status,
          updatedAt: event.timestamp,
        }),
      };
    }
    case "message.started": {
      if (!event.sessionId) return next;
      return {
        ...next,
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
          const replacement: MessageEntry = {
            ...message,
            status: "streaming",
            modelId: event.payload.modelId ?? message.modelId,
            content: upsertTextBlock(
              message.content,
              event.payload.blockId,
              event.payload.delta,
            ),
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
            error: event.payload.error,
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
              raw: event.raw,
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
                details: event.payload.details,
                createdAt: event.timestamp,
                raw: event.raw,
              },
            ];
          }
          return entries.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId
              ? {
                  ...entry,
                  output: event.payload.output,
                  details: event.payload.details ?? entry.details,
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
                details: event.payload.details,
                createdAt: event.timestamp,
                endedAt: event.timestamp,
                raw: event.raw,
              },
            ];
          }
          return entries.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === event.payload.toolCallId
              ? {
                  ...entry,
                  output: event.payload.output,
                  details: event.payload.details ?? entry.details,
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
        summary: request.message,
        createdAt: event.timestamp,
        raw: request.raw,
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
                source: event.payload.source,
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
            message: "Anvil preserved an event it does not recognize.",
            details: event.payload.payload,
            createdAt: event.timestamp,
            raw: event.raw,
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
    lastSequenceBySession: { ...snapshot.lastSequenceBySession, [sessionId]: 0 },
    sequenceGaps: snapshot.sequenceGaps.filter((gap) => gap.sessionId !== sessionId),
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
    pendingInteractions: [...incoming.pendingInteractions],
    extensionStatuses: [...incoming.extensionStatuses],
    widgets: [...incoming.widgets],
    sequenceGaps: [],
  };
  return applyAnvilEvents(restored, tail);
}
