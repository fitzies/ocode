import type { ModelDescriptor } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { activeFileMention, nextThinkingLevel, selectAnvilModels, updateComposerDraft } from "./Composer";

const model = (id: string, name: string): ModelDescriptor => ({
  id,
  name,
  provider: "openai-codex",
  reasoning: true,
  input: ["text"],
  supportedThinkingLevels: ["medium", "high"],
});

describe("updateComposerDraft", () => {
  it("keeps unsent input isolated by session", () => {
    let drafts: Record<string, string> = {};
    drafts = updateComposerDraft(drafts, "session-a", "Message for A");
    drafts = updateComposerDraft(drafts, "session-b", "Message for B");
    drafts = updateComposerDraft(drafts, "session-b", "");

    expect(drafts).toEqual({ "session-a": "Message for A" });
  });
});

describe("activeFileMention", () => {
  it("finds unquoted and quoted @ file queries at the cursor", () => {
    expect(activeFileMention("Review @src/cmp", 15)).toEqual({ start: 7, query: "src/cmp" });
    expect(activeFileMention('Review @"docs/my f', 18)).toEqual({ start: 7, query: "docs/my f" });
    expect(activeFileMention("email@example.com", 17)).toBeUndefined();
  });
});

describe("nextThinkingLevel", () => {
  it("cycles through the model's supported levels and wraps", () => {
    const levels = ["off", "medium", "high", "xhigh", "max"] as const;

    expect(nextThinkingLevel(levels, "medium")).toBe("high");
    expect(nextThinkingLevel(levels, "max")).toBe("off");
    expect(nextThinkingLevel(levels, "minimal")).toBe("off");
    expect(nextThinkingLevel(["off"], "off")).toBeUndefined();
  });
});

describe("selectAnvilModels", () => {
  it("preserves all 5.6 models with Pi's names and ordering", () => {
    const selected = selectAnvilModels([
      model("openai-codex/gpt-5.4", "GPT-5.4"),
      model("openai-codex/gpt-5.6", "GPT-5.6"),
      model("openai-codex/gpt-5.6-high", "GPT-5.6 High"),
      model("custom/latest", "Custom 5.6"),
    ]);

    expect(selected.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "openai-codex/gpt-5.6", name: "GPT-5.6" },
      { id: "openai-codex/gpt-5.6-high", name: "GPT-5.6 High" },
      { id: "custom/latest", name: "Custom 5.6" },
    ]);
  });
});
