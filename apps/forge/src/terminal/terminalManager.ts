import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  ANVIL_TERMINAL_PROTOCOL_VERSION,
  type ShellTerminalMetadata,
  type TerminalServerMessage,
} from "@anvil/protocol";

import type { ProjectResolver } from "../projects/projectResolver.ts";
import { ForgeDatabase, type StoredTerminalRecord } from "../store/database.ts";
import { TerminalHistoryStore } from "./historyStore.ts";
import { NodePtyAdapter } from "./nodePtyAdapter.ts";
import type { PtyAdapter, PtyProcess } from "./ptyAdapter.ts";

const MAX_TERMINALS_PER_PROJECT = 8;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;
const TERMINATION_GRACE_MS = 1_500;
const TERMINATION_FORCE_MS = 750;
const MAX_INACTIVE_RECORDS_PER_PROJECT = 32;

type LiveTerminalEvent = Extract<TerminalServerMessage,
  { type: "terminal.output" | "terminal.exit" | "terminal.reset" }
>;

type RuntimeTerminal = {
  process: PtyProcess;
  record: StoredTerminalRecord;
  dataSubscription: { dispose(): void };
  exitSubscription: { dispose(): void };
  exit: Promise<void>;
  resolveExit(): void;
  stopping: boolean;
  interrupted: boolean;
  finalized: boolean;
};

export interface TerminalAttachment {
  snapshot: Extract<TerminalServerMessage, { type: "terminal.snapshot" }>;
  start(): void;
  dispose(): void;
}

function key(projectId: string, terminalId: string): string {
  return `${projectId}\0${terminalId}`;
}

function environment(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
}

export class TerminalManager extends EventEmitter {
  private readonly runtimes = new Map<string, RuntimeTerminal>();
  private readonly adapter: PtyAdapter;
  private shuttingDown = false;

  constructor(
    private readonly database: ForgeDatabase,
    private readonly projects: ProjectResolver,
    private readonly history: TerminalHistoryStore,
    adapter: PtyAdapter = new NodePtyAdapter(),
  ) {
    super();
    this.adapter = adapter;
    this.database.markRunningTerminalsInterrupted();
    for (const projectId of new Set(this.database.listTerminalRecords().map((record) => record.metadata.projectId))) {
      this.pruneInactive(projectId);
    }
  }

  list(projectId: string): ShellTerminalMetadata[] {
    if (!this.projects.resolveProject(projectId)) throw new Error("Project is not configured on Forge");
    return this.database.listTerminalRecords(projectId).map((record) => ({ ...record.metadata }));
  }

  open(projectId: string, label?: string): ShellTerminalMetadata {
    if (this.shuttingDown) throw new Error("Terminal service is shutting down");
    const project = this.projects.resolveProject(projectId);
    if (!project) throw new Error("Project is not configured on Forge");
    const existing = this.database.listTerminalRecords(projectId);
    this.assertCapacity(projectId);
    const terminalId = randomUUID();
    const now = new Date().toISOString();
    const record: StoredTerminalRecord = {
      metadata: {
        projectId,
        terminalId,
        label: label?.trim() || `Shell ${existing.length + 1}`,
        status: "running",
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
      },
      historyFile: this.history.historyFile(projectId, terminalId),
      historyVersion: 1,
    };
    this.spawn(project.path, record);
    this.emitMetadata(record.metadata);
    return { ...record.metadata };
  }

  restart(projectId: string, terminalId: string): ShellTerminalMetadata {
    if (this.runtimes.has(key(projectId, terminalId))) throw new Error("Terminal is already running");
    const project = this.projects.resolveProject(projectId);
    if (!project) throw new Error("Project is not configured on Forge");
    this.assertCapacity(projectId);
    const record = this.record(projectId, terminalId);
    record.metadata = {
      ...record.metadata,
      status: "running",
      updatedAt: new Date().toISOString(),
      exitCode: undefined,
      exitSignal: undefined,
    };
    this.spawn(project.path, record);
    this.emitMetadata(record.metadata);
    return { ...record.metadata };
  }

  write(projectId: string, terminalId: string, data: string): void {
    this.runtime(projectId, terminalId).process.write(data);
  }

  resize(projectId: string, terminalId: string, cols: number, rows: number): void {
    const runtime = this.runtime(projectId, terminalId);
    runtime.process.resize(cols, rows);
    runtime.record.metadata = {
      ...runtime.record.metadata,
      cols,
      rows,
      updatedAt: new Date().toISOString(),
    };
    this.database.upsertTerminalRecord(runtime.record);
    this.emitMetadata(runtime.record.metadata);
  }

  clear(projectId: string, terminalId: string): ShellTerminalMetadata {
    const record = this.record(projectId, terminalId);
    record.metadata = {
      ...record.metadata,
      sequence: record.metadata.sequence + 1,
      updatedAt: new Date().toISOString(),
    };
    this.history.clear(record.historyFile);
    this.database.upsertTerminalRecord(record);
    this.emitMetadata(record.metadata);
    const event: LiveTerminalEvent = {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.reset",
      terminal: { ...record.metadata },
      history: "",
      sequence: record.metadata.sequence,
      reason: "cleared",
    };
    this.emit("terminal", event);
    return { ...record.metadata };
  }

  async close(projectId: string, terminalId: string, deleteHistory = false): Promise<boolean> {
    const runtime = this.runtimes.get(key(projectId, terminalId));
    if (runtime) {
      runtime.stopping = true;
      await this.terminate(runtime, false);
    } else {
      this.record(projectId, terminalId);
    }
    if (deleteHistory) {
      const record = this.database.listTerminalRecords(projectId).find((candidate) => candidate.metadata.terminalId === terminalId);
      if (record) this.history.delete(record.historyFile);
      this.database.deleteTerminalRecord(projectId, terminalId);
      this.emit("metadata", {
        protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
        type: "terminal.metadata",
        projectId,
        terminalId,
        deleted: true,
      } satisfies Extract<TerminalServerMessage, { type: "terminal.metadata" }>);
      return true;
    }
    return false;
  }

  attach(
    projectId: string,
    terminalId: string,
    requestId: string,
    send: (event: LiveTerminalEvent) => void,
  ): TerminalAttachment {
    const buffered: LiveTerminalEvent[] = [];
    let live = false;
    let disposed = false;
    const listener = (event: LiveTerminalEvent) => {
      const metadata = event.type === "terminal.output"
        ? { projectId: event.projectId, terminalId: event.terminalId }
        : event.terminal;
      if (metadata.projectId !== projectId || metadata.terminalId !== terminalId || disposed) return;
      if (live) send(event);
      else buffered.push(event);
    };
    this.on("terminal", listener);
    const record = this.record(projectId, terminalId);
    const history = this.history.snapshot(record.historyFile);
    const sequence = record.metadata.sequence;
    const snapshot: TerminalAttachment["snapshot"] = {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.snapshot",
      requestId,
      terminal: { ...record.metadata },
      history,
      sequence,
    };
    return {
      snapshot,
      start: () => {
        if (disposed || live) return;
        live = true;
        for (const event of buffered) {
          const eventSequence = event.type === "terminal.output" ? event.sequence : event.terminal.sequence;
          if (eventSequence > sequence) send(event);
        }
        buffered.length = 0;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.off("terminal", listener);
      },
    };
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      runtime.stopping = true;
      runtime.interrupted = true;
    }
    await Promise.all(runtimes.map((runtime) => this.terminate(runtime, true)));
    this.history.flushAll();
  }

  private spawn(cwd: string, record: StoredTerminalRecord): void {
    const process = this.adapter.spawn({
      cwd,
      cols: record.metadata.cols,
      rows: record.metadata.rows,
      env: environment(),
    });
    record.metadata = { ...record.metadata, pid: process.pid };
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    const runtime: RuntimeTerminal = {
      process,
      record,
      dataSubscription: undefined!,
      exitSubscription: undefined!,
      exit,
      resolveExit,
      stopping: false,
      interrupted: false,
      finalized: false,
    };
    this.runtimes.set(key(record.metadata.projectId, record.metadata.terminalId), runtime);
    this.database.upsertTerminalRecord(record);
    runtime.dataSubscription = process.onData((data) => this.onData(runtime, data));
    runtime.exitSubscription = process.onExit((event) => this.onExit(runtime, event.exitCode, event.signal));
  }

  private onData(runtime: RuntimeTerminal, data: string): void {
    const metadata = runtime.record.metadata;
    if (metadata.status !== "running") return;
    metadata.sequence += 1;
    metadata.updatedAt = new Date().toISOString();
    this.history.append(runtime.record.historyFile, data);
    const event: LiveTerminalEvent = {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.output",
      projectId: metadata.projectId,
      terminalId: metadata.terminalId,
      sequence: metadata.sequence,
      data,
    };
    this.emit("terminal", event);
  }

  private onExit(runtime: RuntimeTerminal, exitCode: number, signal?: number): void {
    if (runtime.finalized) return;
    runtime.finalized = true;
    const metadata = runtime.record.metadata;
    runtime.dataSubscription.dispose();
    runtime.exitSubscription.dispose();
    this.runtimes.delete(key(metadata.projectId, metadata.terminalId));
    runtime.record.metadata = {
      ...metadata,
      status: runtime.interrupted ? "interrupted" : "exited",
      updatedAt: new Date().toISOString(),
      pid: undefined,
      exitCode: runtime.interrupted ? undefined : exitCode,
      exitSignal: signal,
    };
    this.database.upsertTerminalRecord(runtime.record);
    this.history.flushAll();
    this.emitMetadata(runtime.record.metadata);
    this.emit("terminal", {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.exit",
      terminal: { ...runtime.record.metadata },
    } satisfies LiveTerminalEvent);
    runtime.resolveExit();
    this.pruneInactive(metadata.projectId);
  }

  private async terminate(runtime: RuntimeTerminal, interrupted: boolean): Promise<void> {
    runtime.interrupted ||= interrupted;
    runtime.process.kill("SIGTERM");
    const exited = await this.waitForExit(runtime, TERMINATION_GRACE_MS);
    runtime.process.kill("SIGKILL");
    if (exited || await this.waitForExit(runtime, TERMINATION_FORCE_MS)) return;
    this.forceFinalize(runtime);
  }

  private waitForExit(runtime: RuntimeTerminal, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      runtime.exit.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  }

  private forceFinalize(runtime: RuntimeTerminal): void {
    if (runtime.finalized) return;
    runtime.finalized = true;
    runtime.dataSubscription.dispose();
    runtime.exitSubscription.dispose();
    const metadata = runtime.record.metadata;
    this.runtimes.delete(key(metadata.projectId, metadata.terminalId));
    runtime.record.metadata = {
      ...metadata,
      status: "interrupted",
      updatedAt: new Date().toISOString(),
      pid: undefined,
      exitCode: undefined,
      exitSignal: undefined,
    };
    this.database.upsertTerminalRecord(runtime.record);
    this.history.flushAll();
    this.emitMetadata(runtime.record.metadata);
    this.emit("terminal", {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.exit",
      terminal: { ...runtime.record.metadata },
    } satisfies LiveTerminalEvent);
    runtime.resolveExit();
    this.pruneInactive(metadata.projectId);
  }

  private pruneInactive(projectId: string): void {
    const inactive = this.database.listTerminalRecords(projectId)
      .filter((record) => record.metadata.status !== "running")
      .sort((left, right) => right.metadata.updatedAt.localeCompare(left.metadata.updatedAt));
    for (const record of inactive.slice(MAX_INACTIVE_RECORDS_PER_PROJECT)) {
      this.history.delete(record.historyFile);
      this.database.deleteTerminalRecord(projectId, record.metadata.terminalId);
      this.emit("metadata", {
        protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
        type: "terminal.metadata",
        projectId,
        terminalId: record.metadata.terminalId,
        deleted: true,
      } satisfies Extract<TerminalServerMessage, { type: "terminal.metadata" }>);
    }
  }

  private emitMetadata(terminal: ShellTerminalMetadata): void {
    this.emit("metadata", {
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.metadata",
      projectId: terminal.projectId,
      terminalId: terminal.terminalId,
      terminal: { ...terminal },
      deleted: false,
    } satisfies Extract<TerminalServerMessage, { type: "terminal.metadata" }>);
  }

  private assertCapacity(projectId: string): void {
    const running = this.database.listTerminalRecords(projectId)
      .filter((record) => record.metadata.status === "running").length;
    if (running >= MAX_TERMINALS_PER_PROJECT) {
      throw new Error(`A project may have at most ${MAX_TERMINALS_PER_PROJECT} running terminals`);
    }
  }

  private runtime(projectId: string, terminalId: string): RuntimeTerminal {
    const runtime = this.runtimes.get(key(projectId, terminalId));
    if (!runtime) throw new Error("Terminal is not running");
    return runtime;
  }

  private record(projectId: string, terminalId: string): StoredTerminalRecord {
    const runtime = this.runtimes.get(key(projectId, terminalId));
    if (runtime) return runtime.record;
    const record = this.database.listTerminalRecords(projectId)
      .find((candidate) => candidate.metadata.terminalId === terminalId);
    if (!record) throw new Error("Terminal not found");
    return record;
  }
}

export const TERMINAL_LIMITS = {
  perProject: MAX_TERMINALS_PER_PROJECT,
  rows: { min: 2, max: 500 },
  cols: { min: 2, max: 1_000 },
} as const;
