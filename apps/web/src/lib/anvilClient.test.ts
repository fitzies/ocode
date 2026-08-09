import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixtureAnvilClient } from "./anvilClient";

describe("FixtureAnvilClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restores protocol-complete fixture snapshots without Forge", () => {
    const client = new FixtureAnvilClient();
    const snapshot = client.getSnapshot();

    expect(snapshot.catalogs["ordinary-run"].models.length).toBeGreaterThan(1);
    expect(snapshot.catalogs["ordinary-run"].commands.some((command) => command.name === "handoff")).toBe(true);
    expect(snapshot.timelines["parallel-tools"].filter((entry) => entry.kind === "tool")).toHaveLength(2);
    expect(snapshot.pendingInteractions.filter((request) => request.sessionId === "dialog-queue")).toHaveLength(6);
    expect(snapshot.timelines["failure-unknown"].some((entry) => entry.kind === "event" && entry.category === "unknown")).toBe(true);
    expect(snapshot.subagentRuns["async-subagents"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "builder", status: "running" }),
      expect.objectContaining({ role: "reviewer", status: "needs_attention" }),
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "interrupted", notification: expect.objectContaining({ status: "uncertain" }) }),
    ]));
  });

  it("cancels durable fixture runs and opens bounded child detail only on request", async () => {
    const client = new FixtureAnvilClient();
    const parentSessionId = "async-subagents";
    const running = client.getSnapshot().subagentRuns[parentSessionId]!.find((run) => run.status === "running")!;

    await client.cancelSubagent(parentSessionId, running.id);
    expect(client.getSnapshot().subagentRuns[parentSessionId]?.find((run) => run.id === running.id)?.status).toBe("cancelled");
    expect(client.getSnapshot().sessions.some((session) => session.id === running.childSessionId)).toBe(false);

    const parentActiveSessionId = client.getSnapshot().activeSessionId;
    await client.loadSubagentSession(parentSessionId, running.id);
    expect(client.getSnapshot().sessions).toContainEqual(expect.objectContaining({
      id: running.childSessionId,
      internal: true,
      parentSessionId,
    }));
    expect(client.getSnapshot().activeSessionId).toBe(parentActiveSessionId);
    expect(client.getSnapshot().timelines[running.childSessionId]).toHaveLength(1);

    await client.openSubagentSession(parentSessionId, running.id);
    expect(client.getSnapshot().activeSessionId).toBe(running.childSessionId);
  });

  it("settles and reopens a thread through protocol state", async () => {
    const client = new FixtureAnvilClient();
    const sessionId = client.getSnapshot().sessions[0]!.id;

    await client.setSessionSettled(sessionId, true);
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.settled).toBe(true);

    await client.setSessionSettled(sessionId, false);
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.settled).toBe(false);
  });

  it("keeps project navigation separate until a thread is selected", () => {
    const client = new FixtureAnvilClient();
    const project = client.getSnapshot().projects[0]!;
    const session = client.getSnapshot().sessions.find((candidate) => candidate.projectId === project.id)!;

    client.selectProject(project.id);
    expect(client.getSnapshot().workspaceLocation).toEqual({ projectId: project.id, sessionId: null });
    expect(client.getSnapshot().activeSessionId).toBeNull();

    client.selectSession(session.id);
    expect(client.getSnapshot().workspaceLocation).toEqual({ projectId: project.id, sessionId: session.id });
    expect(client.getSnapshot().activeSessionId).toBe(session.id);
  });

  it("removes a fixture project and all of its session state", async () => {
    const client = new FixtureAnvilClient();
    const project = client.getSnapshot().projects[0]!;
    const sessionIds = client.getSnapshot().sessions
      .filter((session) => session.projectId === project.id)
      .map((session) => session.id);

    await client.deleteProject(project.id);

    expect(client.getSnapshot().projects.some((candidate) => candidate.id === project.id)).toBe(false);
    expect(client.getSnapshot().sessions.some((session) => session.projectId === project.id)).toBe(false);
    for (const sessionId of sessionIds) {
      expect(client.getSnapshot().timelines[sessionId]).toBeUndefined();
      expect(client.getSnapshot().catalogs[sessionId]).toBeUndefined();
    }
    expect(client.getSnapshot().workspaceLocation?.projectId).not.toBe(project.id);
  });

  it("provides realistic GitHub repositories in fixture mode", async () => {
    const client = new FixtureAnvilClient();

    const firstPage = await client.listGitHubRepositories();
    const secondPage = await client.listGitHubRepositories(2);

    expect(firstPage).toEqual({
      repositories: expect.arrayContaining([
        expect.objectContaining({ nameWithOwner: "ocode-labs/forge-console", private: true }),
        expect.objectContaining({ nameWithOwner: "collaborator/design-system", private: false }),
      ]),
      page: 1,
      hasMore: true,
    });
    expect(secondPage).toEqual({
      repositories: [expect.objectContaining({ nameWithOwner: "octocat/Hello-World" })],
      page: 2,
      hasMore: false,
    });
  });

  it("clones a project in fixture mode", async () => {
    const client = new FixtureAnvilClient();

    await client.cloneProject("Cloned Project", "owner/repository");

    expect(client.getSnapshot().projects).toContainEqual(expect.objectContaining({
      name: "Cloned Project",
      path: expect.stringContaining("/cloned-project"),
    }));
  });

  it("creates sessions in the explicitly selected project", () => {
    const client = new FixtureAnvilClient();
    const projectId = client.getSnapshot().projects.at(-1)?.id;
    expect(projectId).toBeDefined();

    client.createSession(projectId!);

    const created = client.getSnapshot().sessions.find(
      (session) => session.id === client.getSnapshot().activeSessionId,
    );
    expect(created?.projectId).toBe(projectId);
    expect(client.getSnapshot().catalogs[created!.id]).toBeDefined();
  });

  it("shows the first prompt as a provisional title until Pi names the thread", async () => {
    const client = new FixtureAnvilClient();
    const projectId = client.getSnapshot().projects.at(-1)!.id;
    client.createSession(projectId);
    const sessionId = client.getSnapshot().activeSessionId!;

    void client.sendPrompt("Fix   the sidebar while Pi names this thread");

    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.title)
      .toBe("Fix the sidebar while Pi names this…");

    await client.renameSession(sessionId, "Generated sidebar title");
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.title)
      .toBe("Generated sidebar title");
  });

  it("replays raw RPC records over time and can restore the final state instantly", () => {
    const client = new FixtureAnvilClient();
    client.restartReplay();

    expect(client.getSnapshot().replay.playing).toBe(true);
    expect(client.getSnapshot().timelines["ordinary-run"]).toHaveLength(0);

    vi.runAllTimers();

    expect(client.getSnapshot().replay.cursor).toBe(client.getSnapshot().replay.total);
    expect(client.getSnapshot().sessions.find((session) => session.id === "ordinary-run")?.status).toBe("idle");
    expect(client.getSnapshot().timelines["ordinary-run"].at(-1)).toMatchObject({ kind: "message", role: "assistant", status: "complete" });

    client.restartReplay();
    client.instantReplay();
    expect(client.getSnapshot().replay.playing).toBe(false);
    expect(client.getSnapshot().replay.cursor).toBe(client.getSnapshot().replay.total);
  });

  it("promotes a running session immediately when it receives steering", () => {
    const client = new FixtureAnvilClient();
    const firstSessionId = "ordinary-run";
    const secondSessionId = "parallel-tools";

    client.selectSession(firstSessionId);
    client.sendPrompt("Start the first run");
    client.selectSession(secondSessionId);
    client.sendPrompt("Start the second run");
    expect(client.getSnapshot().sessions[0]?.id).toBe(secondSessionId);

    client.selectSession(firstSessionId);
    client.sendPrompt("Steer the first run", "steer");

    expect(client.getSnapshot().sessions[0]?.id).toBe(firstSessionId);
  });

  it("cancels only the active session while another session continues", () => {
    const client = new FixtureAnvilClient();
    const firstSessionId = "ordinary-run";
    const secondSessionId = "parallel-tools";

    client.sendPrompt("Run in the first session");
    client.selectSession(secondSessionId);
    client.sendPrompt("Run in the second session");
    client.cancelActiveRun();

    expect(client.getSnapshot().sessions.find((session) => session.id === secondSessionId)?.status).toBe("idle");
    expect(client.getSnapshot().sessions.find((session) => session.id === firstSessionId)?.status).toBe("running");

    vi.runAllTimers();

    expect(client.getSnapshot().sessions.find((session) => session.id === firstSessionId)?.status).toBe("idle");
    expect(client.getSnapshot().timelines[firstSessionId].at(-1)).toMatchObject({ kind: "message", role: "assistant", status: "complete" });
  });

  it("keeps restored interaction requests pending until the client responds", () => {
    const client = new FixtureAnvilClient();
    client.selectSession("dialog-queue");
    const request = client.getSnapshot().pendingInteractions.find((item) => item.id === "dialog-select");
    expect(request).toBeDefined();

    client.respondToInteraction({ requestId: "dialog-select", value: "WebSocket" });

    expect(client.getSnapshot().pendingInteractions.some((item) => item.id === "dialog-select")).toBe(false);
    expect(client.getSnapshot().timelines["dialog-queue"].find((entry) => entry.kind === "interaction" && entry.requestId === "dialog-select")).toMatchObject({ status: "answered" });
    expect(client.getSnapshot().sessions.find((session) => session.id === "dialog-queue")?.status).toBe("waiting");
  });
});
