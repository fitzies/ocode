import { describe, expect, it } from "vitest";

import {
  activateProjectWorkspaceSurface,
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
    });
    expect(both["project-b"]).toEqual({
      bottomVisible: false,
      rightVisible: true,
      mobileSurface: "resource",
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
    });
  });
});
