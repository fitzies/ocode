import {
  OCODE_CONTEXT_WIDGET_KEY,
  parseContextManifestV1,
} from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import {
  estimateMessageCategories,
  estimateSystemPromptCategories,
  registerContextManifestBridge,
  type ContextBridgeContext,
} from "./contextManifest.ts";

function bridgeHarness() {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, context: ContextBridgeContext) => void>>();
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  let usage: { tokens: number | null; contextWindow: number; percent: number | null } = {
    tokens: 20_000,
    contextWindow: 200_000,
    percent: 10,
  };
  let sessionMessages: unknown[] = [];
  let systemPrompt = "Base system prompt";
  const context: ContextBridgeContext = {
    ui: { setWidget: (key, lines) => widgets.push({ key, lines }) },
    model: { contextWindow: 200_000 },
    getContextUsage: () => usage,
    getSystemPrompt: () => systemPrompt,
    sessionManager: { buildSessionContext: () => ({ messages: sessionMessages }) },
  };
  registerContextManifestBridge({
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => ["read"],
    getAllTools: () => [{
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
  });
  return {
    widgets,
    context,
    setUsage: (next: typeof usage) => { usage = next; },
    setSessionMessages: (next: unknown[]) => { sessionMessages = next; },
    setSystemPrompt: (next: string) => { systemPrompt = next; },
    emit: (event: string, detail: Record<string, unknown> = {}) => {
      handlers.get(event)?.forEach((handler) => handler({ type: event, ...detail }, context));
    },
  };
}

describe("bundled context manifest bridge", () => {
  it("classifies structured prompt and message inputs without retaining their content", () => {
    const system = estimateSystemPromptCategories("x".repeat(4_000), {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Use read for source files"],
      contextFiles: [{ path: "/secret/project/AGENTS.md", content: "private project instructions" }],
      skills: [{ name: "frontend", description: "Design interfaces", filePath: "/secret/SKILL.md" }],
    });
    const messages = estimateMessageCategories([
      { role: "user", content: "private user prompt" },
      { role: "assistant", content: [
        { type: "text", text: "answer" },
        { type: "toolCall", name: "read", arguments: { path: "/secret/file.ts" } },
      ] },
      { role: "toolResult", content: [{ type: "text", text: "private tool output" }] },
      { role: "bashExecution", command: "excluded private command", output: "excluded private output", excludeFromContext: true },
      { role: "compactionSummary", summary: "private compacted history" },
    ]);

    expect(system).toMatchObject({ system: expect.any(Number), tools: expect.any(Number), skills: expect.any(Number), memory: expect.any(Number) });
    expect(messages).toMatchObject({ user: 5, assistant: 2, toolCalls: expect.any(Number), toolOutput: 5, compaction: 7 });
    expect(JSON.stringify({ system, messages })).not.toContain("secret");
    expect(JSON.stringify({ system, messages })).not.toContain("private");
  });

  it("publishes one bounded manifest line, reconciles totals, and deduplicates unchanged values", () => {
    const harness = bridgeHarness();
    harness.setSystemPrompt("SYSTEM private-system".repeat(100));
    harness.emit("before_agent_start", {
      systemPrompt: "SYSTEM private-system".repeat(100),
      systemPromptOptions: {
        selectedTools: ["read"],
        toolSnippets: { read: "Read files" },
        contextFiles: [{ path: "/private/AGENTS.md", content: "private-memory" }],
        skills: [{ name: "secret-skill", description: "private-skill", filePath: "/private/SKILL.md" }],
      },
    });
    harness.emit("context", { messages: [{ role: "user", content: "private-prompt" }] });

    expect(harness.widgets).toHaveLength(1);
    expect(harness.widgets[0]?.key).toBe(OCODE_CONTEXT_WIDGET_KEY);
    const payload = harness.widgets[0]?.lines?.[0] ?? "";
    const manifest = parseContextManifestV1(payload);
    expect(manifest).toBeDefined();
    expect(manifest?.categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(20_000);
    expect(manifest?.categories.find((category) => category.id === "tools")?.tokens).toBeGreaterThan(0);
    expect(manifest?.categories.find((category) => category.id === "memory")?.tokens).toBeGreaterThan(0);
    expect(payload).not.toContain("private");
    expect(payload).not.toContain("secret");

    harness.emit("context", { messages: [{ role: "user", content: "private-prompt" }] });
    expect(harness.widgets).toHaveLength(1);
  });

  it("marks usage unknown after compaction and refreshes from settled session context", () => {
    const harness = bridgeHarness();
    harness.emit("context", { messages: [{ role: "user", content: "hello" }] });
    harness.setUsage({ tokens: null, contextWindow: 200_000, percent: null });
    harness.emit("session_compact");

    const compacting = parseContextManifestV1(harness.widgets.at(-1)?.lines?.[0] ?? "");
    expect(compacting?.usage).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
    expect(compacting?.categories.every((category) => category.tokens === 0)).toBe(true);

    harness.setSessionMessages([{ role: "compactionSummary", summary: "summary" }, { role: "assistant", content: [{ type: "text", text: "done" }] }]);
    harness.setUsage({ tokens: 8_000, contextWindow: 200_000, percent: 4 });
    harness.emit("agent_settled");
    const settled = parseContextManifestV1(harness.widgets.at(-1)?.lines?.[0] ?? "");
    expect(settled?.usage.tokens).toBe(8_000);
    expect(settled?.categories.find((category) => category.id === "compaction")?.tokens).toBeGreaterThan(0);
  });
});
