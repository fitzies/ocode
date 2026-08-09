import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
  isWorkspaceSidePaneVisible,
  locationForSession,
  projectResourceForCloseShortcut,
  reconcileWorkspaceLocation,
  shouldAutoOpenProjectResource,
} from "./workspace";

const projects = [
  { id: "project-a", name: "A", path: "/a" },
  { id: "project-b", name: "B", path: "/b" },
];
const sessions = [
  {
    id: "session-a",
    projectId: "project-a",
    title: "A thread",
    updatedAt: "2026-07-25T10:00:00.000Z",
    status: "idle" as const,
    modelId: "test/model",
    thinkingLevel: "off" as const,
  },
  {
    id: "session-b",
    projectId: "project-b",
    title: "B thread",
    updatedAt: "2026-07-25T09:00:00.000Z",
    status: "idle" as const,
    modelId: "test/model",
    thinkingLevel: "off" as const,
  },
];

describe("workspace location", () => {
  it("keeps project-only navigation independent from thread selection", () => {
    expect(reconcileWorkspaceLocation(
      { projectId: "project-b", sessionId: null },
      projects,
      sessions,
      "session-a",
    )).toEqual({ projectId: "project-b", sessionId: null });
  });

  it("selects both project and session for a thread", () => {
    expect(locationForSession(sessions[0]!)).toEqual({
      projectId: "project-a",
      sessionId: "session-a",
    });
  });

  it("keeps the project stable when its selected thread disappears", () => {
    expect(reconcileWorkspaceLocation(
      { projectId: "project-b", sessionId: "deleted" },
      projects,
      sessions,
      "session-a",
    )).toEqual({ projectId: "project-b", sessionId: "session-b" });
  });

  it("treats every open right-side page as visible for the header toggle", () => {
    const agents = {
      ...DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
      rightVisible: true,
      mobileSurface: "resource" as const,
      sidePage: "agents" as const,
    };

    expect(isWorkspaceSidePaneVisible(agents, false)).toBe(true);
    expect(isWorkspaceSidePaneVisible(agents, true)).toBe(true);
    expect(isWorkspaceSidePaneVisible({ ...agents, mobileSurface: "conversation" }, true)).toBe(false);
  });

  it("targets the active file before the thread for the close shortcut", () => {
    const file = {
      id: "README.md",
      projectId: "project-a",
      path: "README.md",
      openedFrom: "picker" as const,
    };
    const files = {
      ...DEFAULT_PROJECT_WORKSPACE_SURFACE_STATE,
      rightVisible: true,
      sidePage: "files" as const,
      resourceTabs: [file],
      activeResourceId: file.id,
    };

    expect(projectResourceForCloseShortcut(files, false)).toBe(file);
    expect(projectResourceForCloseShortcut({ ...files, rightVisible: false }, false)).toBeUndefined();
    expect(projectResourceForCloseShortcut({ ...files, sidePage: "agents" }, false)).toBeUndefined();
  });

  it("checks live auto-open eligibility against the current location atomically", () => {
    const beforeSwitch = { projectId: "project-a", sessionId: "session-a" };
    const afterSwitch = { projectId: "project-b", sessionId: "session-b" };
    expect(shouldAutoOpenProjectResource("session-a", beforeSwitch)).toBe(true);
    expect(shouldAutoOpenProjectResource("session-a", afterSwitch)).toBe(false);
    expect(shouldAutoOpenProjectResource("session-b", afterSwitch)).toBe(true);
    expect(shouldAutoOpenProjectResource("session-b", null)).toBe(false);
  });

  it("falls back safely when the selected project or thread disappears", () => {
    expect(reconcileWorkspaceLocation(
      { projectId: "missing", sessionId: null },
      projects,
      sessions,
      "session-a",
    )).toEqual({ projectId: "project-a", sessionId: "session-a" });
    expect(reconcileWorkspaceLocation(
      { projectId: "project-b", sessionId: "deleted" },
      projects,
      sessions.filter((session) => session.projectId !== "project-b"),
      "session-a",
    )).toEqual({ projectId: "project-b", sessionId: null });
  });
});
