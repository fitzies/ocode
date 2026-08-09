import { describe, expect, it } from "vitest";

import {
  activateProjectWorkspaceSurface,
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
      resourceTabs: [],
      activeResourceId: null,
      activeRightSurface: "resource",
    });
    expect(both["project-b"]).toEqual({
      bottomVisible: false,
      rightVisible: true,
      mobileSurface: "resource",
      resourceTabs: [],
      activeResourceId: null,
      activeRightSurface: "resource",
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
      resourceTabs: [],
      activeResourceId: null,
      activeRightSurface: "resource",
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

  it("keeps the shared right panel open when the agents surface owns it", () => {
    let states = openProjectResourceInState({}, {
      projectId: "project-a",
      path: "src/main.ts",
    }, "timeline");
    states = updateProjectWorkspaceSurfaceState(states, "project-a", { activeRightSurface: "agents" });

    states = closeProjectResourceInState(states, "project-a", "src/main.ts");

    expect(states["project-a"]).toMatchObject({
      resourceTabs: [],
      activeRightSurface: "agents",
      rightVisible: true,
      mobileSurface: "resource",
    });
  });
});
