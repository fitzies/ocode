import { OCODE_CONTEXT_CATEGORY_IDS, type ContextManifestV1 } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  allocateContextCells,
  ContextLens,
  formatContextTokens,
  presentContextCellTooltip,
  presentContextUsage,
} from "./ContextLens";

function manifest(): ContextManifestV1 {
  const totals: Partial<Record<(typeof OCODE_CONTEXT_CATEGORY_IDS)[number], number>> = {
    system: 20_000,
    tools: 10_000,
    user: 15_000,
    assistant: 20_000,
    toolOutput: 10_000,
    other: 5_000,
  };
  return {
    version: 1,
    capturedAt: 1_776_000_000_000,
    usage: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
    categories: OCODE_CONTEXT_CATEGORY_IDS.map((id) => ({ id, tokens: totals[id] ?? 0 })),
  };
}

describe("ContextLens", () => {
  it("formats context-sized token values compactly", () => {
    expect(formatContextTokens(76_400)).toBe("76.4k");
    expect(formatContextTokens(200_000)).toBe("200k");
    expect(formatContextTokens(1_000_000)).toBe("1m");
    expect(formatContextTokens(null)).toBe("—");
  });

  it("clamps malformed percentages and selects capacity tones", () => {
    expect(presentContextUsage({ tokens: 150_000, contextWindow: 200_000, percent: 75 })).toMatchObject({
      percent: 75,
      filledCells: 38,
      tone: "warning",
      remainingLabel: "50k",
    });
    expect(presentContextUsage({ tokens: 210_000, contextWindow: 200_000, percent: 105 })).toMatchObject({
      percent: 100,
      filledCells: 50,
      tone: "danger",
      remainingLabel: "0",
    });
  });

  it("represents unknown post-compaction usage as refreshing", () => {
    expect(presentContextUsage({ tokens: null, contextWindow: 200_000, percent: null })).toEqual({
      percent: null,
      percentLabel: "Refreshing",
      usedLabel: "—",
      remainingLabel: "—",
      windowLabel: "200k",
      filledCells: 0,
      tone: "default",
    });
  });

  it("allocates category cells proportionally while preserving free space", () => {
    const cells = allocateContextCells(manifest().categories, 20);
    expect(cells).toHaveLength(20);
    expect(cells.filter((cell) => cell === "system")).toHaveLength(5);
    expect(cells.filter((cell) => cell === "tools")).toHaveLength(3);
    expect(cells.filter((cell) => cell === "other")).toHaveLength(1);
  });

  it("stops claiming to load when context data is unavailable", () => {
    expect(renderToStaticMarkup(<ContextLens loading={false} />)).toBe("");
  });

  it("keeps the card footprint stable with a Mira skeleton while loading", () => {
    const missingHtml = renderToStaticMarkup(<ContextLens />);
    const compactingHtml = renderToStaticMarkup(
      <ContextLens usage={{ tokens: null, contextWindow: 200_000, percent: null }} />,
    );

    for (const html of [missingHtml, compactingHtml]) {
      expect(html).toContain("Loading context usage");
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('data-slot="skeleton"');
      expect(html).toContain("Context map is loading");
    }
  });

  it("renders an accessible persistent Mira card", () => {
    const html = renderToStaticMarkup(
      <ContextLens usage={{ tokens: 76_400, contextWindow: 200_000, percent: 38.2 }} />,
    );

    expect(html).toContain("Context usage: 38%, 76.4k of 200k tokens");
    expect(html).toContain(">38%</strong>");
    expect(html).toContain("76.4k/200k");
    expect(html).not.toContain("Context budget");
    expect(html).not.toContain("124k available");
    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain('data-slot="popover-trigger"');
    expect(html).not.toContain("Healthy");
    expect(html).not.toContain("Pi estimate");
  });

  it("does not let an older polled value replace a newer manifest", () => {
    const html = renderToStaticMarkup(
      <ContextLens
        manifest={manifest()}
        usage={{ tokens: 60_000, contextWindow: 200_000, percent: 30 }}
      />,
    );
    expect(html).toContain("Context usage: 40%, 80k of 200k tokens");
  });

  it("prefers fresher authoritative usage and assigns unclassified growth to overhead", () => {
    const html = renderToStaticMarkup(
      <ContextLens
        manifest={manifest()}
        usage={{ tokens: 100_000, contextWindow: 200_000, percent: 50 }}
      />,
    );

    expect(html).toContain("Context usage: 50%, 100k of 200k tokens");
    expect(html).toContain("Overhead 25k");
  });

  it("presents concise per-cell tooltip details for categories and free space", () => {
    expect(presentContextCellTooltip("system", true, manifest().usage, manifest().categories)).toEqual({
      label: "System",
      detail: "20k tokens · 10% of context",
      colorClass: "bg-slate-400 dark:bg-slate-500",
    });
    expect(presentContextCellTooltip(undefined, false, manifest().usage, manifest().categories)).toEqual({
      label: "Available",
      detail: "120k tokens · 60% free",
      colorClass: "bg-muted-foreground",
    });
  });

  it("uses Tailwind category colors and removes the persistent legend", () => {
    const html = renderToStaticMarkup(<ContextLens manifest={manifest()} />);

    expect(html).toContain("System 20k");
    expect(html).toContain("Tool output 10k");
    expect(html).not.toContain('aria-label="Context categories"');
    expect(html).not.toContain("<ul");
    expect(html).toContain("bg-slate-400");
    expect(html).toContain("bg-blue-500");
    expect(html).toContain("bg-cyan-500");
    expect(html).toContain("data-context-cell-index");
    expect(html).not.toContain('data-slot="tooltip"');
    expect(html).toContain('class="context-lens-cell"');
  });
});
