import { ANVIL_TERMINAL_PROTOCOL_VERSION, type TerminalServerMessage } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { TerminalClient } from "./terminalClient";

class FakeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(value: TerminalServerMessage) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const terminal = {
  projectId: "project-a",
  terminalId: "01959f7e-7d64-7000-8000-000000000001",
  label: "Shell 1",
  status: "running" as const,
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
  sequence: 0,
  rows: 24,
  cols: 80,
  pid: 42,
};

describe("TerminalClient", () => {
  it("reconciles project metadata and routes attach snapshots and live output", () => {
    const socket = new FakeSocket();
    const client = new TerminalClient(() => socket, "ws://test/api/v1/terminals/ws");
    const received: string[] = [];
    client.watchProject("project-a");
    client.subscribeTerminal("project-a", terminal.terminalId, (event) => received.push(event.type));
    socket.open();
    socket.message({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.list",
      requestId: "list-1",
      projectId: "project-a",
      terminals: [terminal],
    });
    socket.message({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.snapshot",
      requestId: "attach-1",
      terminal,
      history: "history\n",
      sequence: 0,
    });
    socket.message({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.output",
      projectId: "project-a",
      terminalId: terminal.terminalId,
      sequence: 1,
      data: "live\n",
    });

    expect(client.terminals("project-a")).toEqual([terminal]);
    expect(received).toEqual(["terminal.snapshot", "terminal.output"]);
    const sentTypes = socket.sent.map((item) => JSON.parse(item).type);
    expect(sentTypes.filter((type) => type === "terminal.list")).toHaveLength(1);
    expect(sentTypes.filter((type) => type === "terminal.attach")).toHaveLength(1);
  });

  it("rejects in-flight operations and drops stale input after disconnect", async () => {
    const socket = new FakeSocket();
    const client = new TerminalClient(() => socket, "ws://test/api/v1/terminals/ws");
    client.watchProject("project-a");
    socket.open();
    const pending = client.open("project-a");
    const sentBeforeClose = socket.sent.length;
    socket.close();
    client.write("project-a", terminal.terminalId, "secret\r");

    await expect(pending).rejects.toThrow("interrupted");
    expect(socket.sent).toHaveLength(sentBeforeClose);
  });

  it("correlates open requests and updates metadata", async () => {
    const socket = new FakeSocket();
    const client = new TerminalClient(() => socket, "ws://test/api/v1/terminals/ws");
    const pending = client.open("project-a");
    socket.open();
    const request = socket.sent.map((item) => JSON.parse(item)).find((item) => item.type === "terminal.open");
    socket.message({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.open",
      requestId: request.requestId,
      terminal,
    });

    await expect(pending).resolves.toEqual(terminal);
    expect(client.terminals("project-a")).toEqual([terminal]);
  });
});
