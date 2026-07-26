import { describe, expect, it } from "vitest";

import { shouldApplyTerminalEvent } from "./TerminalViewport";

describe("terminal viewport sequence handling", () => {
  it("treats every reattach snapshot as authoritative across Forge epochs", () => {
    expect(shouldApplyTerminalEvent(900, { type: "terminal.snapshot", sequence: 4 })).toBe(true);
    expect(shouldApplyTerminalEvent(900, { type: "terminal.output", sequence: 4 })).toBe(false);
    expect(shouldApplyTerminalEvent(4, { type: "terminal.output", sequence: 5 })).toBe(true);
  });
});
