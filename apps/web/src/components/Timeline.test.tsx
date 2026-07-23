import type { MessageEntry, ReasoningEntry, SessionSummary } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "./Timeline";

const session: SessionSummary = {
  id: "session-markdown",
  projectId: "project-1",
  title: "Markdown rendering",
  updatedAt: "2026-03-22T00:00:00.000Z",
  status: "idle",
  modelId: "test-model",
  thinkingLevel: "medium",
};

const message: MessageEntry = {
  id: "message-1",
  kind: "message",
  role: "assistant",
  status: "complete",
  createdAt: "2026-03-22T00:00:00.000Z",
  content: [{
    id: "text-1",
    type: "text",
    text: "**Phase 3 goal:**\n\n- Reliable sessions\n- Better tools\n\nUse `pnpm build` or [read the docs](https://example.com).",
  }],
};

const reasoning: ReasoningEntry = {
  id: "reasoning-1",
  kind: "reasoning",
  messageId: "message-1",
  status: "complete",
  createdAt: "2026-03-22T00:00:00.000Z",
  content: "**Checking:**\n\n1. Types\n2. Tests",
};

describe("Timeline markdown", () => {
  it("renders assistant Markdown as semantic HTML", () => {
    const html = renderToStaticMarkup(
      <Timeline session={session} entries={[message]} onSuggestion={() => undefined} />,
    );

    expect(html).toContain("<strong>Phase 3 goal:</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>Reliable sessions</li>");
    expect(html).toContain("<code>pnpm build</code>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("**Phase 3 goal:**");
  });

  it("renders reasoning Markdown as semantic HTML", () => {
    const html = renderToStaticMarkup(
      <Timeline session={session} entries={[reasoning]} onSuggestion={() => undefined} />,
    );

    expect(html).toContain("<strong>Checking:</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>Types</li>");
    expect(html).not.toContain("**Checking:**");
  });
});
