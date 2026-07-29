import type { AnvilClientSnapshot } from "./anvilClient";

export type AppShellSnapshot = Pick<
  AnvilClientSnapshot,
  | "projects"
  | "sessions"
  | "activeSessionId"
  | "workspaceLocation"
  | "timelines"
  | "catalogs"
  | "pendingInteractions"
  | "extensionStatuses"
  | "widgets"
  | "queues"
  | "composerDrafts"
  | "connection"
  | "sequenceGap"
  | "clientError"
  | "hydratingSessionIds"
>;

const EMPTY_TIMELINE: AnvilClientSnapshot["timelines"][string] = [];
const EMPTY_CATALOG: AnvilClientSnapshot["catalogs"][string] = { models: [], commands: [], skills: [] };
const EMPTY_QUEUE: AnvilClientSnapshot["queues"][string] = { steering: [], followUp: [] };

function selectedSessionId(snapshot: Pick<AnvilClientSnapshot, "sessions" | "workspaceLocation">): string | undefined {
  const sessionId = snapshot.workspaceLocation?.sessionId;
  return snapshot.sessions.some((session) => session.id === sessionId)
    ? sessionId ?? undefined
    : undefined;
}

export function selectAppShellSnapshot(snapshot: AnvilClientSnapshot): AppShellSnapshot {
  const sessionId = selectedSessionId(snapshot);
  return {
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    activeSessionId: snapshot.activeSessionId,
    workspaceLocation: snapshot.workspaceLocation,
    timelines: sessionId ? { [sessionId]: snapshot.timelines[sessionId] ?? EMPTY_TIMELINE } : {},
    catalogs: sessionId ? { [sessionId]: snapshot.catalogs[sessionId] ?? EMPTY_CATALOG } : {},
    pendingInteractions: sessionId
      ? snapshot.pendingInteractions.filter((request) => request.sessionId === sessionId)
      : [],
    extensionStatuses: sessionId
      ? snapshot.extensionStatuses.filter((status) => status.sessionId === sessionId)
      : [],
    widgets: sessionId
      ? snapshot.widgets.filter((widget) => widget.sessionId === sessionId)
      : [],
    queues: sessionId ? { [sessionId]: snapshot.queues[sessionId] ?? EMPTY_QUEUE } : {},
    composerDrafts: sessionId ? { [sessionId]: snapshot.composerDrafts[sessionId] ?? "" } : {},
    connection: snapshot.connection,
    sequenceGap: snapshot.sequenceGap,
    clientError: snapshot.clientError,
    hydratingSessionIds: sessionId && snapshot.hydratingSessionIds.includes(sessionId) ? [sessionId] : [],
  };
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function equalAppShellSnapshots(left: AppShellSnapshot, right: AppShellSnapshot): boolean {
  if (
    left.projects !== right.projects ||
    left.sessions !== right.sessions ||
    left.activeSessionId !== right.activeSessionId ||
    left.workspaceLocation !== right.workspaceLocation ||
    left.connection !== right.connection ||
    left.sequenceGap !== right.sequenceGap ||
    left.clientError !== right.clientError
  ) {
    return false;
  }

  const leftSessionId = selectedSessionId(left);
  const rightSessionId = selectedSessionId(right);
  if (leftSessionId !== rightSessionId) return false;
  if (!leftSessionId) return true;

  return left.timelines[leftSessionId] === right.timelines[rightSessionId!] &&
    left.catalogs[leftSessionId] === right.catalogs[rightSessionId!] &&
    left.queues[leftSessionId] === right.queues[rightSessionId!] &&
    left.composerDrafts[leftSessionId] === right.composerDrafts[rightSessionId!] &&
    sameItems(left.pendingInteractions, right.pendingInteractions) &&
    sameItems(left.extensionStatuses, right.extensionStatuses) &&
    sameItems(left.widgets, right.widgets) &&
    sameItems(left.hydratingSessionIds, right.hydratingSessionIds);
}
