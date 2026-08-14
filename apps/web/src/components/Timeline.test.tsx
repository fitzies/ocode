import type { MessageEntry, ReasoningEntry, SessionSummary, SystemEventEntry, ToolEntry } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "./Timeline";

const nodeFsSpecifier = "node:fs";
const { readFileSync } = await import(nodeFsSpecifier);
const timelineSource = readFileSync(new URL("./Timeline.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

const session: SessionSummary = {
  id: "session-markdown",
  projectId: "project-1",
  title: "Markdown rendering",
  updatedAt: "2026-03-22T00:00:00.000Z",
  status: "idle",
  modelId: "test-model",
  thinkingLevel: "medium",
  readThroughSequence: 0,
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

describe("Timeline empty state", () => {
  it("prompts with the current project as a project-changing action", () => {
    const html = renderToStaticMarkup(
      <Timeline session={session} projectName="ocode" entries={[]} onSuggestion={() => undefined} />,
    );

    expect(html).toContain("What are we building in");
    expect(html).toContain('aria-label="Change project from ocode"');
    expect(html).toContain(">ocode</button>");
    expect(html).not.toContain("Let’s build");
  });

  it("uses an explicit AppShell callback instead of a global project-change event", () => {
    expect(timelineSource).toContain("onClick={onRequestProjectChange}");
    expect(appShellSource).toContain('onRequestProjectChange={() => setProjectChooserMode("change")}');
    expect(timelineSource).not.toContain("ocode:change-project");
    expect(appShellSource).toContain("changeEmptySessionProject");
  });

  it("switches to the selected project before deleting the previous empty thread", () => {
    const start = appShellSource.indexOf("const changeEmptySessionProject");
    const end = appShellSource.indexOf("const markGitActionComplete", start);
    const changeSource = appShellSource.slice(start, end);

    expect(changeSource.indexOf("startSession(projectId)")).toBeLessThan(changeSource.indexOf("anvilClient.deleteSession(previousSessionId)"));
    expect(changeSource).not.toContain("await anvilClient.deleteSession");
  });
});

describe("Timeline message actions", () => {
  it("shows copy only for complete assistant text", () => {
    const assistantHtml = renderToStaticMarkup(<Timeline session={session} entries={[message]} onSuggestion={() => undefined} />);
    const userHtml = renderToStaticMarkup(<Timeline session={session} entries={[{ ...message, role: "user" }]} onSuggestion={() => undefined} />);
    const streamingHtml = renderToStaticMarkup(
      <Timeline session={{ ...session, status: "running" }} entries={[{ ...message, status: "streaming" }]} onSuggestion={() => undefined} />,
    );
    expect(assistantHtml).toContain('aria-label="Copy response"');
    expect(userHtml).not.toContain('aria-label="Copy response"');
    expect(streamingHtml).not.toContain("message-actions");
  });

  it("keeps copy available for code-only assistant text", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{ ...message, content: [{ id: "code-only", type: "text", text: "```ts\nconst value = 1;\n```" }] }]}
        onSuggestion={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="Copy response"');
  });

  it("does not add response actions for failed or non-text assistant content", () => {
    const failedHtml = renderToStaticMarkup(
      <Timeline session={session} entries={[{ ...message, status: "failed", error: "Generation failed" }]} onSuggestion={() => undefined} />,
    );
    const imageHtml = renderToStaticMarkup(
      <Timeline session={session} entries={[{ ...message, content: [{ id: "image", type: "image", mimeType: "image/png", data: "cG5n" }] }]} onSuggestion={() => undefined} />,
    );
    expect(failedHtml).not.toContain("message-actions");
    expect(imageHtml).not.toContain("message-actions");
  });
});

describe("Timeline subagent completions", () => {
  it("renders a parsed completion event instead of a user bubble", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          origin: {
            type: "subagentCompletion",
            runId: "run-review",
            childSessionId: "child-review",
            deliveryId: "subagent-completion:run-review",
            role: "reviewer",
            status: "completed",
          },
          content: [{
            id: "subagent-result",
            type: "text",
            text: "[ocode reviewer subagent run-review completed]\nChild session: child-review\n\nFound **two race conditions**.",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("subagent-completion-message");
    expect(html).toContain("Reviewer subagent");
    expect(html).toContain("Found <strong>two race conditions</strong>.");
    expect(html).not.toContain("user-message");
    expect(html).not.toContain("[ocode reviewer subagent");
    expect(html).not.toContain("Child session: child-review");
  });
});

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

  it("adds a copy button to fenced assistant code blocks", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          content: [{ id: "copyable", type: "text", text: "```text\nCopy this message\n```" }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("Copy this message");
  });

  it("renders skill invocations as friendly context instead of Pi command syntax", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          content: [{
            id: "skill-prompt",
            type: "text",
            text: "/skill:frontend-design Improve the composer",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Skill: frontend-design");
    expect(html).toContain("user-invocation--skill");
    expect(html).toContain("frontend-design");
    expect(html).toContain("Improve the composer");
    expect(html).not.toContain("/skill:frontend-design");
  });

  it("renders commands inline without their slash using a distinct color", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          content: [{ id: "command-prompt", type: "text", text: "/reload now" }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Command: reload");
    expect(html).toContain("user-invocation--command");
    expect(html).toContain(">reload</span>");
    expect(html).toContain("now");
    expect(html).not.toContain("/reload");
  });

  it("hides synthetic image attachment markers from user messages", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          content: [{
            id: "image-prompt",
            type: "text",
            text: "Review this image\n\nLiteral example: <file name=\"example.png\"></file>\n\n<file name=\"attached.png\"></file>",
          }, {
            id: "image-content",
            type: "image",
            mimeType: "image/png",
            data: "cG5n",
            alt: "Attached screenshot",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Review this image");
    expect(html).toContain("Attached screenshot");
    expect(html).toContain('class="image-block"');
    expect(html).toContain('aria-label="Open Attached screenshot"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("example.png");
    expect(html).not.toContain("attached.png");
  });

  it("leaves manually entered empty file markup visible without an attached image", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          content: [{
            id: "literal-file-markup",
            type: "text",
            text: "Example: <file name=\"image.png\"></file>",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("image.png");
  });

  it("preserves non-empty file attachment context in user messages", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          role: "user",
          content: [{
            id: "text-prompt",
            type: "text",
            text: "<file name=\"notes.txt\">\nimportant attachment text\n</file>\n<file name=\"image.png\"></file>",
          }, {
            id: "mixed-image-content",
            type: "image",
            mimeType: "image/png",
            data: "cG5n",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("notes.txt");
    expect(html).toContain("important attachment text");
    expect(html).not.toContain("image.png");
  });

  it("leaves attachment-like markup in assistant messages untouched", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[{
          ...message,
          content: [{
            id: "assistant-example",
            type: "text",
            text: "Example: <file name=\"image.png\"></file>",
          }],
        }]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("image.png");
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

  it("hides completed and streaming reasoning entries", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={{ ...session, status: "running" }}
        entries={[
          reasoning,
          { ...reasoning, id: "reasoning-2", status: "streaming", content: "Investigating app name source" },
          tool({ status: "completed" }),
        ]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).not.toContain("Thought process");
    expect(html).not.toContain("Checking:");
    expect(html).not.toContain("Investigating app name source");
    expect(html).toContain("Read apps/web/src/App.tsx");
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

  it.each(["ocode_render_html_file", "anvil_render_html_file"])(
    "renders an inline artifact loading state for %s without generic tool chrome",
    (name) => {
      const html = renderToStaticMarkup(
        <Timeline
          session={{ ...session, status: "running" }}
          entries={[tool({
            name,
            arguments: { path: "artifacts/usage.html", title: "Usage preview" },
          })]}
          onSuggestion={() => undefined}
        />,
      );

      expect(html).toContain("Usage preview");
      expect(html).toContain("Building preview…");
      expect(html).toContain('data-slot="spinner"');
      expect(html).not.toContain("tool-event--generic");
    },
  );

  it("renders completed HTML artifacts in a sandboxed inline iframe", () => {
    const artifactHtml = "<!doctype html><html><body><strong>34% used</strong></body></html>";
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[tool({
          name: "ocode_render_html_file",
          status: "completed",
          arguments: { path: "artifacts/usage.html", title: "Usage preview" },
          output: [{
            id: "inline-html-1",
            type: "inlineHtml",
            title: "Usage preview",
            html: artifactHtml,
            sourcePath: "artifacts/usage.html",
            byteLength: new TextEncoder().encode(artifactHtml).byteLength,
          }],
          endedAt: "2026-03-22T00:00:01.000Z",
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Usage preview");
    expect(html).toContain("Connecting to preview…");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("connect-src &#x27;none&#x27;");
    expect(html).not.toContain("tool-event--generic");
  });

  it("shows only the Markdown-formatted subagent message and response when expanded", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[tool({
          name: "subagent",
          status: "completed",
          arguments: { agent: "researcher", task: "**Review** the Pi RPC documentation" },
          output: [
            { id: "agent-response", type: "text", text: "**Finding:**\n\n- RPC sessions are resumable" },
            { id: "agent-internal", type: "data", label: "Internal result", data: { secret: "hidden output" } },
            { id: "agent-html", type: "inlineHtml", title: "Hidden preview", html: "<strong>hidden preview</strong>", byteLength: 31 },
          ],
          details: { internalTrace: "hidden detail" },
          raw: { type: "tool_execution_end", internalEvent: "hidden event" },
          endedAt: "2026-03-22T00:00:01.000Z",
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Subagent finished");
    expect(html).toContain("tool-event--agent");
    expect(html).toContain(">Message<");
    expect(html).toContain("<strong>Review</strong>");
    expect(html).toContain(">Response<");
    expect(html).toContain("<strong>Finding:</strong>");
    expect(html).toContain("<li>RPC sessions are resumable</li>");
    expect(html).not.toContain("Arguments");
    expect(html).not.toContain("Raw RPC event");
    expect(html).not.toContain("hidden detail");
    expect(html).not.toContain("hidden event");
    expect(html).not.toContain("hidden output");
    expect(html).not.toContain("hidden preview");
    expect(html).not.toContain("sandbox=");
  });

  it("shows a simple response placeholder while a subagent is running", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={{ ...session, status: "running" }}
        entries={[tool({
          name: "subagent",
          arguments: { agent: "scout", task: "Find the relevant files" },
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("Subagent working");
    expect(html).toContain("Find the relevant files");
    expect(html).toContain("Waiting for response…");
    expect(html).not.toContain("Raw RPC event");
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

  it("presents legacy ocode tool aliases without exposing the former product name", () => {
    const html = renderToStaticMarkup(
      <Timeline
        session={session}
        entries={[tool({
          name: "anvil_open_file",
          label: undefined,
          status: "failed",
          output: [{ id: "failure-legacy", type: "text", text: "File unavailable" }],
          endedAt: "2026-03-22T00:00:01.000Z",
        })]}
        onSuggestion={() => undefined}
      />,
    );

    expect(html).toContain("ocode_open_file");
    expect(html).not.toContain("anvil_open_file");
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

function retryEvent(
  id: string,
  type: "auto_retry_start" | "auto_retry_end",
  values: Record<string, string | number | boolean>,
): SystemEventEntry {
  const raw = { type, ...values };
  return {
    id,
    kind: "event",
    category: type === "auto_retry_end" && values.success === false ? "error" : "lifecycle",
    tone: type === "auto_retry_end" && values.success === false ? "error" : "warning",
    title: type === "auto_retry_start" ? "Retrying request" : "Retry finished",
    message: typeof values.errorMessage === "string"
      ? values.errorMessage
      : typeof values.finalError === "string"
        ? values.finalError
        : undefined,
    createdAt: "2026-03-22T00:00:01.000Z",
    details: raw,
    raw,
  };
}

function failedAssistant(id: string, error: string): MessageEntry {
  return {
    id,
    kind: "message",
    role: "assistant",
    content: [],
    status: "failed",
    error,
    createdAt: "2026-03-22T00:00:01.000Z",
    raw: { role: "assistant", stopReason: "error", errorMessage: error },
  };
}

function retryMarkup(entries: (MessageEntry | SystemEventEntry)[], running = false): string {
  return renderToStaticMarkup(
    <Timeline session={{ ...session, status: running ? "running" : "idle" }} entries={entries} onSuggestion={() => undefined} />,
  );
}

describe("Timeline automatic retries", () => {
  it("shows an active retry as one expandable tool-style row", () => {
    const html = retryMarkup([
      failedAssistant("failed-attempt-2", "WebSocket error"),
      retryEvent("retry-start-2", "auto_retry_start", {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4_000,
        errorMessage: "WebSocket error",
      }),
    ], true);

    expect(html).toContain("tool-event retry-event retry-event--active");
    expect(html).toContain("Reconnecting…");
    expect(html).toContain("WebSocket error · attempt 2");
    expect(html).toContain("Retrying");
    expect(html).toContain("Raw retry events and errors");
    expect(html).toContain("auto_retry_start");
    expect(html).not.toContain("system-event--warning");
    expect(html).not.toContain("message-error");
    expect(html).not.toContain("working-status");
  });

  it("evolves multiple attempts into one resolved row and retains raw errors", () => {
    const unrelatedEvent: SystemEventEntry = {
      id: "unrelated-system-event",
      kind: "event",
      category: "notification",
      tone: "info",
      title: "Extension notice",
      message: "Still independent",
      createdAt: "2026-03-22T00:00:01.500Z",
      raw: { type: "extension_ui_request" },
    };
    const html = retryMarkup([
      failedAssistant("failed-attempt-1", "WebSocket error"),
      retryEvent("retry-start-1", "auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "WebSocket error" }),
      unrelatedEvent,
      failedAssistant("failed-attempt-2", "WebSocket error"),
      retryEvent("retry-start-2", "auto_retry_start", { attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: "WebSocket error" }),
      retryEvent("retry-end", "auto_retry_end", { success: true, attempt: 2 }),
    ]);

    expect(html.match(/<details class="tool-event retry-event/g)).toHaveLength(1);
    expect(html).toContain("retry-event--success");
    expect(html).toContain("Connection recovered");
    expect(html).toContain("WebSocket error · 2 attempts");
    expect(html).toContain("Resolved");
    expect(html).toContain("Attempt 1");
    expect(html).toContain("Attempt 2");
    expect(html).toContain("auto_retry_start");
    expect(html).toContain("auto_retry_end");
    expect(html).not.toContain("message-error");
    expect(html).toContain("system-event system-event--info");
    expect(html).toContain("Extension notice");
  });

  it("does not merge retry cycles across user request boundaries", () => {
    const nextRequest: MessageEntry = {
      ...message,
      id: "next-request",
      role: "user",
      content: [{ id: "next-request-text", type: "text", text: "Try something else" }],
      status: "complete",
    };
    const html = retryMarkup([
      retryEvent("stale-retry-start", "auto_retry_start", { attempt: 1, errorMessage: "WebSocket error" }),
      nextRequest,
      retryEvent("next-retry-start", "auto_retry_start", { attempt: 1, errorMessage: "Provider unavailable" }),
      retryEvent("next-retry-end", "auto_retry_end", { success: true, attempt: 1 }),
    ]);

    expect(html.match(/<details class="tool-event retry-event/g)).toHaveLength(2);
    expect(html).toContain("WebSocket error · attempt 1");
    expect(html).toContain("Provider unavailable · 1 attempt");
  });

  it("shows exhaustion and suppresses only assistant errors belonging to the retry", () => {
    const html = retryMarkup([
      failedAssistant("unrelated-failure", "Authentication failed"),
      failedAssistant("initial-retry-failure", "WebSocket error"),
      retryEvent("retry-start", "auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "WebSocket error" }),
      failedAssistant("final-retry-failure", "WebSocket retries exhausted"),
      retryEvent("retry-end", "auto_retry_end", { success: false, attempt: 3, finalError: "WebSocket retries exhausted" }),
    ]);

    expect(html.match(/<details class="tool-event retry-event/g)).toHaveLength(1);
    expect(html).toContain("retry-event--failed");
    expect(html).toContain("Connection failed");
    expect(html).toContain("WebSocket error · 3 attempts");
    expect(html).toContain("Failed");
    expect(html).toContain("WebSocket retries exhausted");
    expect(html.match(/class="message-error"/g)).toHaveLength(1);
    expect(html).toContain("Authentication failed");
    expect(html).not.toContain("system-event--error");
  });
});
