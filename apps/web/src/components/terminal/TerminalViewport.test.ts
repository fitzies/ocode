import { describe, expect, it } from "vitest";

import { findTerminalLinks, shouldApplyTerminalEvent } from "./TerminalViewport";

describe("terminal link detection", () => {
  it("recognizes localhost and network IP addresses with ports", () => {
    expect(findTerminalLinks("Local: localhost:3000 Network: 100.64.0.8:4173")).toEqual([
      { start: 7, text: "localhost:3000", url: "http://localhost:3000" },
      { start: 31, text: "100.64.0.8:4173", url: "http://100.64.0.8:4173" },
    ]);
  });

  it("preserves explicit protocols and removes sentence punctuation", () => {
    expect(findTerminalLinks("Open https://192.168.1.5:3000/path.")[0]).toEqual({
      start: 5,
      text: "https://192.168.1.5:3000/path",
      url: "https://192.168.1.5:3000/path",
    });
  });
});

describe("terminal viewport sequence handling", () => {
  it("treats every reattach snapshot as authoritative across Forge epochs", () => {
    expect(shouldApplyTerminalEvent(900, { type: "terminal.snapshot", sequence: 4 })).toBe(true);
    expect(shouldApplyTerminalEvent(900, { type: "terminal.output", sequence: 4 })).toBe(false);
    expect(shouldApplyTerminalEvent(4, { type: "terminal.output", sequence: 5 })).toBe(true);
  });
});
