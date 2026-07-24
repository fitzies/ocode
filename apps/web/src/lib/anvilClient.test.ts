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
  });

  it("settles and reopens a thread through protocol state", async () => {
    const client = new FixtureAnvilClient();
    const sessionId = client.getSnapshot().sessions[0]!.id;

    await client.setSessionSettled(sessionId, true);
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.settled).toBe(true);

    await client.setSessionSettled(sessionId, false);
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.settled).toBe(false);
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
