import { describe, expect, it } from "vitest";

import { reconcileTerminalUiState, type TerminalGroup } from "./ProjectTerminalSurface";

const metadata = (terminalId: string) => ({
  projectId: "project-a",
  terminalId,
  label: terminalId,
  status: "running" as const,
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
  sequence: 0,
  rows: 24,
  cols: 80,
});

const first = "01959f7e-7d64-7000-8000-000000000001";
const second = "01959f7e-7d64-7000-8000-000000000002";
const stale = "01959f7e-7d64-7000-8000-000000000003";

describe("terminal UI reconciliation", () => {
  it("removes stale local panes and exposes terminals discovered on Forge", () => {
    const groups: TerminalGroup[] = [{ id: "group-1", terminalIds: [first, stale], direction: "vertical" }];
    const reconciled = reconcileTerminalUiState({
      groups,
      activeGroupId: "group-1",
      activeTerminalId: stale,
    }, [metadata(first), metadata(second)]);

    expect(reconciled.groups[0]).toEqual({ id: "group-1", terminalIds: [first], direction: "vertical" });
    expect(reconciled.groups.flatMap((group) => group.terminalIds)).toEqual([first, second]);
    expect(reconciled.activeTerminalId).toBe(first);
  });
});
