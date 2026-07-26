import { describe, expect, it } from "vitest";

import { reconcileActiveTerminalId } from "./ProjectTerminalSurface";

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

describe("terminal tab reconciliation", () => {
  it("keeps the active terminal when available and falls back from stale state", () => {
    const terminals = [metadata(first), metadata(second)];
    expect(reconcileActiveTerminalId(second, terminals)).toBe(second);
    expect(reconcileActiveTerminalId(stale, terminals)).toBe(first);
    expect(reconcileActiveTerminalId(undefined, [])).toBeUndefined();
  });
});
