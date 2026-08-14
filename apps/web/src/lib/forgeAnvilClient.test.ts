import { ANVIL_PROTOCOL_VERSION, type AnvilEvent, type CapabilityCatalog, type SessionSummary } from "@anvil/protocol";
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

const sessionCatalog: CapabilityCatalog = {
  modelsReady: true,
  models: [{
    id: "test/model-1",
    provider: "test",
    name: "Model One",
    reasoning: true,
    input: ["text"],
    supportedThinkingLevels: ["off", "medium", "high", "xhigh"],
  }],
  commands: [],
  skills: [],
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

  it("opens a Forge-selected handoff thread", async () => {
    const stream = new FakeEventSource();
    const project = { id: "anvil", name: "Anvil", path: "/repo" };
    const otherSession = { ...session, id: "session-other", title: "Other work" };
    const snapshot = createEmptySnapshot({
      projects: [project],
      sessions: [session, otherSession],
      activeSessionId: session.id,
    });
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
    const clientViewingOtherWork = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().activeSessionId === session.id);
    await waitUntil(() => clientViewingOtherWork.getSnapshot().activeSessionId === session.id);
    clientViewingOtherWork.selectSession(otherSession.id);

    const handoffSession = {
      ...session,
      id: "session-handoff",
      title: "New session",
      updatedAt: "2026-07-23T01:00:01.000Z",
    };
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-handoff-created",
      sequence: 1,
      sessionId: handoffSession.id,
      timestamp: handoffSession.updatedAt,
      type: "session.upserted",
      payload: { session: handoffSession },
    } satisfies AnvilEvent));
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-handoff-selected",
      sequence: 2,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.selected",
      payload: { sessionId: handoffSession.id },
    } satisfies AnvilEvent));

    expect(client.getSnapshot()).toMatchObject({
      activeSessionId: handoffSession.id,
      workspaceLocation: { projectId: project.id, sessionId: handoffSession.id },
    });
    expect(clientViewingOtherWork.getSnapshot()).toMatchObject({
      activeSessionId: otherSession.id,
      workspaceLocation: { projectId: project.id, sessionId: otherSession.id },
    });
  });

  it("cancels a durable subagent and opens its internal child only after explicit navigation", async () => {
    const stream = new FakeEventSource();
    const run = {
      id: "run-1",
      parentSessionId: session.id,
      parentToolCallId: "tool-1",
      childSessionId: "child-1",
      role: "builder" as const,
      status: "running" as const,
      taskPreview: "Implement the focused patch",
      createdAt: session.updatedAt,
      updatedAt: session.updatedAt,
      startedAt: session.updatedAt,
    };
    const snapshot = {
      ...createEmptySnapshot({
        projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
        sessions: [session],
        activeSessionId: session.id,
      }),
      subagentRuns: { [session.id]: [run] },
    };
    const childDetail = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      sessionId: run.childSessionId,
      throughSequence: 0,
      timeline: [{
        id: "child-result", kind: "message", role: "assistant", content: [{ id: "text", type: "text", text: "Child detail" }],
        status: "complete", createdAt: session.updatedAt,
      }],
      catalog: { models: [], commands: [], skills: [] },
      pendingInteractions: [], extensionStatuses: [], widgets: [],
      queue: { steering: [], followUp: [] }, composerDraft: "", runState: "idle", subagentRuns: [],
    };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      if (url.includes(`/sessions/${run.childSessionId}/detail`)) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, mode: "reset", detail: childDetail }));
      }
      if (url.endsWith("/commands")) {
        const command = JSON.parse(String(init?.body)) as { type: string };
        expect(command.type).toBe("subagent.cancel");
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          id: "response-cancel",
          commandId: "cancel",
          timestamp: session.updatedAt,
          success: true,
          outcome: "completed",
          data: { ...run, status: "cancelled", endedAt: session.updatedAt },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ForgeAnvilClient({ fetch: fetcher as typeof fetch, createEventSource: () => stream as unknown as EventSource });
    await waitUntil(() => client.getSnapshot().subagentRuns[session.id]?.length === 1);

    await client.cancelSubagent(session.id, run.id);
    expect(client.getSnapshot().subagentRuns[session.id]?.[0]?.status).toBe("cancelled");
    expect(client.getSnapshot().sessions.some((candidate) => candidate.id === run.childSessionId)).toBe(false);

    await client.loadSubagentSession(session.id, run.id);
    expect(client.getSnapshot()).toMatchObject({
      activeSessionId: session.id,
      sessions: expect.arrayContaining([expect.objectContaining({ id: run.childSessionId, internal: true, parentSessionId: session.id })]),
    });
    expect(client.getSnapshot().timelines[run.childSessionId]?.[0]).toMatchObject({ content: [{ text: "Child detail" }] });

    await client.openSubagentSession(session.id, run.id);
    expect(client.getSnapshot().activeSessionId).toBe(run.childSessionId);
  });

  it("polls only an opened live child, performs one final terminal sync, and cleans up", async () => {
    const stream = new FakeEventSource();
    const run = {
      id: "run-live-child",
      parentSessionId: session.id,
      parentToolCallId: "tool-live-child",
      childSessionId: "child-live",
      role: "scout" as const,
      status: "running" as const,
      taskPreview: "Inspect live output",
      createdAt: session.updatedAt,
      updatedAt: session.updatedAt,
      startedAt: session.updatedAt,
    };
    const snapshot = {
      ...createEmptySnapshot({
        projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
        sessions: [session],
        activeSessionId: session.id,
      }),
      subagentRuns: { [session.id]: [run] },
    };
    let detailCalls = 0;
    let finalChildOutputAvailable = false;
    const detail = (text: string, throughSequence: number, terminal = false) => ({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "reset" as const,
      detail: {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        sessionId: run.childSessionId,
        throughSequence,
        timeline: [{
          id: "child-live-message", kind: "message", role: "assistant",
          content: [{ id: "child-live-text", type: "text", text }],
          status: terminal ? "complete" : "streaming", createdAt: session.updatedAt,
        }],
        catalog: { models: [], commands: [], skills: [] },
        pendingInteractions: [], extensionStatuses: [], widgets: [],
        queue: { steering: [], followUp: [] }, composerDraft: "", runState: terminal ? "idle" : "running", subagentRuns: [],
      },
    });
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          capturedAt: session.updatedAt,
          connection: "connected",
          projects: snapshot.projects,
          sessions: [session],
          cursor: 0,
        }));
      }
      if (url.includes(`/sessions/${run.childSessionId}/detail`)) {
        detailCalls++;
        return new Response(JSON.stringify(detail(
          finalChildOutputAvailable ? "Final child output" : detailCalls === 1 ? "Initial" : "Updated while open",
          detailCalls - 1,
          finalChildOutputAvailable,
        )));
      }
      if (url.includes(`/sessions/${session.id}/detail`)) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          mode: "reset",
          detail: {
            protocolVersion: ANVIL_PROTOCOL_VERSION,
            sessionId: session.id,
            throughSequence: 0,
            timeline: [], catalog: { models: [], commands: [], skills: [] },
            pendingInteractions: [], extensionStatuses: [], widgets: [],
            queue: { steering: [], followUp: [] }, composerDraft: "", runState: "idle", subagentRuns: [run],
          },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
      internalDetailPollMs: 5,
    });
    const unsubscribe = client.subscribe(() => undefined);
    await waitUntil(() => client.getSnapshot().subagentRuns[session.id]?.length === 1);
    expect(detailCalls).toBe(0);
    expect(client.getSnapshot().timelines[run.childSessionId]).toBeUndefined();

    await client.loadSubagentSession(session.id, run.id);
    expect(client.getSnapshot().activeSessionId).toBe(session.id);
    await waitUntil(() => {
      const entry = client.getSnapshot().timelines[run.childSessionId]?.[0];
      return entry?.kind === "message" && entry.content[0]?.type === "text" && entry.content[0].text === "Updated while open";
    });

    await client.openSubagentSession(session.id, run.id);
    client.selectSession(session.id);
    const afterNavigation = detailCalls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detailCalls).toBe(afterNavigation);

    await client.openSubagentSession(session.id, run.id);
    unsubscribe();
    const afterUnmount = detailCalls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detailCalls).toBe(afterUnmount);

    const unsubscribeAgain = client.subscribe(() => undefined);
    stream.onerror?.(new Event("error"));
    const afterOffline = detailCalls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detailCalls).toBe(afterOffline);

    stream.onopen?.(new Event("open"));
    finalChildOutputAvailable = true;
    const beforeTerminal = detailCalls;
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-child-terminal",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "subagent.updated",
      payload: { run: { ...run, status: "completed", updatedAt: "2026-07-23T01:00:02.000Z", endedAt: "2026-07-23T01:00:02.000Z" } },
    }));
    await waitUntil(() => {
      const entry = client.getSnapshot().timelines[run.childSessionId]?.[0];
      return entry?.kind === "message" &&
        entry.status === "complete" &&
        entry.content[0]?.type === "text" &&
        entry.content[0].text === "Final child output";
    });
    expect(detailCalls).toBe(beforeTerminal + 1);
    expect(client.getSnapshot()).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ id: run.childSessionId, status: "idle" })]),
      runStates: { [run.childSessionId]: "idle" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(detailCalls).toBe(beforeTerminal + 1);
    unsubscribeAgain();
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
            subagentRuns: [],
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

  it("replaces a stale cached subagent projection when an empty detail delta is authoritative", async () => {
    const stream = new FakeEventSource();
    const staleRun = {
      id: "run-stale",
      parentSessionId: session.id,
      parentToolCallId: "tool-stale",
      childSessionId: "child-stale",
      role: "builder" as const,
      status: "running" as const,
      taskPreview: "Finish the task",
      createdAt: session.updatedAt,
      updatedAt: session.updatedAt,
    };
    let detailRequests = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          capturedAt: session.updatedAt,
          connection: "connected",
          projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
          sessions: [session],
          cursor: 10,
        }));
      }
      if (url.includes("/detail")) {
        detailRequests++;
        if (detailRequests === 1) {
          return new Response(JSON.stringify({
            protocolVersion: ANVIL_PROTOCOL_VERSION,
            mode: "reset",
            detail: {
              protocolVersion: ANVIL_PROTOCOL_VERSION,
              sessionId: session.id,
              throughSequence: 10,
              timeline: [],
              catalog: { models: [], commands: [], skills: [] },
              pendingInteractions: [],
              extensionStatuses: [],
              widgets: [],
              queue: { steering: [], followUp: [] },
              composerDraft: "",
              runState: "idle",
              subagentRuns: [staleRun],
            },
          }));
        }
        expect(url).toContain("after=10");
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          mode: "delta",
          sessionId: session.id,
          fromSequence: 10,
          throughSequence: 10,
          events: [],
          subagentRuns: [{
            ...staleRun,
            status: "completed",
            updatedAt: "2026-07-23T01:00:02.000Z",
            completedAt: "2026-07-23T01:00:02.000Z",
          }],
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().subagentRuns[session.id]?.[0]?.status === "running");

    stream.emit("reset", "{}");

    await waitUntil(() => client.getSnapshot().subagentRuns[session.id]?.[0]?.status === "completed");
    expect(detailRequests).toBe(2);
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
        subagentRuns: [],
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

  it("promotes the active session when Forge accepts its prompt", async () => {
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

    expect(client.getSnapshot().sessions[0]?.lastUserMessageAt).toBeUndefined();
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-prompted",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.prompted",
      payload: {},
    }));

    expect(client.getSnapshot().sessions.map((candidate) => candidate.id)).toEqual([
      session.id,
      olderSession.id,
    ]);
    expect(client.getSnapshot().sessions[0]?.lastUserMessageAt).toBe("2026-07-23T01:00:01.000Z");
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
    expect(client.getSnapshot().sessions.find((candidate) => candidate.id === sessionId)?.title)
      .toBe("Start immediately");

    const createdSession = {
      ...session,
      id: sessionId,
      projectId: project.id,
      title: "New session",
    };
    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-created-before-prompt",
      sequence: 1,
      sessionId,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.upserted",
      payload: { session: createdSession },
    } satisfies AnvilEvent));
    await waitUntil(() => commands.length === 2);
    expect(client.getSnapshot().sessions.find((candidate) => candidate.id === sessionId)?.title)
      .toBe("Start immediately");

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-generated-title",
      sequence: 2,
      sessionId,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.configured",
      payload: { title: "Generated start title" },
    } satisfies AnvilEvent));
    expect(client.getSnapshot().sessions.find((candidate) => candidate.id === sessionId)?.title)
      .toBe("Generated start title");

    resolveCreate(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-create-before-prompt",
      commandId: commands[0]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
      data: { sessionId },
    })));

    expect(commands[1]).toMatchObject({
      type: "prompt.send",
      sessionId,
      payload: { content: "Start immediately", delivery: "prompt" },
    });
  });

  it("ignores a delayed provisional title event after the first prompt is rejected", async () => {
    const stream = new FakeEventSource();
    const rejectedSession = { ...session, title: "New session" };
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [rejectedSession],
      activeSessionId: rejectedSession.id,
    });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-prompt-rejected",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: false,
        outcome: "completed",
        error: "Prompt rejected",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    const accepted = client.sendPrompt("Rejected first prompt");
    expect(client.getSnapshot().sessions[0]?.title).toBe("Rejected first prompt");
    await expect(accepted).resolves.toBe(false);
    expect(client.getSnapshot().sessions[0]?.title).toBe("New session");

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-delayed-provisional-title",
      sequence: 1,
      sessionId: rejectedSession.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.configured",
      payload: { title: "Rejected first prompt", titleSource: "provisional" },
    } satisfies AnvilEvent));
    expect(client.getSnapshot().sessions[0]?.title).toBe("New session");

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-rollback-provisional-title",
      sequence: 2,
      sessionId: rejectedSession.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.configured",
      payload: { title: "New session" },
    } satisfies AnvilEvent));
    expect(client.getSnapshot().sessions[0]?.title).toBe("New session");
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

  it("detects and adds an existing project, then sends other project actions", async () => {
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
      const sent = bodies.at(-1) as { id: string; type: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: `response-${bodies.length}`,
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: true,
        outcome: "completed",
        ...(sent.type === "project.create" ? { data: { status: "existing", path: "/code/tools" } } : {}),
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    await expect(client.renameSession(session.id, "   ")).rejects.toThrow("non-empty");
    await expect(client.renameSession(session.id, "x".repeat(121))).rejects.toThrow("at most 120");
    await expect(client.createProject("Tools")).resolves.toEqual({ status: "existing", path: "/code/tools" });
    await client.cloneProject("private-tools", "organization/private-tools");
    await client.addExistingProject("Tools", "/code/tools");
    void client.renameSession(session.id, "  Renamed thread  ");
    void client.setSessionSettled(session.id, true);
    void client.deleteSession(session.id);
    void client.deleteProject("anvil");
    await waitUntil(() => bodies.length === 7);

    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "project.create", sessionId: null, payload: { name: "Tools" } }),
      expect.objectContaining({
        type: "project.clone",
        sessionId: null,
        payload: { name: "private-tools", repository: "organization/private-tools" },
      }),
      expect.objectContaining({ type: "project.addExisting", sessionId: null, payload: { name: "Tools", path: "/code/tools" } }),
      expect.objectContaining({ type: "session.rename", sessionId: session.id, payload: { title: "Renamed thread" } }),
      expect.objectContaining({ type: "session.settled", sessionId: session.id, payload: { settled: true } }),
      expect.objectContaining({ type: "session.delete", sessionId: null, payload: { sessionId: session.id } }),
      expect.objectContaining({ type: "project.delete", sessionId: null, payload: { projectId: "anvil" } }),
    ]));
  });

  it("propagates project clone command errors", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({ projects: [{ id: "anvil", name: "Anvil", path: "/repo" }] });
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-clone-failed",
        commandId: sent.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: false,
        outcome: "completed",
        error: "GitHub could not find that repository",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().projects.length === 1);

    await expect(client.cloneProject("Missing", "owner/missing"))
      .rejects.toThrow("GitHub could not find that repository");
  });

  it("sends read commands using the terminal sequence visible to the client", async () => {
    const stream = new FakeEventSource();
    const terminalSession = {
      ...session,
      lastTerminalSequence: 42,
      lastTerminalOutcome: "failed" as const,
      readThroughSequence: 0,
    };
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [terminalSession],
    });
    const bodies: Array<{ id: string; type: string; payload: unknown }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const sent = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(sent);
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

    client.markSessionRead(session.id);
    await waitUntil(() => bodies.length === 1);
    expect(bodies[0]).toMatchObject({
      type: "session.markRead",
      payload: { throughSequence: 42 },
    });

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-read-state",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "session.readState",
      payload: { readThroughSequence: 42 },
    }));
    client.markSessionUnread(session.id);
    await waitUntil(() => bodies.length === 2);
    expect(bodies[1]).toMatchObject({ type: "session.markUnread", payload: {} });
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

    await expect(client.createProject("Missing")).rejects.toThrow("Workspace path does not exist");
    expect(client.getSnapshot().clientError).toBe("Workspace path does not exist");
  });

  it("requests and parses GitHub repository pages and surfaces fixed endpoint errors", async () => {
    const repository = {
      nameWithOwner: "organization/private-tools",
      name: "private-tools",
      owner: "organization",
      private: true,
      updatedAt: "2026-07-23T01:00:00Z",
    };
    const requests: string[] = [];
    const success = new ForgeAnvilClient({
      autoConnect: false,
      fetch: (async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ repositories: [repository], page: 2, hasMore: true }));
      }) as typeof fetch,
    });
    await expect(success.listGitHubRepositories(2)).resolves.toEqual({
      repositories: [repository],
      page: 2,
      hasMore: true,
    });
    expect(requests).toEqual(["/api/v1/github/repositories?page=2"]);

    const invalid = new ForgeAnvilClient({
      autoConnect: false,
      fetch: (async () => new Response(JSON.stringify({
        repositories: [{ ...repository, private: "yes" }],
        page: 1,
        hasMore: false,
      }))) as typeof fetch,
    });
    await expect(invalid.listGitHubRepositories()).rejects.toThrow("invalid GitHub repository page");

    const wrongPage = new ForgeAnvilClient({
      autoConnect: false,
      fetch: (async () => new Response(JSON.stringify({ repositories: [], page: 2, hasMore: false }))) as typeof fetch,
    });
    await expect(wrongPage.listGitHubRepositories()).rejects.toThrow("invalid GitHub repository page");

    const failed = new ForgeAnvilClient({
      autoConnect: false,
      fetch: (async () => new Response(JSON.stringify({
        code: "gh_unauthenticated",
        message: "Forge's GitHub CLI is not authenticated. Run gh auth login on Forge and try again.",
      }), { status: 503 })) as typeof fetch,
    });
    await expect(failed.listGitHubRepositories()).rejects.toThrow("GitHub CLI is not authenticated");
  });

  it("fetches and updates the Forge projects root setting", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({
          protocolVersion: ANVIL_PROTOCOL_VERSION,
          snapshot: createEmptySnapshot(),
          events: [],
          cursor: 0,
        }));
      }
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ path: "/srv/projects" }));
      }
      return new Response(JSON.stringify({ path: "/code" }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => new FakeEventSource() as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().connection === "connected");

    await expect(client.getProjectsRoot()).resolves.toBe("/code");
    await expect(client.setProjectsRoot("  /srv/projects  ")).resolves.toBe("/srv/projects");
    expect(requests.at(-1)).toMatchObject({
      url: "/api/v1/settings/projects-root",
      init: {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ path: "/srv/projects" }),
      },
    });
  });

  it("updates thinking immediately and restores the confirmed level when Forge rejects it", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session],
      catalogs: { [session.id]: sessionCatalog },
    });
    const bodies: Array<{ id: string; type: string; payload: { level: string } }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      const command = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(command);
      return new Response(JSON.stringify({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "response-thinking-rejected",
        commandId: command.id,
        timestamp: "2026-07-23T01:00:01.000Z",
        success: false,
        outcome: "completed",
        error: "Thinking level is unavailable",
      }));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    client.setThinkingLevel(session.id, "" as never);
    client.setThinkingLevel(session.id, "max");
    client.setThinkingLevel(session.id, session.thinkingLevel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bodies).toHaveLength(0);

    client.setThinkingLevel(session.id, "high");
    expect(client.getSnapshot().sessions[0]?.thinkingLevel).toBe("high");
    await waitUntil(() => client.getSnapshot().clientError === "Thinking level is unavailable");

    expect(bodies[0]).toMatchObject({
      type: "thinking.set",
      payload: { level: "high" },
    });
    expect(client.getSnapshot().sessions[0]?.thinkingLevel).toBe("medium");
  });

  it("rolls rapid rejected thinking changes back to the last confirmed level", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session],
      catalogs: { [session.id]: sessionCatalog },
    });
    const commands: Array<{ id: string }> = [];
    const responses: Array<(response: Response) => void> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }));
      }
      commands.push(JSON.parse(String(init?.body)) as { id: string });
      return new Promise<Response>((resolve) => responses.push(resolve));
    };
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    await waitUntil(() => client.getSnapshot().sessions.length === 1);

    const reject = (index: number) => new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: `response-thinking-rejected-${index}`,
      commandId: commands[index]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: false,
      outcome: "completed",
      error: "Thinking level is unavailable",
    }));

    client.setThinkingLevel(session.id, "high");
    client.setThinkingLevel(session.id, "xhigh");
    await waitUntil(() => commands.length === 1);
    expect(client.getSnapshot().sessions[0]?.thinkingLevel).toBe("xhigh");

    stream.emit("anvil", JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-thinking-high",
      sequence: 1,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      type: "session.configured",
      payload: { thinkingLevel: "high" },
    } satisfies AnvilEvent));
    expect(client.getSnapshot().sessions[0]?.thinkingLevel).toBe("xhigh");

    responses[0]!(new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "response-thinking-high",
      commandId: commands[0]!.id,
      timestamp: "2026-07-23T01:00:01.000Z",
      success: true,
      outcome: "completed",
    })));
    await waitUntil(() => commands.length === 2);
    expect(client.getSnapshot().sessions[0]?.thinkingLevel).toBe("xhigh");

    responses[1]!(reject(1));
    await waitUntil(() => client.getSnapshot().sessions[0]?.thinkingLevel === "high");
  });

  it("sends only available model changes to the explicitly bound session", async () => {
    const stream = new FakeEventSource();
    const otherSession = { ...session, id: "session-2", title: "Other session" };
    const snapshot = createEmptySnapshot({
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session, otherSession],
      activeSessionId: otherSession.id,
      catalogs: {
        [session.id]: {
          modelsReady: true,
          models: [
            {
              id: "test/model-1",
              provider: "test",
              name: "Model One",
              reasoning: true,
              input: ["text"],
              supportedThinkingLevels: ["medium", "high"],
            },
            {
              id: "test/model-2",
              provider: "test",
              name: "Model Two",
              reasoning: true,
              input: ["text"],
              supportedThinkingLevels: ["medium", "high"],
            },
          ],
          commands: [],
          skills: [],
        },
        [otherSession.id]: { modelsReady: false, models: [], commands: [], skills: [] },
      },
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
    await waitUntil(() => client.getSnapshot().sessions.length === 2);
    expect(client.getSnapshot().activeSessionId).toBe(otherSession.id);
    client.setModel(session.id, "");
    client.setModel(session.id, "test/not-available");
    client.setModel(session.id, session.modelId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bodies).toHaveLength(0);

    client.setModel(session.id, "test/model-2");
    await waitUntil(() => bodies.length === 1);

    expect(bodies[0]).toMatchObject({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      sessionId: session.id,
      type: "model.set",
      payload: { modelId: "test/model-2" },
    });
  });
});
