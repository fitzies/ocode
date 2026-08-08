import { describe, expect, it } from "vitest";

import { ACCENTS } from "./theme-provider";

const nodeFsSpecifier = "node:fs";
const { readFileSync } = await import(nodeFsSpecifier);
const baseStyles = readFileSync(new URL("../styles/base.css", import.meta.url), "utf8");
const composerStyles = readFileSync(new URL("../styles/composer.css", import.meta.url), "utf8");
const resourceStyles = readFileSync(new URL("../styles/resource.css", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
const terminalStyles = readFileSync(new URL("../styles/terminal.css", import.meta.url), "utf8");
const themeStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("appearance accents", () => {
  it("offers eight stable Tailwind color families", () => {
    expect(ACCENTS).toEqual([
      "neutral",
      "blue",
      "cyan",
      "emerald",
      "amber",
      "rose",
      "pink",
      "purple",
    ]);
  });

  it("drives the Send action while keeping its disabled state neutral", () => {
    expect(composerStyles).toMatch(/\.send-button\s*\{[^}]*color: var\(--primary-foreground\);[^}]*background: var\(--primary\);/s);
    expect(composerStyles).toMatch(/\.send-button:hover:not\(:disabled\)\s*\{[^}]*var\(--primary\)/s);
    expect(composerStyles).toMatch(/\.send-button:disabled\s*\{[^}]*background: var\(--accent\);/s);
  });

  it("uses restrained accent tints for hover and active surfaces without extra markers or recolored status UI", () => {
    expect(themeStyles).toContain("--primary-indicator: color-mix(in oklab, var(--primary) 65%, var(--foreground));");
    expect(baseStyles).toMatch(/\.session-row--active,[^{]*\{[^}]*background: color-mix\(in oklab, var\(--primary\) 7%, var\(--accent\)\);/s);
    expect(baseStyles).not.toContain(".session-row--active::before");
    expect(composerStyles).not.toContain(".model-select:not(.model-select--loading):not(:disabled)::before");
    expect(composerStyles).not.toContain(".thinking-level:not(:disabled)::before");
    expect(composerStyles).toMatch(/\.composer-tools \.model-select:hover:not\(:disabled\),[^{]*\{[^}]*background: color-mix\(in oklab, var\(--primary\) 9%, transparent\);/s);
    expect(shellStyles).toMatch(/\.session-header \.header-outline-control:hover\s*\{[^}]*background: color-mix\(in oklab, var\(--primary\) 9%, transparent\);/s);
    expect(resourceStyles).toMatch(/\.project-resource-tab--active\s*\{[^}]*border-color: var\(--primary-indicator\);/s);
    expect(terminalStyles).toContain(".terminal-tab--active:hover,");
    expect(terminalStyles).toMatch(/\.terminal-tab--active:focus-within\s*\{[^}]*box-shadow: inset 0 -2px var\(--primary-indicator\);/s);
    expect(shellStyles).toMatch(/\.header-outline-control\[aria-pressed="true"\][^{]*\{[^}]*box-shadow: inset 0 -2px var\(--primary-indicator\);/s);
    expect(baseStyles).toContain(".session-runtime--waiting { color: var(--amber); }");
    expect(terminalStyles).toContain(".terminal-status--running { background: var(--green); }");
  });
});
