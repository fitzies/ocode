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

  it("renders a detail newer than bootstrap without duplicating its later SSE events", async () => {
    const stream = new FakeEventSource();
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          capturedAt: session.updatedAt,
          connection: "connected",
          projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
          sessions: [session],
          cursor: 0,
        }));
      }
      if (url.includes("/detail")) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          mode: "reset",
          detail: {
            protocolVersion: ANVIL_PROTOCOL_VERSION,
            sessionId: session.id,
            throughSequence: 2,
            timeline: [{
              id: "assistant-1",
              kind: "message",
              role: "assistant",
              content: [{ id: "text-1", type: "text", text: "Hello" }],
              status: "streaming",
              createdAt: session.updatedAt,
            }],
            catalog: { models: [], commands: [], skills: [] },
            pendingInteractions: [],
            extensionStatuses: [],
            widgets: [],
            queue: { steering: [], followUp: [] },
            composerDraft: "",
            runState: "running",
          },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().timelines[session.id]?.length === 1);

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-message-start",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          content: [],
          status: "streaming",
          createdAt: session.updatedAt,
        },
      },
    }));
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-message-delta",
      sequence: 2,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "message.delta",
      payload: { messageId: "assistant-1", blockId: "text-1", delta: "Hello" },
    }));

    expect(client.getSnapshot().timelines[session.id]?.[0]).toMatchObject({
      content: [{ text: "Hello" }],
    });
  });

  it("ignores an obsolete detail response after a newer bootstrap", async () => {
    const stream = new FakeEventSource();
    let bootstrapCount = 0;
    let detailCount = 0;
    let resolveOldDetail!: (response: Response) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    const detailResponse = (text: string, throughSequence: number) => new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "reset",
      detail: {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        sessionId: session.id,
        throughSequence,
        timeline: [{
          id: "assistant-1",
          kind: "message",
          role: "assistant",
          content: [{ id: "text-1", type: "text", text }],
          status: "complete",
          createdAt: session.updatedAt,
        }],
        catalog: { models: [], commands: [], skills: [] },
        pendingInteractions: [],
        extensionStatuses: [],
        widgets: [],
        queue: { steering: [], followUp: [] },
        composerDraft: "",
        runState: "idle",
      },
    }));
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/bootstrap")) {
        bootstrapCount++;
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          capturedAt: session.updatedAt,
          connection: "connected",
          projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
          sessions: [session],
          cursor: bootstrapCount === 1 ? 0 : 10,
        }));
      }
      if (url.includes("/detail")) {
        detailCount++;
        return detailCount === 1 ? oldDetail : detailResponse("New", 10);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => detailCount === 1);
    expect(client.getSnapshot().hydratingSessionIds).toContain(session.id);

    stream.emit("reset", "{}");
    await waitUntil(() => bootstrapCount === 2 && detailCount === 2);
    await waitUntil(() => {
      const entry = client.getSnapshot().timelines[session.id]?.[0];
      return entry?.kind === "message" && entry.content[0]?.type === "text" && entry.content[0].text === "New";
    });

    resolveOldDetail(detailResponse("Old", 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getSnapshot().timelines[session.id]?.[0]).toMatchObject({
      content: [{ text: "New" }],
    });
  });

  it("promotes the active session immediately when a prompt is sent", async () => {
    const stream = new FakeEventSource();
    const olderSession = { ...session, id: "session-older", title: "Older session" };
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [olderSession, session],
      activeSessionId: session.id,
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const command = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-prompt",
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
    await waitUntil(() => client.getSnapshot().sessions.length === 2);

    client.sendPrompt("Move this thread to the top");

    expect(client.getSnapshot().sessions.map((candidate) => candidate.id)).toEqual([
      session.id,
      olderSession.id,
    ]);
    expect(client.getSnapshot().sessions[0]?.updatedAt).not.toBe(session.updatedAt);
    expect(client.getSnapshot().timelines[session.id]?.at(-1)).toMatchObject({
      id: expect.stringMatching(/^optimistic-/),
      kind: "message",
      role: "user",
      status: "streaming",
      content: [{ type: "text", text: "Move this thread to the top" }],
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
      const sent = bodies.at(-1) as { id: string; payload: { sessionId: string } };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-create",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: true,
        outcome: "completed",
        data: { sessionId: sent.payload.sessionId },
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.createSession("other");
    await waitUntil(() => bodies.length === 1);

    const sent = bodies[0] as { payload: { sessionId: string } };
    expect(client.getSnapshot().activeSessionId).toBe(sent.payload.sessionId);
    expect(client.getSnapshot().sessions[0]).toMatchObject({
      id: sent.payload.sessionId,
      projectId: "other",
      title: "New session",
    });
    expect(bodies[0]).toMatchObject({
      type: "session.create",
      sessionId: null,
      payload: { projectId: "other", sessionId: expect.any(String) },
    });
  });

  it("queues an immediate prompt until a new thread is acknowledged", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const snapshot = createEmptySnapshot({ projects: [project], sessions: [session] });
    const commands: Array<{ id: string; type: string; sessionId: string | null; payload: Record<string, string> }> = [];
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as (typeof commands)[number];
      commands.push(sent);
      if (sent.type === "session.create") return createResponse;
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-prompt-after-create",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:02.000Z",
        success: true,
        outcome: "completed",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.createSession(project.id);
    await waitUntil(() => commands.length === 1);
    const sessionId = commands[0]!.payload.sessionId!;
    client.sendPrompt("Start immediately");
    expect(commands.map((command) => command.type)).toEqual(["session.create"]);

    resolveCreate(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-create-before-prompt",
      commandId: commands[0]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
      data: { sessionId },
    })));
    await waitUntil(() => commands.length === 2);

    expect(commands[1]).toMatchObject({
      type: "prompt.send",
      sessionId,
      payload: { content: "Start immediately", delivery: "prompt" },
    });
  });

  it("drains multiple prompts in FIFO order", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session],
      activeSessionId: session.id,
    });
    const prompts: Array<{ id: string; payload: { content: string } }> = [];
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as (typeof prompts)[number];
      prompts.push(sent);
      if (prompts.length === 1) return firstResponse;
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-second-prompt",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:02.000Z",
        success: true,
        outcome: "completed",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.sendPrompt("First");
    client.sendPrompt("Second");
    await waitUntil(() => prompts.length === 1);
    expect(prompts.map((prompt) => prompt.payload.content)).toEqual(["First"]);

    resolveFirst(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-first-prompt",
      commandId: prompts[0]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
    })));
    await waitUntil(() => prompts.length === 2);
    expect(prompts.map((prompt) => prompt.payload.content)).toEqual(["First", "Second"]);
  });

  it("does not let a delayed create response override a newer thread selection", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const otherSession = { ...session, id: "session-other", title: "Other session" };
    let createdSession: SessionSummary | undefined;
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    let createCommandId = "";
    let createCompleted = false;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        const snapshot = createEmptySnapshot({
          projects: [project],
          sessions: [session, otherSession],
          activeSessionId: session.id,
        });
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string; payload: { sessionId: string } };
      createCommandId = sent.id;
      createdSession = { ...session, id: sent.payload.sessionId, title: "New session" };
      const response = await createResponse;
      createCompleted = true;
      return response;
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 2);

    client.createSession(project.id);
    await waitUntil(() => Boolean(createCommandId));
    expect(client.getSnapshot().activeSessionId).toBe(createdSession!.id);
    client.selectSession(otherSession.id);
    resolveCreate(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-create-delayed",
      commandId: createCommandId,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
      data: { sessionId: createdSession!.id },
    })));
    await waitUntil(() => createCompleted);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event: AnvilEvent = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-created",
      sequence: 1,
      sessionId: createdSession!.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.upserted",
      payload: { session: createdSession! },
    };
    stream.emit("anvil", JSON.stringify(event));

    expect(client.getSnapshot().activeSessionId).toBe(otherSession.id);
  });

  it("preserves an optimistic session while bootstrap wins the create race", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    let bootstrapCount = 0;
    let commandId = "";
    let createdSessionId = "";
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        bootstrapCount++;
        const snapshot = { ...createEmptySnapshot({ projects: [project], sessions: [session] }), activeSessionId: null };
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string; payload: { sessionId: string } };
      commandId = sent.id;
      createdSessionId = sent.payload.sessionId;
      return createResponse;
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);
    client.createSession(project.id);
    await waitUntil(() => Boolean(commandId) && stream.listeners.has("reset"));

    stream.emit("reset", "{}");
    await waitUntil(() => bootstrapCount === 2 && client.getSnapshot().sessions.length === 2);

    expect(client.getSnapshot().activeSessionId).toBe(createdSessionId);
    expect(client.isSessionPending(createdSessionId)).toBe(true);

    resolveCreate(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-create-race",
      commandId,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
      data: { sessionId: createdSessionId },
    })));
    await waitUntil(() => !client.isSessionPending(createdSessionId));
  });

  it("waits for optimistic creation before deleting the new session", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const snapshot = createEmptySnapshot({ projects: [project], sessions: [session] });
    const commands: Array<{ id: string; type: string; payload: { sessionId: string } }> = [];
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as (typeof commands)[number];
      commands.push(sent);
      if (sent.type === "session.create") return createResponse;
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-delete-after-create",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:02.000Z",
        success: true,
        outcome: "completed",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.createSession(project.id);
    await waitUntil(() => commands.length === 1);
    const createdSessionId = commands[0]!.payload.sessionId;
    const deletion = client.deleteSession(createdSessionId);
    expect(commands.map((command) => command.type)).toEqual(["session.create"]);

    resolveCreate(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-create-before-delete",
      commandId: commands[0]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
      data: { sessionId: createdSessionId },
    })));
    await deletion;

    expect(commands.map((command) => command.type)).toEqual(["session.create", "session.delete"]);
    expect(commands[1]!.payload.sessionId).toBe(createdSessionId);
  });

  it("keeps a failed optimistic session available until the user removes it", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const snapshot = createEmptySnapshot({
      projects: [project],
      sessions: [session],
      activeSessionId: session.id,
    });
    let createdSessionId = "";
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string; payload: { sessionId: string } };
      createdSessionId = sent.payload.sessionId;
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-create-rejected",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: false,
        outcome: "completed",
        error: "Workspace is unavailable",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.createSession(project.id);
    expect(client.getSnapshot().activeSessionId).toBe(createdSessionId);
    expect(client.isSessionPending(createdSessionId)).toBe(true);

    await waitUntil(() => client.getSnapshot().clientError === "Workspace is unavailable");
    expect(client.getSnapshot().sessions[0]).toMatchObject({
      id: createdSessionId,
      status: "failed",
    });
    expect(client.getSnapshot().activeSessionId).toBe(createdSessionId);
    expect(client.isSessionPending(createdSessionId)).toBe(false);
    expect(client.getSessionCreationError(createdSessionId)).toBe("Workspace is unavailable");

    await client.deleteSession(createdSessionId);
    expect(client.getSnapshot().sessions.map((candidate) => candidate.id)).toEqual([session.id]);
    expect(client.getSnapshot().activeSessionId).toBe(session.id);
  });

  it("sends workspace creation, settlement, and session deletion commands", async () => {
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
      const sent = bodies.at(-1) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: `response-${bodies.length}`,
        commandId: sent.id,
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

    client.createProject("Tools", "/home/oli/code/tools");
    client.setSessionSettled(session.id, true);
    client.deleteSession(session.id);
    await waitUntil(() => bodies.length === 3);

    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "project.create", sessionId: null, payload: { name: "Tools", path: "/home/oli/code/tools" } }),
      expect.objectContaining({ type: "session.settled", sessionId: session.id, payload: { settled: true } }),
      expect.objectContaining({ type: "session.delete", sessionId: null, payload: { sessionId: session.id } }),
    ]));
  });

  it("returns Forge action failures to confirmation dialogs", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({ projects: [], sessions: [] });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-failed",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: false,
        outcome: "completed",
        error: "Workspace path does not exist",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().connection === "connected");

    await expect(client.createProject("Missing", "/missing")).rejects.toThrow("Workspace path does not exist");
    expect(client.getSnapshot().clientError).toBe("Workspace path does not exist");
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
