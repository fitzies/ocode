import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { JsonlDecoder } from "./jsonl.ts";

export type RpcRecord = Record<string, unknown>;

export interface RpcSubprocessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  maxRecordBytes?: number;
}

interface PendingRequest {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcProcessError";
  }
}

export class RpcSubprocess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private stopped = false;

  constructor(private readonly options: RpcSubprocessOptions) {
    super();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.stopped;
  }

  start(): void {
    if (this.child) throw new RpcProcessError("RPC subprocess has already been started");

    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const decoder = new JsonlDecoder(
      (line) => this.handleLine(line),
      { maxRecordBytes: this.options.maxRecordBytes },
    );

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    child.stdout.on("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        this.fail(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.stopped = true;
      const error = new RpcProcessError(
        `RPC subprocess exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      );
      this.rejectPending(error);
      this.resolveExit();
      this.emit("exit", { code, signal });
    });
  }

  sendRequest<TRecord extends RpcRecord = RpcRecord>(record: RpcRecord): Promise<TRecord> {
    const id = typeof record.id === "string" && record.id ? record.id : randomUUID();
    if (this.pending.has(id)) {
      return Promise.reject(new RpcProcessError(`RPC request id is already pending: ${id}`));
    }

    return new Promise<TRecord>((resolve, reject) => {
      const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcProcessError(`RPC request timed out after ${timeoutMs}ms: ${String(record.type)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => resolve(response as TRecord),
        reject,
        timer,
      });
      try {
        this.write({ ...record, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new RpcProcessError(String(error)));
      }
    });
  }

  send(record: RpcRecord): void {
    this.write(record);
  }

  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.stopped = true;
    this.child.kill(signal);
  }

  async waitForExit(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    await this.exitPromise;
  }

  private write(record: RpcRecord): void {
    if (!this.child || !this.running || !this.child.stdin.writable) {
      throw new RpcProcessError("RPC subprocess is not running");
    }
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private handleLine(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      this.fail(new RpcProcessError("Pi emitted malformed JSON", { cause }));
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      this.fail(new RpcProcessError("Pi emitted a non-object RPC record"));
      return;
    }

    const typed = record as RpcRecord;
    this.emit("record", typed);
    if (typed.type !== "response" || typeof typed.id !== "string") return;
    const pending = this.pending.get(typed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(typed.id);
    pending.resolve(typed);
  }

  private fail(cause: unknown): void {
    const error = cause instanceof RpcProcessError
      ? cause
      : new RpcProcessError("RPC subprocess failed", { cause });
    this.emit("protocolError", error);
    this.rejectPending(error);
    if (this.child?.exitCode === null) this.child.kill("SIGKILL");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface PiRpcProcessOptions {
  executable?: string;
  cwd: string;
  sessionDir: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  maxRecordBytes?: number;
  extraArgs?: string[];
}

export function createPiRpcProcess(options: PiRpcProcessOptions): RpcSubprocess {
  return new RpcSubprocess({
    executable: options.executable ?? "pi",
    args: ["--mode", "rpc", "--session-dir", options.sessionDir, ...(options.extraArgs ?? [])],
    cwd: options.cwd,
    env: options.env,
    commandTimeoutMs: options.commandTimeoutMs,
    maxRecordBytes: options.maxRecordBytes,
  });
}
