import { describe, expect, it } from "vitest";

import {
  activateProjectWorkspaceSurface,
  closeAgentsTabInState,
  closeGitTabInState,
  closeProjectResourceInState,
  openProjectResourceInState,
  updateProjectWorkspaceSurfaceState,
} from "./WorkspaceSurfaceState";

describe("project workspace surface state", () => {
  it("keeps surface presentation isolated by project", () => {
    const projectA = updateProjectWorkspaceSurfaceState({}, "project-a", {
      bottomVisible: true,
      mobileSurface: "terminal",
    });
    const both = updateProjectWorkspaceSurfaceState(projectA, "project-b", {
      rightVisible: true,
      mobileSurface: "resource",
    });

    expect(both["project-a"]).toEqual({
      bottomVisible: true,
      rightVisible: false,
      mobileSurface: "terminal",
      sidePage: "files",
      agentsTabOpen: false,
      gitTabOpen: false,
      resourceTabs: [],
      activeResourceId: null,
    });
    expect(both["project-b"]).toEqual({
      bottomVisible: false,
      rightVisible: true,
      mobileSurface: "resource",
      sidePage: "files",
      agentsTabOpen: false,
      gitTabOpen: false,
      resourceTabs: [],
      activeResourceId: null,
    });
  });

  it("opens mobile surfaces atomically with their shared slot visibility", () => {
    const terminal = activateProjectWorkspaceSurface({}, "project-a", "terminal");
    const resource = activateProjectWorkspaceSurface(terminal, "project-a", "resource");

    expect(terminal["project-a"]).toMatchObject({
      bottomVisible: true,
      mobileSurface: "terminal",
    });
    expect(resource["project-a"]).toEqual({
      bottomVisible: true,
      rightVisible: true,
      mobileSurface: "resource",
      sidePage: "files",
      agentsTabOpen: false,
      gitTabOpen: false,
      resourceTabs: [],
      activeResourceId: null,
    });
  });

  it("returns to the Files page when a project resource opens", () => {
    const agents = updateProjectWorkspaceSurfaceState({}, "project-a", {
      sidePage: "agents",
      rightVisible: true,
      mobileSurface: "resource",
    });
    const files = openProjectResourceInState(agents, {
      projectId: "project-a",
      path: "src/main.ts",
    }, "tool");

    expect(files["project-a"]).toMatchObject({
      sidePage: "files",
      rightVisible: true,
      mobileSurface: "resource",
      activeResourceId: "src/main.ts",
    });
  });

  it("falls back to the active file when the Agents tab closes", () => {
    let states = openProjectResourceInState({}, {
      projectId: "project-a",
      path: "src/main.ts",
    }, "tool");
    states = updateProjectWorkspaceSurfaceState(states, "project-a", {
      agentsTabOpen: true,
      sidePage: "agents",
    });
    states = closeAgentsTabInState(states, "project-a");

    expect(states["project-a"]).toMatchObject({
      agentsTabOpen: false,
      sidePage: "files",
      activeResourceId: "src/main.ts",
      rightVisible: true,
      mobileSurface: "resource",
    });
  });

  it("falls back between file and Agents tabs when either closes", () => {
    let states = openProjectResourceInState({}, {
      projectId: "project-a",
      path: "src/main.ts",
    }, "tool");
    states = updateProjectWorkspaceSurfaceState(states, "project-a", {
      agentsTabOpen: true,
      sidePage: "files",
    });
    states = closeProjectResourceInState(states, "project-a", "src/main.ts");

    expect(states["project-a"]).toMatchObject({
      agentsTabOpen: true,
      sidePage: "agents",
      rightVisible: true,
      mobileSurface: "resource",
    });

    states = closeAgentsTabInState(states, "project-a");
    expect(states["project-a"]).toMatchObject({
      agentsTabOpen: false,
      rightVisible: false,
      mobileSurface: "conversation",
    });
  });

  it("opens and closes GitHub activity like a side-pane tab", () => {
    let states = updateProjectWorkspaceSurfaceState({}, "project-a", {
      gitTabOpen: true,
      sidePage: "git",
      rightVisible: true,
      mobileSurface: "resource",
    });

    states = closeGitTabInState(states, "project-a");

    expect(states["project-a"]).toMatchObject({
      gitTabOpen: false,
      rightVisible: false,
      mobileSurface: "conversation",
    });
  });

  it("creates, reuses, closes, and isolates project resource tabs", () => {
    let states = openProjectResourceInState({}, {
      projectId: "project-a",
      path: "src/main.ts",
      line: 2,
    }, "timeline");
    states = openProjectResourceInState(states, {
      projectId: "project-a",
      path: "src/main.ts",
      line: 9,
    }, "timeline");
    states = openProjectResourceInState(states, {
      projectId: "project-b",
      path: "README.md",
    }, "tool");

    expect(states["project-a"]?.resourceTabs).toEqual([
      expect.objectContaining({ path: "src/main.ts", line: 9, openedFrom: "timeline" }),
    ]);
    expect(states["project-b"]?.resourceTabs).toHaveLength(1);
    states = closeProjectResourceInState(states, "project-a", "src/main.ts");
    expect(states["project-a"]).toMatchObject({
      resourceTabs: [],
      activeResourceId: null,
      rightVisible: false,
      mobileSurface: "conversation",
    });
    expect(states["project-b"]?.resourceTabs).toHaveLength(1);
  });
});
