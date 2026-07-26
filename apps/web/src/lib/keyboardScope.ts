export function isTerminalInputTarget(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && Boolean(target.closest("[data-terminal-input='true']"));
}
