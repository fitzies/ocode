import type { ProjectResourceReference, ProjectSummary, SessionSummary } from "@anvil/protocol";

export type WorkspaceLocation = {
  projectId: string;
  sessionId: string | null;
};

export type MobileWorkspaceSurface = "conversation" | "terminal" | "resource";
export type WorkspaceSidePage = "files" | "agents" | "git";

export type ProjectResourceOpenSource = "picker" | "tool" | "timeline" | "terminal";

export type ProjectResourceTab = ProjectResourceReference & {
  id: string;
  openedFrom: ProjectResourceOpenSource;
};

export type ProjectWorkspaceSurfaceState = {
  bottomVisible: boolean;
  rightVisible: boolean;
  mobileSurface: MobileWorkspaceSurface;
  sidePage: WorkspaceSidePage;
  agentsTabOpen: boolean;
  gitTabOpen: boolean;
  resourceTabs: ProjectResourceTab[];
  activeResourceId: string | null;
};

export const DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE: ProjectWorkspaceSurfaceState = {
  bottomVisible: false,
  rightVisible: false,
  mobileSurface: "conversation",
  sidePage: "files",
  agentsTabOpen: false,
  gitTabOpen: false,
  resourceTabs: [],
  activeResourceId: null,
};

export function isWorkspaceSidePaneVisible(
  state: ProjectWorkspaceSurfaceState,
  isMobile: boolean,
): boolean {
  return isMobile ? state.mobileSurface === "resource" : state.rightVisible;
}

export function projectResourceForCloseShortcut(
  state: ProjectWorkspaceSurfaceState,
  isMobile: boolean,
): ProjectResourceTab | undefined {
  if (!isWorkspaceSidePaneVisible(state, isMobile) || state.sidePage !== "files") return undefined;
  return state.resourceTabs.find((tab) => tab.id === state.activeResourceId) ?? state.resourceTabs[0];
}

export function shouldAutoOpenProjectResource(
  completionSessionId: string,
  location: WorkspaceLocation | null,
): boolean {
  return location?.sessionId === completionSessionId;
}

export function locationForSession(session: SessionSummary): WorkspaceLocation {
  return { projectId: session.projectId, sessionId: session.id };
}

export function reconcileWorkspaceLocation(
  location: WorkspaceLocation | undefined,
  projects: readonly ProjectSummary[],
  sessions: readonly SessionSummary[],
  preferredSessionId?: string | null,
): WorkspaceLocation | null {
  if (location && projects.some((project) => project.id === location.projectId)) {
    if (location.sessionId === null) return location;
    const session = sessions.find((candidate) => candidate.id === location.sessionId);
    if (session?.projectId === location.projectId) return location;
    const preferred = preferredSessionId
      ? sessions.find((candidate) => candidate.id === preferredSessionId && candidate.projectId === location.projectId)
      : undefined;
    const sameProjectSession = preferred ?? sessions.find((candidate) => candidate.projectId === location.projectId);
    return sameProjectSession
      ? locationForSession(sameProjectSession)
      : { projectId: location.projectId, sessionId: null };
  }

  const preferred = preferredSessionId
    ? sessions.find((session) => session.id === preferredSessionId)
    : undefined;
  if (preferred) return locationForSession(preferred);
  if (sessions[0]) return locationForSession(sessions[0]);
  if (projects[0]) return { projectId: projects[0].id, sessionId: null };
  return null;
}
