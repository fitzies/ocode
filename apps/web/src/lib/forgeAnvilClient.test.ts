import { ANVIL_PROTOCOL_VERSION, type AnvilEvent, type SessionSummary } from "@anvil/protocol";
import { createEmptySnapshot } from "@anvil/state";
import { describe, expect, it } from "vitest";

import { ForgeAnvilClient } from "./anvilClient";

class FakeEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  emit(type: string, data: string): void {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Forge client state");
}

const session: SessionSummary = {
  id: "session-1",
  projectId: "anvil",
  title: "Live session",
  updatedAt: "2026-07-23T01:00:00.000Z",
  status: "idle",
  modelId: "test/model-1",
  thinkingLevel: "medium",
};

describe("ForgeAnvilClient", () => {
  it("bootstraps and applies globally sequenced SSE events", async () => {
    const stream = new FakeEventSource();
    const snapshot = {
      ...createEmptySnapshot({
        projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
        sessions: [session],
      }),
      activeSessionId: null,
    };
    const fetcher = async () => new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      snapshot,
      events: [],
      cursor: 0,
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    const event: AnvilEvent = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-1",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "run.status",
      payload: { status: "running" },
    };
    stream.emit("anvil", JSON.stringify(event));

    expect(client.getSnapshot()).toMatchObject({
      connection: "connected",
      lastSequence: 1,
      activeSessionId: session.id,
      sessions: [{ id: session.id, status: "running" }],
    });
  });

  it("creates a session in the explicitly selected project", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({
      projects: [
        { id: "anvil", name: "Anvil", path: "/repo" },
        { id: "other", name: "Other", path: "/other" },
      ],
      sessions: [session],
    });
    const bodies: unknown[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      bodies.push(JSON.parse(String(init?.body)));
      const sent = bodies.at(-1) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-create",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: true,
        outcome: "completed",
        data: { sessionId: "session-other" },
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.createSession("other");
    await waitUntil(() => bodies.length === 1);

    expect(bodies[0]).toMatchObject({
      type: "session.create",
      sessionId: null,
      payload: { projectId: "other" },
    });
  });

  it("selects a newly created session when bootstrap wins the SSE race", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const createdSession = { ...session, id: "session-created", title: "New session" };
    let bootstrapCount = 0;
    let commandSent = false;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        bootstrapCount++;
        const sessions = bootstrapCount === 1 ? [session] : [createdSession, session];
        const snapshot = { ...createEmptySnapshot({ projects: [project], sessions }), activeSessionId: null };
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string };
      commandSent = true;
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-create-race",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: true,
        outcome: "completed",
        data: { sessionId: createdSession.id },
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);
    client.createSession(project.id);
    await waitUntil(() => commandSent && bootstrapCount === 1 && stream.listeners.has("reset"));

    stream.emit("reset", "{}");
    await waitUntil(() => client.getSnapshot().sessions.length === 2);

    expect(client.getSnapshot().activeSessionId).toBe(createdSession.id);
  });

  it("sends typed commands to Forge", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session],
    });
    const bodies: unknown[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      bodies.push(JSON.parse(String(init?.body)));
      const command = bodies.at(-1) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-1",
        commandId: command.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: true,
        outcome: "completed",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);
    client.setModel("test/model-2");
    await waitUntil(() => bodies.length === 1);

    expect(bodies[0]).toMatchObject({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      sessionId: session.id,
      type: "model.set",
      payload: { modelId: "test/model-2" },
    });
  });
});
