export type ShortcutId =
  | "newThread" | "closeThread" | "search" | "terminal" | "toggleSidebar"
  | "nextThread" | "previousThread"
  | `thread${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type ShortcutMap = Record<ShortcutId, string>;

const STORAGE_KEY = "ocode.keyboard-shortcuts";

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  newThread: "Mod+KeyN",
  closeThread: "Mod+KeyW",
  search: "Mod+KeyK",
  terminal: "Ctrl+Backquote",
  toggleSidebar: "Mod+KeyB",
  nextThread: "Ctrl+Tab",
  previousThread: "Ctrl+Shift+Tab",
  thread1: "Mod+Digit1", thread2: "Mod+Digit2", thread3: "Mod+Digit3",
  thread4: "Mod+Digit4", thread5: "Mod+Digit5", thread6: "Mod+Digit6",
  thread7: "Mod+Digit7", thread8: "Mod+Digit8", thread9: "Mod+Digit9",
};

export function loadShortcuts(): ShortcutMap {
  try {
    return { ...DEFAULT_SHORTCUTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function saveShortcuts(shortcuts: ShortcutMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  window.dispatchEvent(new Event("ocode:shortcuts-changed"));
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return undefined;
  const modifiers = [
    event.metaKey || (event.ctrlKey && !event.metaKey) ? (event.metaKey ? "Mod" : "Ctrl") : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  return [...modifiers, event.code].join("+");
}

export function matchesShortcut(event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">, id: ShortcutId, platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  const chord = loadShortcuts()[id].split("+");
  const mod = chord.includes("Mod");
  const mac = /^(Mac|iPhone|iPad|iPod)/i.test(platform);
  return event.code === chord.at(-1)
    && event.metaKey === (mod && mac)
    && event.ctrlKey === (chord.includes("Ctrl") || (mod && !mac))
    && event.altKey === chord.includes("Alt")
    && event.shiftKey === chord.includes("Shift");
}

export function formatShortcutParts(chord: string): string[] {
  const mac = typeof navigator !== "undefined" && /^(Mac|iPhone|iPad|iPod)/i.test(navigator.platform);
  const names: Record<string, string> = { Mod: mac ? "⌘" : "Ctrl", Ctrl: mac ? "⌃" : "Ctrl", Alt: mac ? "⌥" : "Alt", Shift: mac ? "⇧" : "Shift", Backquote: "`", Tab: "Tab" };
  return chord.split("+").map((part) => names[part] ?? part.replace(/^(Key|Digit)/, ""));
}

export function formatShortcut(chord: string): string {
  return formatShortcutParts(chord).join("+");
}
