import type { CommandDescriptor, ModelDescriptor, SessionStatus, SkillDescriptor } from "@anvil/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Composer,
  activeFileMention,
  isFileDrag,
  joinCommandPrompt,
  joinSkillPrompt,
  nextThinkingLevel,
  selectAnvilModels,
  splitCommandPrompt,
  splitSkillPrompt,
  updateComposerDraft,
} from "./Composer";

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
  pending?: boolean;
  creationError?: string;
  prompt?: string;
  commands?: CommandDescriptor[];
  skills?: SkillDescriptor[];
} = {}): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, {
    sessionId: "session-1",
    modelId: "unknown",
    thinkingLevel: "off",
    status: options.status ?? "idle",
    models: [],
    modelsReady,
    commands: options.commands ?? [],
    skills: options.skills ?? [],
    queue: { steering: [], followUp: [] },
    prompt: options.prompt ?? "",
    pending: options.pending,
    creationError: options.creationError,
    widgets: [],
    attachments: [],
    onAttachFiles: () => undefined,
    onRemoveAttachment: () => undefined,
    onSearchFiles: async () => [],
    onCancel: () => undefined,
    onDraftConsumed: () => undefined,
    onPromptChange: () => undefined,
    onModelChange: () => undefined,
    onThinkingLevelChange: () => undefined,
    onSend: () => undefined,
  })));
}

describe("Composer footer", () => {
  it("does not repeat workspace or agent navigation below the input", () => {
    const html = renderComposer(true);

    expect(html).not.toContain("main workspace");
    expect(html).not.toContain("worktree");
    expect(html).not.toContain("home workspace");
    expect(html).not.toContain("composer-status");
    expect(html).not.toContain(">agents</span>");
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

describe("skill prompts", () => {
  const skill = {
    name: "frontend-design",
    command: "skill:frontend-design",
    description: "Create and review interfaces",
    location: "user" as const,
  };

  it("keeps Pi's canonical syntax outside the visible composer text", () => {
    const prompt = joinSkillPrompt(skill, "Improve the composer");

    expect(prompt).toBe("/skill:frontend-design Improve the composer");
    expect(splitSkillPrompt(prompt, [skill])).toEqual({ skill, text: "Improve the composer" });
  });

  it("recovers persisted skills before the capability catalog loads", () => {
    expect(splitSkillPrompt("/skill:frontend-design Review this", [])).toEqual({
      skill: { name: "frontend-design", command: "skill:frontend-design" },
      text: "Review this",
    });
  });

  it("does not turn an incomplete manual skill query into a chip", () => {
    expect(splitSkillPrompt("/skill:front", [skill])).toEqual({ text: "/skill:front" });
  });

  it("renders friendly skill results and shows attached skills as inline colored text", () => {
    const menu = renderComposer(true, { prompt: "/front", skills: [skill] });
    const attached = renderComposer(true, {
      prompt: "/skill:frontend-design Improve the composer",
      skills: [skill],
    });

    expect(menu).toContain("Skills");
    expect(menu).toContain("frontend-design");
    expect(menu).not.toContain("/skill:frontend-design");
    expect(attached).toContain("composer-invocation--skill");
    expect(attached).toContain("Remove frontend-design skill");
    expect(attached).toContain(">frontend-design</button>");
    expect(attached).toContain("Improve the composer");
    expect(attached).not.toContain("/skill:frontend-design");
  });

  it("renders commands as a distinct inline color while preserving canonical submission syntax", () => {
    const command = { name: "reload", description: "Reload extensions", source: "extension" as const };
    const prompt = joinCommandPrompt(command, "now");
    const attached = renderComposer(true, { prompt, commands: [command] });

    expect(prompt).toBe("/reload now");
    expect(splitCommandPrompt(prompt, [command])).toEqual({ command, text: "now" });
    expect(attached).toContain("composer-invocation--command");
    expect(attached).toContain("Remove reload command");
    expect(attached).toContain(">reload</button>");
    expect(attached).not.toContain(">/reload</button>");
  });

  it("matches skill names without letting unrelated descriptions replace the intended skill", () => {
    const railway = {
      name: "use-railway",
      command: "skill:use-railway",
      description: "Operate Railway infrastructure and create frontend services for users",
    };
    const menu = renderComposer(true, { prompt: "/front", skills: [railway, skill] });

    expect(menu).toContain("frontend-design");
    expect(menu).not.toContain("use-railway");
  });

  it("does not truncate the capability catalog before or after searching", () => {
    const skills = [
      skill,
      ...["github-investigation", "google-fonts-cli", "grill-me", "use-railway", "release-notes"]
        .map((name) => ({ name, command: `skill:${name}`, description: `${name} skill` })),
    ];
    const commands = [{ name: "reload", description: "Reload extensions", source: "extension" as const }];

    const initialMenu = renderComposer(true, { prompt: "/", skills, commands });
    const skillSearch = renderComposer(true, { prompt: "/front", skills, commands });
    const commandSearch = renderComposer(true, { prompt: "/reload", skills, commands });

    for (const candidate of skills) expect(initialMenu).toContain(candidate.name);
    expect(skillSearch).toContain("frontend-design");
    expect(commandSearch).toContain("/reload");
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
