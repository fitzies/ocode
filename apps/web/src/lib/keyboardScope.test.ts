import { describe, expect, it } from "vitest";

import {
  isMacPlatform,
  isTerminalToggleShortcut,
  threadCycleShortcut,
  threadNumberShortcutIndex,
} from "./keyboardScope";

const shortcut = (overrides: Partial<Parameters<typeof isTerminalToggleShortcut>[0]> = {}) => ({
  altKey: false,
  code: "Backquote",
  ctrlKey: true,
  key: "`",
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("thread keyboard shortcuts", () => {
  it("uses Command+1–9 on macOS and Control+1–9 elsewhere", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(threadNumberShortcutIndex(shortcut({ code: "Digit4", ctrlKey: false, key: "4", metaKey: true }), "MacIntel")).toBe(3);
    expect(threadNumberShortcutIndex(shortcut({ code: "Digit4", key: "4" }), "MacIntel")).toBeUndefined();
    expect(threadNumberShortcutIndex(shortcut({ code: "Digit4", key: "4" }), "Linux x86_64")).toBe(3);
    expect(threadNumberShortcutIndex(shortcut({ code: "Digit4", ctrlKey: false, key: "4", metaKey: true }), "Linux x86_64")).toBeUndefined();
  });

  it("cycles forward and backward with Control+Tab", () => {
    expect(threadCycleShortcut(shortcut({ code: "Tab", key: "Tab" }))).toBe("next");
    expect(threadCycleShortcut(shortcut({ code: "Tab", key: "Tab", shiftKey: true }))).toBe("previous");
    expect(threadCycleShortcut(shortcut({ code: "Tab", key: "Tab", metaKey: true }))).toBeUndefined();
  });
});

describe("terminal keyboard shortcut", () => {
  it("recognizes Ctrl+Backquote without matching modified variants", () => {
    expect(isTerminalToggleShortcut(shortcut())).toBe(true);
    expect(isTerminalToggleShortcut(shortcut({ ctrlKey: false }))).toBe(false);
    expect(isTerminalToggleShortcut(shortcut({ metaKey: true }))).toBe(false);
    expect(isTerminalToggleShortcut(shortcut({ shiftKey: true, key: "~" }))).toBe(false);
  });
});
