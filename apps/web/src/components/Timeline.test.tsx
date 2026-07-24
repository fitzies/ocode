import type { MessageEntry, ReasoningEntry, SessionSummary, ToolEntry } from "@anvil/protocol";
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

  it("wraps GFM tables in a bounded horizontal scroller", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          content: [{
            id: "table-1",
            type: "text",
            text: "| A very wide column | Another wide column |\n| --- | --- |\n| First value | Second value |",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain('class="markdown-table-scroll"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Scrollable table"');
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A very wide column</th>");
  });

  it("renders externalized content as an artifact download", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          content: [{
            id: "artifact-1",
            type: "artifact",
            artifactId: "01959f7e-7d64-7000-8000-000000000001",
            url: "/api/v1/artifacts/01959f7e-7d64-7000-8000-000000000001",
            mediaType: "text/plain; charset=utf-8",
            byteLength: 524288,
            name: "tool-output.txt",
            preview: "Output preview",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Output preview");
    expect(html).toContain("tool-output.txt");
    expect(html).toContain("512 KB");
    expect(html).toContain("/api/v1/artifacts/01959f7e-7d64-7000-8000-000000000001");
  });

  it("renders reasoning Markdown as semantic HTML", () => {
    const html = renderToStaticMarkup(
      <Timeline session={session} entries={[reasoning]} onSuggestion={() => undefined} />,
    );

    expect(html).toContain('<div class="thinking-event thinking-event--complete">');
    expect(html).toContain('<span class="thinking-label">Thinking:</span>');
    expect(html).toContain("<strong>Checking:</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>Types</li>");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("**Checking:**");
  });
});

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "read",
    summary: "Read file",
    status: "running",
    arguments: { path: "apps/web/src/App.tsx", offset: 4, limit: 5 },
    output: [],
    createdAt: "2026-03-22T00:00:00.000Z",
    startedAt: "2026-03-22T00:00:00.000Z",
    raw: { type: "tool_execution_start" },
    ...overrides,
  };
}

describe("Timeline tool presentation", () => {
  it("renders a specialized summary while retaining technical disclosure", () => {
    const html = renderToStaticMarkup(
      <Timeline session={{ ...session, status: "running" }} entries={[tool()]} onSuggestion={() => undefined} />,
    );

    expect(html).toContain("Reading apps/web/src/App.tsx");
    expect(html).toContain("Lines 4–8");
    expect(html).toContain("Running");
    expect(html).toContain("Arguments");
    expect(html).toContain("Raw RPC event");
    expect(html).toContain("tool-event--file");
  });

  it("shows subagents as delegated agents", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={{ ...session, status: "running" }}
        entries={[tool({
          name: "subagent",
          arguments: { agent: "researcher", task: "Review the Pi RPC documentation" },
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Researcher agent");
    expect(html).toContain("Review the Pi RPC documentation");
    expect(html).toContain("tool-event--agent");
  });

  it("keeps unknown tool names and output available in the generic fallback", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[tool({
          name: "custom.read",
          label: undefined,
          status: "completed",
          arguments: { mode: "careful" },
          output: [{ id: "output-1", type: "text", text: "Extension result" }],
          details: { extensionMetadata: true },
          endedAt: "2026-03-22T00:00:01.250Z",
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("custom.read");
    expect(html).toContain("Output available");
    expect(html).toContain("Extension result");
    expect(html).toContain("extensionMetadata");
    expect(html).toContain("Done · 1.3s");
    expect(html).toContain("tool-event--generic");
    expect(html).not.toContain("tool-event--file");
  });

  it("keeps an unknown tool's exact identity visible when its friendly label fails", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[tool({
          name: "extension.deploy",
          label: "Deploy preview",
          status: "failed",
          output: [{ id: "failure-1", type: "text", text: "Preview service unavailable" }],
          endedAt: "2026-03-22T00:00:01.000Z",
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Deploy preview");
    expect(html).toContain("extension.deploy · Preview service unavailable");
    expect(html).toContain("tool-event--generic");
  });

  it("groups and reports progress for parallel tools", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={{ ...session, status: "running" }}
        entries={[
          tool({ id: "tool-a", toolCallId: "call-a", batchId: "batch-1", status: "failed", endedAt: "2026-03-22T00:00:01.000Z" }),
          tool({ id: "tool-b", toolCallId: "call-b", batchId: "batch-1", name: "search", arguments: { query: "Pi RPC" } }),
        ]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Parallel work");
    expect(html).toContain("2 tools");
    expect(html).toContain("1/2 settled · 1 running · 1 failed");
    expect(html).toContain("tool-batch--has-errors");
    expect(html).toContain("tool-batch-progress-error");
    expect(html).toContain('aria-label="2 parallel tools"');
  });

  it("separates successful, failed, and cancelled results in a settled batch", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[
          tool({ id: "tool-a", toolCallId: "call-a", batchId: "batch-2", status: "completed", endedAt: "2026-03-22T00:00:01.000Z" }),
          tool({ id: "tool-b", toolCallId: "call-b", batchId: "batch-2", status: "failed", endedAt: "2026-03-22T00:00:01.000Z" }),
          tool({ id: "tool-c", toolCallId: "call-c", batchId: "batch-2", status: "cancelled", endedAt: "2026-03-22T00:00:01.000Z" }),
        ]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("1 complete · 1 failed · 1 cancelled");
    expect(html).toContain("tool-batch-progress-complete");
    expect(html).toContain("tool-batch-progress-error");
  });
});
