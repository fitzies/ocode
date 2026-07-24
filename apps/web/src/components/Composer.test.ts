import type { ModelDescriptor } from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { activeFileMention, selectAnvilModels, updateComposerDraft } from "./Composer";

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

describe("selectAnvilModels", () => {
  it("selects the three Anvil model ids and presents only their aliases", () => {
    const selected = selectAnvilModels([
      model("openai-codex/gpt-5.4", "GPT-5.4"),
      model("openai-codex/gpt-5.6-terra", "GPT-5.6 Terra"),
      model("openai-codex/gpt-5.6-sol", "GPT-5.6 Sol"),
      model("openai-codex/gpt-5.6-luna", "GPT-5.6 Luna"),
    ]);

    expect(selected.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "openai-codex/gpt-5.6-sol", name: "Sol" },
      { id: "openai-codex/gpt-5.6-luna", name: "Luna" },
      { id: "openai-codex/gpt-5.6-terra", name: "Terra" },
    ]);
  });
});
