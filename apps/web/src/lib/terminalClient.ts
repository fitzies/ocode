import {
  ANVIL_TERMINAL_PROTOCOL_VERSION,
  isTerminalServerMessage,
  type ShellTerminalMetadata,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "@anvil/protocol";

export type TerminalConnectionState = "connecting" | "connected" | "offline";
export type TerminalStreamEvent = Extract<TerminalServerMessage,
  { type: "terminal.snapshot" | "terminal.output" | "terminal.reset" | "terminal.exit" }
>;

type SocketLike = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">;
type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const MAX_QUEUED_MESSAGES = 100;
const MAX_QUEUED_BYTES = 512 * 1024;
const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url);

export class TerminalClient {
  private socket?: SocketLike;
  private readonly queue: TerminalClientMessage[] = [];
  private readonly metadata = new Map<string, ShellTerminalMetadata[]>();
  private readonly listeners = new Set<() => void>();
  private readonly terminalListeners = new Map<string, Set<(event: TerminalStreamEvent) => void>>();
  private readonly pending = new Map<string, { resolve(message: TerminalServerMessage): void; reject(error: Error): void }>();
  private readonly watchedProjects = new Set<string>();
  private readonly attached = new Set<string>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 1_000;
  private state: TerminalConnectionState = "offline";

  constructor(
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly url = typeof window === "undefined"
      ? "ws://localhost/api/v1/terminals/ws"
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/v1/terminals/ws`,
  ) {}

  connectionState = () => this.state;
  terminals = (projectId: string) => this.metadata.get(projectId) ?? [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  watchProject(projectId: string): () => void {
    this.watchedProjects.add(projectId);
    this.connect();
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.list", requestId: crypto.randomUUID(), projectId }));
    }
    return () => this.watchedProjects.delete(projectId);
  }

  subscribeTerminal(projectId: string, terminalId: string, listener: (event: TerminalStreamEvent) => void): () => void {
    const id = `${projectId}\0${terminalId}`;
    const listeners = this.terminalListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.terminalListeners.set(id, listeners);
    if (!this.attached.has(id)) {
      this.attached.add(id);
      this.connect();
      if (this.socket?.readyState === OPEN) {
        this.socket.send(JSON.stringify({
          protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
          type: "terminal.attach",
          requestId: crypto.randomUUID(),
          projectId,
          terminalId,
        }));
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.terminalListeners.delete(id);
        this.attached.delete(id);
      }
    };
  }

  async open(projectId: string): Promise<ShellTerminalMetadata> {
    const response = await this.request({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.open", requestId: crypto.randomUUID(), projectId });
    if (response.type !== "terminal.open") throw new Error("Forge returned an unexpected terminal response");
    return response.terminal;
  }

  async restart(projectId: string, terminalId: string): Promise<ShellTerminalMetadata> {
    const response = await this.request({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.restart", requestId: crypto.randomUUID(), projectId, terminalId });
    if (response.type !== "terminal.restart") throw new Error("Forge returned an unexpected terminal response");
    return response.terminal;
  }

  async clear(projectId: string, terminalId: string): Promise<void> {
    await this.request({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.clear", requestId: crypto.randomUUID(), projectId, terminalId });
  }

  async close(projectId: string, terminalId: string): Promise<void> {
    await this.request({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.close",
      requestId: crypto.randomUUID(),
      projectId,
      terminalId,
      deleteHistory: true,
    });
  }

  write(projectId: string, terminalId: string, data: string): void {
    this.send({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.write", requestId: crypto.randomUUID(), projectId, terminalId, data }, false);
  }

  resize(projectId: string, terminalId: string, cols: number, rows: number): void {
    this.send({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.resize", requestId: crypto.randomUUID(), projectId, terminalId, cols, rows }, false);
  }

  private request(message: TerminalClientMessage): Promise<TerminalServerMessage> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject });
      this.send(message);
    });
  }

  private send(message: TerminalClientMessage, queueWhenOffline = true): void {
    this.connect();
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!queueWhenOffline) return;
    const bytes = this.queue.reduce((total, item) => total + JSON.stringify(item).length, 0) + JSON.stringify(message).length;
    if (this.queue.length >= MAX_QUEUED_MESSAGES || bytes > MAX_QUEUED_BYTES) {
      const pending = this.pending.get(message.requestId);
      pending?.reject(new Error("Terminal connection queue is full"));
      this.pending.delete(message.requestId);
      return;
    }
    this.queue.push(message);
  }

  private connect(): void {
    if (typeof WebSocket === "undefined" && this.socketFactory === defaultSocketFactory) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === OPEN)) return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retryMs = 1_000;
      this.setState("connected");
      const queued = this.queue.splice(0);
      for (const message of queued) socket.send(JSON.stringify(message));
      for (const projectId of this.watchedProjects) {
        socket.send(JSON.stringify({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.list", requestId: crypto.randomUUID(), projectId }));
      }
      for (const id of this.attached) {
        const [projectId, terminalId] = id.split("\0");
        socket.send(JSON.stringify({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.attach", requestId: crypto.randomUUID(), projectId, terminalId }));
      }
    });
    socket.addEventListener("message", (event) => this.onMessage(String((event as MessageEvent).data)));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.setState("offline");
      const disconnected = new Error("Terminal connection was interrupted; retry the operation");
      for (const pending of this.pending.values()) pending.reject(disconnected);
      this.pending.clear();
      this.queue.length = 0;
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  private onMessage(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!isTerminalServerMessage(value)) return;
    if (value.type === "terminal.error" && value.requestId) {
      this.pending.get(value.requestId)?.reject(new Error(value.message));
      this.pending.delete(value.requestId);
      return;
    }
    if ("requestId" in value && typeof value.requestId === "string") {
      this.pending.get(value.requestId)?.resolve(value);
      this.pending.delete(value.requestId);
    }
    if (value.type === "terminal.list") this.metadata.set(value.projectId, value.terminals);
    else if (value.type === "terminal.metadata") {
      if (value.deleted || !value.terminal) {
        this.metadata.set(value.projectId, this.terminals(value.projectId).filter((terminal) => terminal.terminalId !== value.terminalId));
      } else {
        this.upsert(value.terminal);
      }
    } else if (value.type === "terminal.close") {
      this.metadata.set(value.projectId, this.terminals(value.projectId).filter((terminal) => terminal.terminalId !== value.terminalId));
    } else if ("terminal" in value) {
      this.upsert(value.terminal);
    }
    if (["terminal.snapshot", "terminal.output", "terminal.reset", "terminal.exit"].includes(value.type)) {
      const event = value as TerminalStreamEvent;
      const projectId = event.type === "terminal.output" ? event.projectId : event.terminal.projectId;
      const terminalId = event.type === "terminal.output" ? event.terminalId : event.terminal.terminalId;
      for (const listener of this.terminalListeners.get(`${projectId}\0${terminalId}`) ?? []) listener(event);
    }
    this.emit();
  }

  private upsert(terminal: ShellTerminalMetadata): void {
    this.metadata.set(terminal.projectId, [
      ...this.terminals(terminal.projectId).filter((candidate) => candidate.terminalId !== terminal.terminalId),
      terminal,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  private setState(state: TerminalConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const terminalClient = new TerminalClient();
