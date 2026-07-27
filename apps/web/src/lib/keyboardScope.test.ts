import { describe, expect, it } from "vitest";

import { isTerminalToggleShortcut } from "./keyboardScope";

const shortcut = (overrides: Partial<Parameters<typeof isTerminalToggleShortcut>[0]> = {}) => ({
  altKey: false,
  code: "Backquote",
  ctrlKey: true,
  key: "`",
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("terminal keyboard shortcut", () => {
  it("recognizes Ctrl+Backquote without matching modified variants", () => {
    expect(isTerminalToggleShortcut(shortcut())).toBe(true);
    expect(isTerminalToggleShortcut(shortcut({ ctrlKey: false }))).toBe(false);
    expect(isTerminalToggleShortcut(shortcut({ metaKey: true }))).toBe(false);
    expect(isTerminalToggleShortcut(shortcut({ shiftKey: true, key: "~" }))).toBe(false);
  });
});
