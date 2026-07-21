import type {
  ConnectionState,
  MessageEntry,
  ProjectSummary,
  SessionSummary,
  ThinkingEntry,
  TimelineEntry,
  ToolEntry,
} from "@anvil/protocol";

export interface AnvilSnapshot {
  connection: ConnectionState;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  activeSessionId: string;
  timelines: Record<string, TimelineEntry[]>;
}

export interface AnvilClient {
  getSnapshot(): AnvilSnapshot;
  subscribe(listener: () => void): () => void;
  selectSession(sessionId: string): void;
  createSession(): void;
  sendPrompt(content: string): void;
  cancelActiveRun(): void;
  setModel(model: string): void;
  cycleConnectionState(): void;
}

const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const initialSnapshot: AnvilSnapshot = {
  connection: "connected",
  activeSessionId: "anvil-shell",
  projects: [
    { id: "anvil", name: "anvil", path: "~/code/anvil" },
    { id: "pi", name: "pi-agent", path: "~/code/pi-agent" },
  ],
  sessions: [
    {
      id: "anvil-shell",
      projectId: "anvil",
      title: "Design the session shell",
      updatedAt: now(),
      status: "idle",
      model: "GPT-5.4",
    },
    {
      id: "reconnect-flow",
      projectId: "anvil",
      title: "Reliable reconnection states",
      updatedAt: minutesAgo(42),
      status: "waiting",
      model: "GPT-5.4",
    },
    {
      id: "rpc-notes",
      projectId: "anvil",
      title: "Pi RPC event mapping",
      updatedAt: minutesAgo(24 * 60),
      status: "idle",
      model: "GPT-5.3 Codex",
    },
    {
      id: "browser-qa",
      projectId: "pi",
      title: "Browser tool QA",
      updatedAt: minutesAgo(4 * 24 * 60),
      status: "failed",
      model: "GPT-5.3 Codex",
    },
  ],
  timelines: {
    "anvil-shell": [
      {
        id: "m1",
        kind: "message",
        role: "user",
        content:
          "Let’s focus on the first usable shell: projects, persistent conversations, and a composer that makes the current model and runtime state obvious.",
        createdAt: "2026-07-20T10:14:00.000Z",
      },
      {
        id: "t1",
        kind: "thinking",
        content: "Inspecting the product constraints and mapping the smallest complete session workflow.",
        createdAt: "2026-07-20T10:14:02.000Z",
      },
      {
        id: "tool1",
        kind: "tool",
        name: "read",
        summary: "Read AGENTS.md",
        detail: "64 lines · product scope and architecture",
        status: "completed",
        createdAt: "2026-07-20T10:14:03.000Z",
      },
      {
        id: "tool2",
        kind: "tool",
        name: "research",
        summary: "Reviewed T3 Code’s web interaction model",
        detail: "Sidebar, timeline, composer, connection states",
        status: "completed",
        createdAt: "2026-07-20T10:14:05.000Z",
      },
      {
        id: "m2",
        kind: "message",
        role: "assistant",
        content:
          "The strongest first version is deliberately narrow: a dependable conversation surface with enough system feedback to trust what Forge is doing. Keep project and session navigation persistent, let the timeline carry tool activity without becoming a log dump, and make the composer the single control point for prompting, steering, and stopping a run.",
        createdAt: "2026-07-20T10:14:08.000Z",
      },
    ],
    "reconnect-flow": [
      {
        id: "r1",
        kind: "message",
        role: "user",
        content: "What should remain visible if my laptop sleeps during a run?",
        createdAt: "2026-07-20T09:30:00.000Z",
      },
      {
        id: "r2",
        kind: "message",
        role: "assistant",
        content:
          "Keep the last durable timeline visible, mark it as potentially stale, and show reconnection as transport state—not as a replacement for the conversation. Once connected, reconcile events from the last acknowledged sequence number.",
        createdAt: "2026-07-20T09:30:05.000Z",
      },
    ],
    "rpc-notes": [],
    "browser-qa": [
      {
        id: "b1",
        kind: "tool",
        name: "browser",
        summary: "Open preview environment",
        detail: "Connection closed before the page became ready",
        status: "failed",
        createdAt: "2026-07-19T15:02:00.000Z",
      },
    ],
  },
};

export class MockAnvilClient implements AnvilClient {
  private snapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly pendingTimers = new Map<
    string,
    Array<ReturnType<typeof setTimeout>>
  >();

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  selectSession = (sessionId: string) => {
    if (sessionId === this.snapshot.activeSessionId) return;
    this.snapshot = { ...this.snapshot, activeSessionId: sessionId };
    this.emit();
  };

  createSession = () => {
    const id = `session-${Date.now()}`;
    const session: SessionSummary = {
      id,
      projectId: "anvil",
      title: "New session",
      updatedAt: now(),
      status: "idle",
      model: "GPT-5.4",
    };

    this.snapshot = {
      ...this.snapshot,
      activeSessionId: id,
      sessions: [session, ...this.snapshot.sessions],
      timelines: { ...this.snapshot.timelines, [id]: [] },
    };
    this.emit();
  };

  sendPrompt = (content: string) => {
    const prompt = content.trim();
    if (!prompt) return;

    const sessionId = this.snapshot.activeSessionId;
    const userEntry: MessageEntry = {
      id: `message-${Date.now()}`,
      kind: "message",
      role: "user",
      content: prompt,
      createdAt: now(),
    };
    const thinkingEntry: ThinkingEntry = {
      id: `thinking-${Date.now()}`,
      kind: "thinking",
      content: "Understanding the request and choosing the next action.",
      active: true,
      createdAt: now(),
    };

    this.updateSession(sessionId, { status: "running", updatedAt: now() });
    this.appendEntries(sessionId, userEntry, thinkingEntry);

    this.addTimer(
      sessionId,
      setTimeout(() => {
        this.replaceEntry(sessionId, thinkingEntry.id, { ...thinkingEntry, active: false });
        const toolEntry: ToolEntry = {
          id: `tool-${Date.now()}`,
          kind: "tool",
          name: "workspace",
          summary: "Reviewing the current project state",
          detail: "Mock tool activity",
          status: "running",
          createdAt: now(),
        };
        this.appendEntries(sessionId, toolEntry);

        this.addTimer(
          sessionId,
          setTimeout(() => {
            this.replaceEntry(sessionId, toolEntry.id, { ...toolEntry, status: "completed" });
            const response: MessageEntry = {
              id: `message-${Date.now()}`,
              kind: "message",
              role: "assistant",
              content:
                "I’ve captured that in the mock session. The real Forge client will use the same UI boundary, replacing these timed events with durable Pi RPC events from the backend.",
              createdAt: now(),
            };
            this.appendEntries(sessionId, response);
            this.updateSession(sessionId, { status: "idle" });
            this.pendingTimers.delete(sessionId);
          }, 900),
        );
      }, 750),
    );
  };

  cancelActiveRun = () => {
    const sessionId = this.snapshot.activeSessionId;
    this.pendingTimers.get(sessionId)?.forEach((timer) => clearTimeout(timer));
    this.pendingTimers.delete(sessionId);
    this.updateSession(sessionId, { status: "idle" });
    const timeline = this.snapshot.timelines[sessionId] ?? [];
    this.snapshot = {
      ...this.snapshot,
      timelines: {
        ...this.snapshot.timelines,
        [sessionId]: timeline.map((entry): TimelineEntry => {
          if (entry.kind === "thinking" && entry.active) return { ...entry, active: false };
          if (entry.kind === "tool" && entry.status === "running") {
            return { ...entry, status: "failed", detail: "Stopped by user" };
          }
          return entry;
        }),
      },
    };
    this.emit();
  };

  setModel = (model: string) => {
    this.updateSession(this.snapshot.activeSessionId, { model });
  };

  cycleConnectionState = () => {
    const connection =
      this.snapshot.connection === "connected"
        ? "reconnecting"
        : this.snapshot.connection === "reconnecting"
          ? "offline"
          : "connected";
    this.snapshot = { ...this.snapshot, connection };
    this.emit();
  };

  private addTimer(sessionId: string, timer: ReturnType<typeof setTimeout>) {
    this.pendingTimers.set(sessionId, [...(this.pendingTimers.get(sessionId) ?? []), timer]);
  }

  private appendEntries(sessionId: string, ...entries: TimelineEntry[]) {
    this.snapshot = {
      ...this.snapshot,
      timelines: {
        ...this.snapshot.timelines,
        [sessionId]: [...(this.snapshot.timelines[sessionId] ?? []), ...entries],
      },
    };
    this.emit();
  }

  private replaceEntry(sessionId: string, entryId: string, replacement: TimelineEntry) {
    this.snapshot = {
      ...this.snapshot,
      timelines: {
        ...this.snapshot.timelines,
        [sessionId]: (this.snapshot.timelines[sessionId] ?? []).map((entry) =>
          entry.id === entryId ? replacement : entry,
        ),
      },
    };
    this.emit();
  }

  private updateSession(sessionId: string, patch: Partial<SessionSummary>) {
    this.snapshot = {
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) =>
        session.id === sessionId ? { ...session, ...patch } : session,
      ),
    };
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const anvilClient = new MockAnvilClient();
