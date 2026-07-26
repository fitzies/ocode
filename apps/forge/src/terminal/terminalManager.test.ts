import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventProjectResolver } from "../projects/projectResolver.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { TerminalHistoryStore, TERMINAL_HISTORY_LIMITS } from "./historyStore.ts";
import type { PtyAdapter, PtyExitEvent, PtyProcess, PtySpawnOptions } from "./ptyAdapter.ts";
import { TerminalManager } from "./terminalManager.ts";

class FakePty implements PtyProcess {
  readonly pid: number;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: string[] = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(pid: number) { this.pid = pid; }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    this.emitExit({ exitCode: 0, signal: signal === "SIGTERM" ? 15 : 9 });
  }
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exitListeners.add(listener); return { dispose: () => this.exitListeners.delete(listener) }; }
  emitData(data: string) { for (const listener of [...this.dataListeners]) listener(data); }
  emitExit(event: PtyExitEvent) { for (const listener of [...this.exitListeners]) listener(event); }
}

class FakePtyAdapter implements PtyAdapter {
  readonly processes: FakePty[] = [];
  readonly options: PtySpawnOptions[] = [];
  spawn(options: PtySpawnOptions): PtyProcess {
    this.options.push(options);
    const process = new FakePty(1_000 + this.processes.length);
    this.processes.push(process);
    return process;
  }
}

let directory: string;
let database: ForgeDatabase;
let events: ForgeEventService;
let history: TerminalHistoryStore;
let adapter: FakePtyAdapter;
let manager: TerminalManager;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anvil-terminal-"));
  database = new ForgeDatabase(join(directory, "forge.sqlite"));
  events = new ForgeEventService(database, [{ id: "project-a", name: "A", path: directory }]);
  history = new TerminalHistoryStore(join(directory, "history"));
  adapter = new FakePtyAdapter();
  manager = new TerminalManager(database, new EventProjectResolver(events), history, adapter);
});

afterEach(async () => {
  await manager.stopAll();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("TerminalManager", () => {
  it("opens at the canonical project root and owns input and resize", () => {
    const terminal = manager.open("project-a");
    manager.write("project-a", terminal.terminalId, "echo hello\r");
    manager.resize("project-a", terminal.terminalId, 120, 40);

    expect(adapter.options[0]).toMatchObject({ cwd: directory, cols: 80, rows: 24 });
    expect(adapter.processes[0]!.writes).toEqual(["echo hello\r"]);
    expect(adapter.processes[0]!.resizes).toEqual([[120, 40]]);
    expect(() => manager.open("missing")).toThrow("not configured");
  });

  it("subscribes before snapshot and flushes only newer buffered output", () => {
    const terminal = manager.open("project-a");
    adapter.processes[0]!.emitData("before\n");
    const originalSnapshot = history.snapshot.bind(history);
    let emittedDuringSnapshot = false;
    history.snapshot = (file) => {
      if (!emittedDuringSnapshot) {
        emittedDuringSnapshot = true;
        adapter.processes[0]!.emitData("during\n");
      }
      return originalSnapshot(file);
    };
    const live: string[] = [];
    const attachment = manager.attach("project-a", terminal.terminalId, "attach-1", (event) => {
      if (event.type === "terminal.output") live.push(event.data);
    });

    expect(attachment.snapshot.history).toBe("before\nduring\n");
    expect(attachment.snapshot.sequence).toBe(2);
    attachment.start();
    expect(live).toEqual([]);
    adapter.processes[0]!.emitData("after\n");
    expect(live).toEqual(["after\n"]);
    attachment.dispose();
  });

  it("persists bounded private history and restores running records as interrupted", async () => {
    const terminal = manager.open("project-a");
    adapter.processes[0]!.emitData(`${"x".repeat(200)}\n`.repeat(6_000));
    history.flushAll();
    const record = database.listTerminalRecords("project-a")[0]!;
    const historyPath = join(history.root, record.historyFile);
    expect(statSync(historyPath).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(history.snapshot(record.historyFile))).toBeLessThanOrEqual(TERMINAL_HISTORY_LIMITS.bytes);

    database.upsertTerminalRecord({ ...record, metadata: { ...record.metadata, status: "running" } });
    const restarted = new TerminalManager(database, new EventProjectResolver(events), history, new FakePtyAdapter());
    expect(restarted.list("project-a")).toEqual([
      expect.objectContaining({ terminalId: terminal.terminalId, status: "interrupted" }),
    ]);
    await restarted.stopAll();
  });

  it("bounds inactive records during startup recovery", async () => {
    await manager.stopAll();
    for (let index = 0; index < 35; index++) {
      const terminalId = randomUUID();
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      database.upsertTerminalRecord({
        metadata: {
          projectId: "project-a",
          terminalId,
          label: `Old ${index}`,
          status: "interrupted",
          createdAt: timestamp,
          updatedAt: timestamp,
          sequence: 0,
          rows: 24,
          cols: 80,
        },
        historyFile: history.historyFile("project-a", terminalId),
        historyVersion: 1,
      });
    }
    manager = new TerminalManager(database, new EventProjectResolver(events), history, adapter);
    expect(manager.list("project-a")).toHaveLength(32);
  });

  it("bounds shutdown even when a PTY ignores both termination signals", async () => {
    vi.useFakeTimers();
    try {
      const terminal = manager.open("project-a");
      const process = adapter.processes[0]!;
      process.kill = (signal = "SIGTERM") => { process.kills.push(signal); };
      const stopped = manager.stopAll();
      await vi.advanceTimersByTimeAsync(2_500);
      await stopped;

      expect(process.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(manager.list("project-a")).toEqual([
        expect.objectContaining({ terminalId: terminal.terminalId, status: "interrupted" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps PTYs alive without attachments and terminates them during shutdown", async () => {
    const terminal = manager.open("project-a");
    const attachment = manager.attach("project-a", terminal.terminalId, "attach-1", () => undefined);
    attachment.start();
    attachment.dispose();

    expect(manager.list("project-a")[0]?.status).toBe("running");
    await manager.stopAll();
    expect(adapter.processes[0]!.kills).toContain("SIGTERM");
    expect(manager.list("project-a")[0]?.status).toBe("interrupted");
  });
});
