import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import {
  DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
  type MobileWorkspaceSurface,
  type ProjectWorkspaceSurfaceState,
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

type WorkspaceSurfaceContextValue = {
  projectId: string | null;
  state: ProjectWorkspaceSurfaceState;
  setBottomVisible(visible: boolean): void;
  setRightVisible(visible: boolean): void;
  setMobileSurface(surface: MobileWorkspaceSurface): void;
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
  }), [activate, projectId, state, update]);

  return <WorkspaceSurfaceContext.Provider value={value}>{children}</WorkspaceSurfaceContext.Provider>;
}

export function useWorkspaceSurfaces(): WorkspaceSurfaceContextValue {
  const value = useContext(WorkspaceSurfaceContext);
  if (!value) throw new Error("useWorkspaceSurfaces must be used within WorkspaceSurfaceProvider");
  return value;
}
