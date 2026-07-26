import { describe, expect, it } from "vitest";

import { locationForSession, reconcileWorkspaceLocation } from "./workspace";

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
