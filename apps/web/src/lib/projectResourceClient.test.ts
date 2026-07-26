import { ANVIL_PROTOCOL_VERSION, type AnvilEvent, type SessionSummary, type ToolEntry } from "@anvil/protocol";
import { createEmptySnapshot } from "@anvil/state";
import { describe, expect, it } from "vitest";

import { ForgeAnvilClient, type LiveProjectResourceCompletion } from "./anvilClient";

class FakeEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  emit(type: string, value: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close(): void {}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out");
}

const session: SessionSummary = {
  id: "session-1",
  projectId: "project-1",
  title: "Resource",
  updatedAt: "2026-07-23T01:00:00.000Z",
  status: "idle",
  modelId: "test/model",
  thinkingLevel: "off",
};

function tool(id: string, path: string): ToolEntry {
  return {
    id: `tool-${id}`,
    kind: "tool",
    toolCallId: id,
    name: "anvil_open_file",
    summary: "Open file",
    status: "completed",
    arguments: { path },
    output: [{ id: `resource-${id}`, type: "projectResource", path }],
    createdAt: session.updatedAt,
  };
}

describe("live project resource completions", () => {
  it("notifies once for a newly streamed completion and never for hydrated history", async () => {
    const stream = new FakeEventSource();
    const snapshot = {
      ...createEmptySnapshot({
        projects: [{ id: "project-1", name: "Project", path: "/repo" }],
        sessions: [session],
        activeSessionId: session.id,
      }),
      timelines: { [session.id]: [tool("historical", "README.md")] },
      lastSequence: 1,
    };
    const fetcher = async () => new Response(JSON.stringify({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      snapshot,
      events: [],
      cursor: 1,
    }));
    const client = new ForgeAnvilClient({
      fetch: fetcher as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    const completions: LiveProjectResourceCompletion[] = [];
    client.subscribeProjectResourceCompletions((completion) => completions.push(completion));
    await waitUntil(() => client.getSnapshot().lastSequence === 1);
    expect(completions).toEqual([]);

    const event: AnvilEvent = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-live",
      sequence: 2,
      sessionId: session.id,
      timestamp: "2026-07-23T01:00:02.000Z",
      type: "tool.completed",
      payload: {
        toolCallId: "live",
        status: "completed",
        output: [{ id: "resource-live", type: "projectResource", path: "src/main.ts", line: 4 }],
      },
    };
    stream.emit("anvil", event);
    stream.emit("anvil", event);

    expect(completions).toEqual([{
      sessionId: session.id,
      sequence: 2,
      toolCallId: "live",
      blocks: [{ id: "resource-live", type: "projectResource", path: "src/main.ts", line: 4 }],
    }]);
  });

  it("does not notify for failed or generic tool results", async () => {
    const stream = new FakeEventSource();
    const snapshot = createEmptySnapshot({ projects: [], sessions: [] });
    const client = new ForgeAnvilClient({
      fetch: (async () => new Response(JSON.stringify({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [], cursor: 0 }))) as typeof fetch,
      createEventSource: () => stream as unknown as EventSource,
    });
    const completions: LiveProjectResourceCompletion[] = [];
    client.subscribeProjectResourceCompletions((completion) => completions.push(completion));
    await waitUntil(() => client.getSnapshot().connection === "connected");
    stream.emit("anvil", {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "failed",
      sequence: 1,
      sessionId: "session-1",
      timestamp: session.updatedAt,
      type: "tool.completed",
      payload: { toolCallId: "failed", status: "failed", output: [{ id: "text", type: "text", text: "No" }] },
    });
    expect(completions).toEqual([]);
  });
});
