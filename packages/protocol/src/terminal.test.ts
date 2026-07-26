import { describe, expect, it } from "vitest";

import {
  ANVIL_TERMINAL_PROTOCOL_VERSION,
  isTerminalClientMessage,
  isTerminalServerMessage,
  MAX_TERMINAL_INPUT_BYTES,
} from "./terminal.js";

const terminalId = "01959f7e-7d64-7000-8000-000000000001";

describe("terminal protocol", () => {
  it("validates project-scoped terminal operations and dimensions", () => {
    expect(isTerminalClientMessage({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.resize",
      requestId: "request-1",
      projectId: "project-a",
      terminalId,
      cols: 120,
      rows: 40,
    })).toBe(true);
    expect(isTerminalClientMessage({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.resize",
      requestId: "request-1",
      projectId: "project-a",
      terminalId,
      cols: 1,
      rows: 40,
    })).toBe(false);
  });

  it("rejects oversized terminal input", () => {
    expect(isTerminalClientMessage({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.write",
      requestId: "request-1",
      projectId: "project-a",
      terminalId,
      data: "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1),
    })).toBe(false);
  });

  it("validates snapshot and output server messages", () => {
    const terminal = {
      projectId: "project-a",
      terminalId,
      label: "Shell 1",
      status: "running",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z",
      sequence: 2,
      rows: 24,
      cols: 80,
      pid: 123,
    };
    expect(isTerminalServerMessage({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.snapshot",
      requestId: "request-1",
      terminal,
      history: "hello\n",
      sequence: 2,
    })).toBe(true);
    expect(isTerminalServerMessage({
      protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
      type: "terminal.output",
      projectId: "project-a",
      terminalId,
      sequence: 3,
      data: "world\n",
    })).toBe(true);
  });
});
