import type { ProjectResourceReference } from "@anvil/protocol";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import {
  DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
  type MobileWorkspaceSurface,
  type ProjectResourceOpenSource,
  type ProjectWorkspaceSurfaceState,
  type WorkspaceSidePage,
} from "@/lib/workspace";

export type WorkspaceSurfaceStateByProject = Record<string, ProjectWorkspaceSurfaceState>;

export function updateProjectWorkspaceSurfaceState(
  states: WorkspaceSurfaceStateByProject,
  projectId: string,
  update: Partial<ProjectWorkspaceSurfaceState>,
): WorkspaceSurfaceStateByProject {
  return {
    ...states,
    [projectId]: {
      ...DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
      ...states[projectId],
      ...update,
    },
  };
}

export function activateProjectWorkspaceSurface(
  states: WorkspaceSurfaceStateByProject,
  projectId: string,
  mobileSurface: MobileWorkspaceSurface,
): WorkspaceSurfaceStateByProject {
  return updateProjectWorkspaceSurfaceState(states, projectId, {
    mobileSurface,
    ...(mobileSurface === "terminal" ? { bottomVisible: true } : {}),
    ...(mobileSurface === "resource" ? { rightVisible: true } : {}),
  });
}

export function openProjectResourceInState(
  states: WorkspaceSurfaceStateByProject,
  reference: ProjectResourceReference,
  source: ProjectResourceOpenSource,
): WorkspaceSurfaceStateByProject {
  const current = states[reference.projectId] ?? DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE;
  const id = reference.path;
  const tab = { ...reference, id, openedFrom: source };
  const existing = current.resourceTabs.findIndex((candidate) => candidate.id === id);
  const resourceTabs = existing < 0
    ? [...current.resourceTabs, tab]
    : current.resourceTabs.map((candidate, index) => index === existing ? { ...candidate, ...tab } : candidate);
  return updateProjectWorkspaceSurfaceState(states, reference.projectId, {
    resourceTabs,
    activeResourceId: id,
    rightVisible: true,
    sidePage: "files",
    mobileSurface: "resource",
  });
}

export function closeProjectResourceInState(
  states: WorkspaceSurfaceStateByProject,
  projectId: string,
  resourceId: string,
): WorkspaceSurfaceStateByProject {
  const current = states[projectId] ?? DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE;
  const index = current.resourceTabs.findIndex((tab) => tab.id === resourceId);
  if (index < 0) return states;
  const resourceTabs = current.resourceTabs.filter((tab) => tab.id !== resourceId);
  const activeResourceId = current.activeResourceId === resourceId
    ? resourceTabs[Math.min(index, resourceTabs.length - 1)]?.id ?? null
    : current.activeResourceId;
  const showAgents = !resourceTabs.length && current.agentsTabOpen;
  return updateProjectWorkspaceSurfaceState(states, projectId, {
    resourceTabs,
    activeResourceId,
    ...(showAgents
      ? { sidePage: "agents" as const, rightVisible: true, mobileSurface: "resource" as const }
      : !resourceTabs.length
        ? { rightVisible: false, mobileSurface: "conversation" as const }
        : {}),
  });
}

export function closeAgentsTabInState(
  states: WorkspaceSurfaceStateByProject,
  projectId: string,
): WorkspaceSurfaceStateByProject {
  const current = states[projectId] ?? DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE;
  if (!current.agentsTabOpen) return states;
  const fallbackToFiles = current.sidePage === "agents" && current.resourceTabs.length > 0;
  const closeSurface = current.sidePage === "agents" && !current.resourceTabs.length;
  return updateProjectWorkspaceSurfaceState(states, projectId, {
    agentsTabOpen: false,
    ...(fallbackToFiles ? { sidePage: "files" as const } : {}),
    ...(closeSurface ? { rightVisible: false, mobileSurface: "conversation" as const } : {}),
  });
}

type WorkspaceSurfaceContextValue = {
  projectId: string | null;
  state: ProjectWorkspaceSurfaceState;
  setBottomVisible(visible: boolean): void;
  setRightVisible(visible: boolean): void;
  setMobileSurface(surface: MobileWorkspaceSurface): void;
  openSidePage(page: WorkspaceSidePage): void;
  openProjectResource(reference: ProjectResourceReference, source: ProjectResourceOpenSource): void;
  selectProjectResource(resourceId: string): void;
  closeProjectResource(resourceId: string): void;
  closeAgentsTab(): void;
};

const WorkspaceSurfaceContext = createContext<WorkspaceSurfaceContextValue | null>(null);

export function WorkspaceSurfaceProvider({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  const [states, setStates] = useState<WorkspaceSurfaceStateByProject>({});
  const state = projectId
    ? states[projectId] ?? DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE
    : DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE;
  const update = useCallback((next: Partial<ProjectWorkspaceSurfaceState>) => {
    if (!projectId) return;
    setStates((current) => updateProjectWorkspaceSurfaceState(current, projectId, next));
  }, [projectId]);
  const activate = useCallback((mobileSurface: MobileWorkspaceSurface) => {
    if (!projectId) return;
    setStates((current) => activateProjectWorkspaceSurface(current, projectId, mobileSurface));
  }, [projectId]);
  const value = useMemo<WorkspaceSurfaceContextValue>(() => ({
    projectId,
    state,
    setBottomVisible: (visible) => update({
      bottomVisible: visible,
      ...(!visible && state.mobileSurface === "terminal" ? { mobileSurface: "conversation" as const } : {}),
    }),
    setRightVisible: (visible) => update({
      rightVisible: visible,
      ...(!visible && state.mobileSurface === "resource" ? { mobileSurface: "conversation" as const } : {}),
    }),
    setMobileSurface: activate,
    openSidePage: (sidePage) => update({
      sidePage,
      ...(sidePage === "agents" ? { agentsTabOpen: true } : {}),
      rightVisible: true,
      mobileSurface: "resource",
    }),
    openProjectResource: (reference, source) => {
      setStates((current) => openProjectResourceInState(current, reference, source));
    },
    selectProjectResource: (resourceId) => update({
      activeResourceId: resourceId,
      sidePage: "files",
      rightVisible: true,
      mobileSurface: "resource",
    }),
    closeProjectResource: (resourceId) => {
      if (!projectId) return;
      setStates((current) => closeProjectResourceInState(current, projectId, resourceId));
    },
    closeAgentsTab: () => {
      if (!projectId) return;
      setStates((current) => closeAgentsTabInState(current, projectId));
    },
  }), [activate, projectId, state, update]);

  return <WorkspaceSurfaceContext.Provider value={value}>{children}</WorkspaceSurfaceContext.Provider>;
}

export function useWorkspaceSurfaces(): WorkspaceSurfaceContextValue {
  const value = useContext(WorkspaceSurfaceContext);
  if (!value) throw new Error("useWorkspaceSurfaces must be used within WorkspaceSurfaceProvider");
  return value;
}
