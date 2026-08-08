import { describe, expect, it } from "vitest";

import { DEFAULT_SHORTCUTS, formatShortcutParts, matchesShortcut } from "./shortcuts";

const unmodified = {
  altKey: false,
  code: "Comma",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("settings shortcut", () => {
  it("defaults to Cmd+, on Apple platforms", () => {
    expect(DEFAULT_SHORTCUTS.settings).toBe("Mod+Comma");
    expect(matchesShortcut({ ...unmodified, metaKey: true }, "settings", "MacIntel")).toBe(true);
    expect(matchesShortcut({ ...unmodified, ctrlKey: true }, "settings", "MacIntel")).toBe(false);
  });

  it("uses the platform Mod key and formats the comma glyph", () => {
    expect(matchesShortcut({ ...unmodified, ctrlKey: true }, "settings", "Win32")).toBe(true);
    expect(formatShortcutParts(DEFAULT_SHORTCUTS.settings).at(-1)).toBe(",");
  });
});
