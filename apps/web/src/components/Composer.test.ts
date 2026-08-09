import type { ModelDescriptor, ProjectWorkspaceKind, SessionStatus } from "@anvil/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { SubagentActivity } from "../lib/subagentActivity";
import { Composer, activeFileMention, isFileDrag, nextThinkingLevel, selectAnvilModels, updateComposerDraft } from "./Composer";

const model = (id: string, name: string): ModelDescriptor => ({
  id,
  name,
  provider: "openai-codex",
  reasoning: true,
  input: ["text"],
  supportedThinkingLevels: ["medium", "high"],
});

function renderComposer(modelsReady: boolean, options: {
  status?: SessionStatus;
  workspaceKind?: ProjectWorkspaceKind;
  pending?: boolean;
  creationError?: string;
  subagents?: SubagentActivity;
} = {}): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, {
    sessionId: "session-1",
    modelId: "unknown",
    thinkingLevel: "off",
    status: options.status ?? "idle",
    models: [],
    modelsReady,
    commands: [],
    skills: [],
    queue: { steering: [], followUp: [] },
    prompt: "",
    pending: options.pending,
    creationError: options.creationError,
    widgets: [],
    workspaceKind: "workspaceKind" in options ? options.workspaceKind : "worktree",
    subagents: options.subagents ?? { active: 0, finished: 3, failed: 0, needsAttention: 0, items: [] },
    attachments: [],
    onAttachFiles: () => undefined,
    onRemoveAttachment: () => undefined,
    onSearchFiles: async () => [],
    onOpenSubagents: () => undefined,
    onCancel: () => undefined,
    onDraftConsumed: () => undefined,
    onPromptChange: () => undefined,
    onModelChange: () => undefined,
    onThinkingLevelChange: () => undefined,
    onSend: () => undefined,
  })));
}

describe("Composer workspace status", () => {
  it("shows workspace context without repeating the project name", () => {
    const html = renderComposer(true);

    expect(html).toContain(">worktree<");
    expect(html).not.toContain("anvil ·");
    expect(html).not.toContain("Pi has full Forge access");
  });

  it("uses main workspace for primary, folder, and legacy workspace metadata", () => {
    expect(renderComposer(true, { workspaceKind: "main" })).toContain(">main workspace<");
    expect(renderComposer(true, { workspaceKind: "folder" })).toContain(">main workspace<");
    expect(renderComposer(true, { workspaceKind: undefined })).toContain(">main workspace<");
  });

  it("labels the built-in General project as the home workspace", () => {
    expect(renderComposer(true, { workspaceKind: "general" })).toContain(">home workspace<");
  });

  it("hides inactive subagents and shows only the finished tick", () => {
    const html = renderComposer(true);

    expect(html).not.toContain("subagents:");
    expect(html).not.toContain("composer-status-icon--active");
    expect(html).toContain("composer-status-icon--finished");
    expect(html).not.toContain('class="sr-only"> active');
    expect(html).toContain('class="sr-only"> finished');
  });

  it("shows and spins the activity icon while subagents are active", () => {
    const html = renderComposer(true, { subagents: { active: 2, finished: 1, failed: 0, needsAttention: 0, items: [] } });

    expect(html).toContain("composer-status-icon--active composer-status-icon--spinning");
    expect(html).toContain('class="sr-only"> active');
  });

  it("keeps the status present during startup and creation errors", () => {
    expect(renderComposer(true, { pending: true })).toContain(">worktree<");
    expect(renderComposer(true, { creationError: "failed" })).toContain("composer-status-subagents");
  });
});

describe("Composer model loading", () => {
  it("shows only a spinner while model discovery is pending", () => {
    const html = renderComposer(false);

    expect(html).toContain('aria-label="Loading models"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-slot="spinner"');
  });

  it("stops loading for a ready empty catalog or failed startup", () => {
    expect(renderComposer(true)).not.toContain('data-slot="spinner"');
    expect(renderComposer(false, { status: "failed" })).not.toContain('data-slot="spinner"');
  });
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

describe("isFileDrag", () => {
  it("accepts file drags without intercepting dragged text or links", () => {
    expect(isFileDrag({ types: ["Files"] })).toBe(true);
    expect(isFileDrag({ types: ["text/plain", "text/uri-list"] })).toBe(false);
    expect(isFileDrag(null)).toBe(false);
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
