import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const MAX_HISTORY_LINES = 5_000;
const MAX_HISTORY_BYTES = 512 * 1024;
const FLUSH_DELAY_MS = 100;

function boundHistory(value: string): string {
  let bounded = value;
  const lines = bounded.split(/(?<=\n)/);
  if (lines.length > MAX_HISTORY_LINES) bounded = lines.slice(-MAX_HISTORY_LINES).join("");
  let bytes = Buffer.byteLength(bounded);
  if (bytes <= MAX_HISTORY_BYTES) return bounded;
  const buffer = Buffer.from(bounded);
  let start = buffer.length - MAX_HISTORY_BYTES;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  bounded = buffer.subarray(start).toString("utf8");
  const newline = bounded.indexOf("\n");
  if (newline >= 0) bounded = bounded.slice(newline + 1);
  bytes = Buffer.byteLength(bounded);
  return bytes <= MAX_HISTORY_BYTES ? bounded : Buffer.from(bounded).subarray(bytes - MAX_HISTORY_BYTES).toString("utf8");
}

export class TerminalHistoryStore {
  private readonly cache = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  historyFile(projectId: string, terminalId: string): string {
    const projectKey = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
    return join(projectKey, `${terminalId}.log`);
  }

  snapshot(historyFile: string): string {
    const path = this.path(historyFile);
    if (this.cache.has(path)) return this.cache.get(path)!;
    let history = "";
    try {
      history = boundHistory(readFileSync(path, "utf8"));
    } catch {
      // Missing history starts empty.
    }
    this.cache.set(path, history);
    return history;
  }

  append(historyFile: string, data: string): void {
    const path = this.path(historyFile);
    this.cache.set(path, boundHistory(this.snapshot(historyFile) + data));
    this.schedule(path);
  }

  clear(historyFile: string): void {
    const path = this.path(historyFile);
    this.cache.set(path, "");
    this.flushPath(path);
  }

  delete(historyFile: string): void {
    const path = this.path(historyFile);
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.delete(path);
    this.cache.delete(path);
    rmSync(path, { force: true });
  }

  flushAll(): void {
    for (const path of this.cache.keys()) this.flushPath(path);
  }

  private schedule(path: string): void {
    if (this.timers.has(path)) return;
    const timer = setTimeout(() => this.flushPath(path), FLUSH_DELAY_MS);
    timer.unref();
    this.timers.set(path, timer);
  }

  private flushPath(path: string): void {
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.delete(path);
    const history = this.cache.get(path);
    if (history === undefined) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, history, { encoding: "utf8", mode: 0o600 });
  }

  private path(historyFile: string): string {
    const path = resolve(this.root, historyFile);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("Terminal history path escapes its private store");
    }
    return path;
  }
}

export const TERMINAL_HISTORY_LIMITS = {
  lines: MAX_HISTORY_LINES,
  bytes: MAX_HISTORY_BYTES,
} as const;
