import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockAnvilClient } from "./anvilClient";

describe("MockAnvilClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("streams a mock run through thinking, tool activity, and completion", () => {
    const client = new MockAnvilClient();
    const sessionId = client.getSnapshot().activeSessionId;
    const initialLength = client.getSnapshot().timelines[sessionId].length;

    client.sendPrompt("Inspect the workspace");

    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.status).toBe(
      "running",
    );
    expect(client.getSnapshot().timelines[sessionId]).toHaveLength(initialLength + 2);

    vi.advanceTimersByTime(750);
    expect(client.getSnapshot().timelines[sessionId].at(-1)).toMatchObject({
      kind: "tool",
      status: "running",
    });

    vi.advanceTimersByTime(900);
    expect(client.getSnapshot().sessions.find((session) => session.id === sessionId)?.status).toBe(
      "idle",
    );
    expect(client.getSnapshot().timelines[sessionId].at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
    });
  });

  it("cancels only the active session while another session continues", () => {
    const client = new MockAnvilClient();
    const firstSessionId = client.getSnapshot().activeSessionId;
    const secondSessionId = "reconnect-flow";

    client.sendPrompt("Run in the first session");
    client.selectSession(secondSessionId);
    client.sendPrompt("Run in the second session");
    client.cancelActiveRun();

    expect(
      client.getSnapshot().sessions.find((session) => session.id === secondSessionId)?.status,
    ).toBe("idle");
    expect(
      client.getSnapshot().sessions.find((session) => session.id === firstSessionId)?.status,
    ).toBe("running");

    vi.advanceTimersByTime(1_650);

    expect(
      client.getSnapshot().sessions.find((session) => session.id === firstSessionId)?.status,
    ).toBe("idle");
    expect(client.getSnapshot().timelines[firstSessionId].at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
    });
  });
});
