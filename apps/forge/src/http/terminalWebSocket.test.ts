import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TerminalServerMessage } from "@anvil/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ForgeEventService } from "../events/eventService.ts";
import { EventProjectResolver } from "../projects/projectResolver.ts";
import { ForgeDatabase } from "../store/database.ts";
import { TerminalHistoryStore } from "../terminal/historyStore.ts";
import type { PtyAdapter, PtyExitEvent, PtyProcess } from "../terminal/ptyAdapter.ts";
import { TerminalManager } from "../terminal/terminalManager.ts";
import { ForgeHttpServer } from "./server.ts";
import { TERMINAL_WEBSOCKET_LIMITS } from "./terminalWebSocket.ts";

class TestPty implements PtyProcess {
  readonly pid = 404;
  private data = new Set<(data: string) => void>();
  private exits = new Set<(event: PtyExitEvent) => void>();
  write() {}
  resize() {}
  kill() { for (const listener of [...this.exits]) listener({ exitCode: 0, signal: 15 }); }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  emit(value: string) { for (const listener of [...this.data]) listener(value); }
}

let directory: string;
let database: ForgeDatabase;
let terminal: TerminalManager;
let pty: TestPty;
let server: ForgeHttpServer;
let url: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "anvil-terminal-ws-"));
  database = new ForgeDatabase(":memory:");
  const events = new ForgeEventService(database, [{ id: "project-a", name: "A", path: directory }]);
  pty = new TestPty();
  terminal = new TerminalManager(
    database,
    new EventProjectResolver(events),
    new TerminalHistoryStore(join(directory, "history")),
    { spawn: () => pty } satisfies PtyAdapter,
  );
  server = new ForgeHttpServer({ events, terminals: terminal, ownerLogin: "owner@example.com" });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  url = `ws://127.0.0.1:${address.port}/api/v1/terminals/ws`;
});

afterEach(async () => {
  await Promise.all([server.close(), terminal.stopAll()]);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function connect(headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<TerminalServerMessage> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()) as TerminalServerMessage)));
}

function rejected(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.destroy();
    });
    socket.once("open", () => reject(new Error("WebSocket was unexpectedly accepted")));
    socket.once("error", () => undefined);
  });
}

describe("terminal WebSocket channel", () => {
  it("requires exact owner identity and same-origin upgrades", async () => {
    await expect(rejected({ origin: new URL(url).origin })).resolves.toBe(403);
    await expect(rejected({
      "tailscale-user-login": "owner@example.com",
      origin: "https://evil.example.com",
    })).resolves.toBe(403);
  });

  it("opens, attaches, snapshots, and streams output on the dedicated channel", async () => {
    const origin = `http://${new URL(url).host}`;
    const socket = await connect({ "tailscale-user-login": "owner@example.com", origin });
    socket.send(JSON.stringify({ protocolVersion: 1, type: "terminal.open", requestId: "open-1", projectId: "project-a" }));
    const opened = await nextMessage(socket);
    expect(opened).toMatchObject({ type: "terminal.open", terminal: { projectId: "project-a", status: "running" } });
    if (opened.type !== "terminal.open") throw new Error("Expected open response");

    socket.send(JSON.stringify({
      protocolVersion: 1,
      type: "terminal.attach",
      requestId: "attach-1",
      projectId: "project-a",
      terminalId: opened.terminal.terminalId,
    }));
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "terminal.snapshot", history: "", sequence: 0 });
    const output = nextMessage(socket);
    pty.emit("hello\r\n");
    await expect(output).resolves.toMatchObject({ type: "terminal.output", sequence: 1, data: "hello\r\n" });
    socket.close();
  });

  it("broadcasts project terminal metadata to other watching clients", async () => {
    const headers = {
      "tailscale-user-login": "owner@example.com",
      origin: `http://${new URL(url).host}`,
    };
    const watcher = await connect(headers);
    watcher.send(JSON.stringify({ protocolVersion: 1, type: "terminal.list", requestId: "list-watch", projectId: "project-a" }));
    await nextMessage(watcher);

    const controller = await connect(headers);
    const metadata = nextMessage(watcher);
    controller.send(JSON.stringify({ protocolVersion: 1, type: "terminal.open", requestId: "open-other", projectId: "project-a" }));
    await expect(metadata).resolves.toMatchObject({
      type: "terminal.metadata",
      projectId: "project-a",
      deleted: false,
      terminal: { status: "running" },
    });
    watcher.close();
    controller.close();
  });

  it("bounds inbound frames and publishes an outbound backpressure limit", async () => {
    const origin = `http://${new URL(url).host}`;
    const socket = await connect({ "tailscale-user-login": "owner@example.com", origin });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send("x".repeat(TERMINAL_WEBSOCKET_LIMITS.frameBytes + 1));
    await expect(closed).resolves.toBe(1009);
    expect(TERMINAL_WEBSOCKET_LIMITS.bufferedBytes).toBe(512 * 1024);
  });
});
