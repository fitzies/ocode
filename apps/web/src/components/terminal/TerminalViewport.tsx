import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { terminalClient } from "@/lib/terminalClient";

const TERMINAL_LINK_PATTERN = /https?:\/\/[^\s<>"']+|(?:localhost|(?:\d{1,3}\.){3}\d{1,3}):\d{1,5}(?:\/[^\s<>"']*)?/gi;
const TRAILING_LINK_PUNCTUATION = /[),.;:!?]+$/;

export interface TerminalLinkMatch {
  start: number;
  text: string;
  url: string;
}

export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  return Array.from(text.matchAll(TERMINAL_LINK_PATTERN), (match) => {
    const linkText = match[0].replace(TRAILING_LINK_PUNCTUATION, "");
    return {
      start: match.index,
      text: linkText,
      url: /^https?:\/\//i.test(linkText) ? linkText : `http://${linkText}`,
    };
  }).filter((match) => match.text.length > 0);
}

export function shouldApplyTerminalEvent(
  currentSequence: number,
  event: { type: "terminal.snapshot" | "terminal.reset" | "terminal.output"; sequence: number },
): boolean {
  return event.type === "terminal.snapshot" || event.sequence > currentSequence;
}

function xtermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--background", "#111111"),
    foreground: value("--foreground", "#eeeeee"),
    cursor: value("--foreground", "#eeeeee"),
    cursorAccent: value("--background", "#111111"),
    selectionBackground: `color-mix(in srgb, ${value("--foreground", "#eeeeee")} 22%, transparent)`,
    black: "#1d1f21",
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#666666",
    brightRed: "#d54e53",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
  };
}

export function TerminalViewport({
  projectId,
  terminalId,
}: {
  projectId: string;
  terminalId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Geist Mono Variable", "Geist Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    const linkProvider = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links = findTerminalLinks(text).map((match) => ({
          text: match.text,
          range: {
            start: { x: match.start + 1, y: bufferLineNumber },
            end: { x: match.start + match.text.length, y: bufferLineNumber },
          },
          activate(event: MouseEvent) {
            if (!event.metaKey && !event.ctrlKey) return;
            window.open(match.url, "_blank", "noopener,noreferrer");
          },
        }));
        callback(links.length > 0 ? links : undefined);
      },
    });
    let sequence = -1;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const fitAndResize = () => {
      if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (terminal.cols >= 2 && terminal.rows >= 2) {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => terminalClient.resize(projectId, terminalId, terminal.cols, terminal.rows), 80);
      }
    };
    const unsubscribe = terminalClient.subscribeTerminal(projectId, terminalId, (event) => {
      if (event.type === "terminal.snapshot" || event.type === "terminal.reset") {
        if (!shouldApplyTerminalEvent(sequence, event)) return;
        sequence = event.sequence;
        terminal.reset();
        terminal.write(event.history);
        requestAnimationFrame(fitAndResize);
      } else if (event.type === "terminal.output" && shouldApplyTerminalEvent(sequence, event)) {
        sequence = event.sequence;
        terminal.write(event.data);
      }
    });
    const data = terminal.onData((value) => terminalClient.write(projectId, terminalId, value));
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(container);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      themeObserver.disconnect();
      observer.disconnect();
      data.dispose();
      unsubscribe();
      linkProvider.dispose();
      fit.dispose();
      terminal.dispose();
    };
  }, [projectId, terminalId]);

  return (
    <div
      ref={containerRef}
      className="terminal-viewport"
      data-terminal-input="true"
      aria-label="Terminal input"
    />
  );
}
