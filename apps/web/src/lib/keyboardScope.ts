import { matchesShortcut } from "./shortcuts";

export function isTerminalInputTarget(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && Boolean(target.closest("[data-terminal-input='true']"));
}

type ShortcutEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function threadNumberShortcutIndex(
  event: ShortcutEvent,
  platform?: string,
): number | undefined {
  for (let index = 1; index <= 9; index += 1) {
    if (matchesShortcut(event, `thread${index}` as Parameters<typeof matchesShortcut>[1], platform)) return index - 1;
  }
  return undefined;
}

export function threadCycleShortcut(event: ShortcutEvent): "next" | "previous" | undefined {
  if (matchesShortcut(event, "previousThread")) return "previous";
  if (matchesShortcut(event, "nextThread")) return "next";
  return undefined;
}

export function isTerminalToggleShortcut(
  event: ShortcutEvent,
): boolean {
  return matchesShortcut(event, "terminal");
}
