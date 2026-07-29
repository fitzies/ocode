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
  const match = /^Digit([1-9])$/.exec(event.code);
  if (!match || event.altKey || event.shiftKey) return undefined;

  const primaryModifierOnly = isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return primaryModifierOnly ? Number(match[1]) - 1 : undefined;
}

export function threadCycleShortcut(event: ShortcutEvent): "next" | "previous" | undefined {
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.code === "Tab" || event.key === "Tab")
  ) {
    return event.shiftKey ? "previous" : "next";
  }
  return undefined;
}

export function isTerminalToggleShortcut(
  event: ShortcutEvent,
): boolean {
  return event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === "Backquote" || event.key === "`");
}
