import {
  OCODE_CONTEXT_CATEGORY_IDS,
  OCODE_CONTEXT_MANIFEST_MAX_BYTES,
  OCODE_CONTEXT_WIDGET_KEY,
  reconcileContextCategories,
  type ContextManifestV1,
  type OcodeContextCategoryId,
} from "@anvil/protocol";

const IMAGE_ESTIMATED_CHARS = 4_800;
const MAX_ESTIMATED_CHARS = 100_000_000;

type CategoryEstimates = Partial<Record<OcodeContextCategoryId, number>>;

interface PromptSkill {
  name?: unknown;
  description?: unknown;
  filePath?: unknown;
  disableModelInvocation?: unknown;
}

export interface ContextSystemPromptOptions {
  customPrompt?: unknown;
  selectedTools?: unknown;
  toolSnippets?: unknown;
  promptGuidelines?: unknown;
  appendSystemPrompt?: unknown;
  cwd?: unknown;
  contextFiles?: unknown;
  skills?: unknown;
}

interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ContextBridgeContext {
  ui: { setWidget(key: string, lines: string[] | undefined): void };
  model?: { contextWindow?: number };
  getContextUsage(): ContextUsageLike | undefined;
  getSystemPrompt(): string;
  sessionManager: {
    buildSessionContext?(): { messages?: unknown[] };
  };
}

export interface ContextBridgeApi {
  on(event: string, handler: (event: Record<string, unknown>, context: ContextBridgeContext) => void): void;
  getAllTools(): Array<{ name: string; description?: string; parameters?: unknown }>;
  getActiveTools(): string[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedLength(value: unknown): number {
  return typeof value === "string" ? Math.min(MAX_ESTIMATED_CHARS, value.length) : 0;
}

function tokenEstimate(chars: number): number {
  return Math.ceil(Math.max(0, Math.min(MAX_ESTIMATED_CHARS, chars)) / 4);
}

function addEstimate(estimates: CategoryEstimates, id: OcodeContextCategoryId, tokens: number): void {
  estimates[id] = (estimates[id] ?? 0) + Math.max(0, Math.round(tokens));
}

function escapedXmlLength(value: unknown): number {
  if (typeof value !== "string") return 0;
  let length = 0;
  for (const character of value) {
    length += character === "&" ? 5 : character === "<" || character === ">" ? 4 : character === '"' || character === "'" ? 6 : 1;
  }
  return length;
}

function safeJsonLength(value: unknown): number {
  try {
    return Math.min(MAX_ESTIMATED_CHARS, JSON.stringify(value)?.length ?? 0);
  } catch {
    return 0;
  }
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return boundedLength(content);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const item of content) {
    const block = recordOf(item);
    if (!block) continue;
    if (block.type === "text") chars += boundedLength(block.text);
    else if (block.type === "image") chars += IMAGE_ESTIMATED_CHARS;
  }
  return Math.min(MAX_ESTIMATED_CHARS, chars);
}

export function estimateSystemPromptCategories(
  systemPrompt: string,
  options: ContextSystemPromptOptions | undefined,
): CategoryEstimates {
  const totalChars = boundedLength(systemPrompt);
  if (!options) return { system: tokenEstimate(totalChars) };

  let memoryChars = 0;
  if (Array.isArray(options.contextFiles) && options.contextFiles.length > 0) {
    memoryChars += 90;
    for (const item of options.contextFiles) {
      const file = recordOf(item);
      if (!file) continue;
      memoryChars += boundedLength(file.path) + boundedLength(file.content) + 65;
    }
  }

  const selectedTools = Array.isArray(options.selectedTools)
    ? options.selectedTools.filter((value): value is string => typeof value === "string")
    : [];
  const hasRead = selectedTools.length === 0 || selectedTools.includes("read");
  let skillsChars = 0;
  if (hasRead && Array.isArray(options.skills)) {
    const visible = (options.skills as PromptSkill[]).filter((skill) => skill?.disableModelInvocation !== true);
    if (visible.length > 0) {
      skillsChars += 330;
      for (const skill of visible) {
        skillsChars += escapedXmlLength(skill.name) + escapedXmlLength(skill.description) + escapedXmlLength(skill.filePath) + 85;
      }
    }
  }

  let toolPromptChars = 0;
  if (typeof options.customPrompt !== "string") {
    const snippets = recordOf(options.toolSnippets);
    if (snippets) {
      for (const name of selectedTools) {
        if (typeof snippets[name] === "string") toolPromptChars += name.length + snippets[name].length + 4;
      }
    }
    if (Array.isArray(options.promptGuidelines)) {
      for (const guideline of options.promptGuidelines) toolPromptChars += boundedLength(guideline) + 3;
    }
  }

  const allocated = memoryChars + skillsChars + toolPromptChars;
  const scale = allocated > totalChars && allocated > 0 ? totalChars / allocated : 1;
  const memory = tokenEstimate(memoryChars * scale);
  const skills = tokenEstimate(skillsChars * scale);
  const tools = tokenEstimate(toolPromptChars * scale);
  return {
    system: tokenEstimate(Math.max(0, totalChars - Math.min(totalChars, allocated))),
    memory,
    skills,
    tools,
  };
}

export function estimateToolDefinitionTokens(api: Pick<ContextBridgeApi, "getAllTools" | "getActiveTools">): number {
  try {
    const active = new Set(api.getActiveTools());
    let chars = 0;
    for (const tool of api.getAllTools()) {
      if (!active.has(tool.name)) continue;
      chars += safeJsonLength({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? {},
      }) + 24;
    }
    return tokenEstimate(chars);
  } catch {
    return 0;
  }
}

export function estimateMessageCategories(messages: unknown[]): CategoryEstimates {
  const estimates: CategoryEstimates = {};
  for (const value of messages) {
    const message = recordOf(value);
    if (!message || typeof message.role !== "string") continue;
    switch (message.role) {
      case "user":
        addEstimate(estimates, "user", tokenEstimate(contentChars(message.content)));
        break;
      case "assistant": {
        if (!Array.isArray(message.content)) break;
        let assistantChars = 0;
        let toolCallChars = 0;
        for (const item of message.content) {
          const block = recordOf(item);
          if (!block) continue;
          if (block.type === "text") assistantChars += boundedLength(block.text);
          else if (block.type === "thinking") assistantChars += boundedLength(block.thinking);
          else if (block.type === "toolCall") toolCallChars += boundedLength(block.name) + safeJsonLength(block.arguments);
        }
        addEstimate(estimates, "assistant", tokenEstimate(assistantChars));
        addEstimate(estimates, "toolCalls", tokenEstimate(toolCallChars));
        break;
      }
      case "toolResult":
        addEstimate(estimates, "toolOutput", tokenEstimate(contentChars(message.content)));
        break;
      case "bashExecution":
        if (message.excludeFromContext !== true) {
          addEstimate(estimates, "toolCalls", tokenEstimate(boundedLength(message.command)));
          addEstimate(estimates, "toolOutput", tokenEstimate(boundedLength(message.output)));
        }
        break;
      case "compactionSummary":
      case "branchSummary":
        addEstimate(estimates, "compaction", tokenEstimate(boundedLength(message.summary)));
        break;
      case "custom":
        addEstimate(estimates, "memory", tokenEstimate(contentChars(message.content)));
        break;
      default:
        addEstimate(estimates, "other", tokenEstimate(safeJsonLength(message)));
    }
  }
  return estimates;
}

function alignPromptEstimatesToFinalSystemPrompt(
  estimates: CategoryEstimates,
  systemPrompt: string,
): CategoryEstimates {
  const total = tokenEstimate(boundedLength(systemPrompt));
  const promptIds: OcodeContextCategoryId[] = ["system", "tools", "skills", "memory"];
  const estimated = promptIds.reduce((sum, id) => sum + (estimates[id] ?? 0), 0);
  if (estimated <= total) return { ...estimates, system: (estimates.system ?? 0) + total - estimated };
  if (total === 0 || estimated === 0) return { system: 0, tools: 0, skills: 0, memory: 0 };

  const scaled = promptIds.map((id, index) => {
    const exact = ((estimates[id] ?? 0) / estimated) * total;
    return { id, index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - scaled.reduce((sum, category) => sum + category.tokens, 0);
  for (const category of [...scaled].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining-- <= 0) break;
    category.tokens++;
  }
  return Object.fromEntries(scaled.map((category) => [category.id, category.tokens]));
}

function mergeEstimates(...groups: CategoryEstimates[]): CategoryEstimates {
  const merged: CategoryEstimates = {};
  for (const group of groups) {
    for (const id of OCODE_CONTEXT_CATEGORY_IDS) addEstimate(merged, id, group[id] ?? 0);
  }
  return merged;
}

function contextMessages(context: ContextBridgeContext): unknown[] {
  try {
    const messages = context.sessionManager.buildSessionContext?.().messages;
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

export function registerContextManifestBridge(api: ContextBridgeApi): void {
  let promptEstimates: CategoryEstimates = {};
  let messages: unknown[] = [];
  let lastSignature: string | undefined;

  const emit = (context: ContextBridgeContext) => {
    const rawUsage = context.getContextUsage();
    const contextWindow = Math.round(rawUsage?.contextWindow ?? context.model?.contextWindow ?? 0);
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;

    const tokens = rawUsage?.tokens === null || rawUsage?.tokens === undefined
      ? null
      : Math.max(0, Math.round(rawUsage.tokens));
    const percent = tokens === null
      ? null
      : Math.min(1_000, (tokens / contextWindow) * 100);
    const estimates = mergeEstimates(
      promptEstimates.system === undefined ? estimateSystemPromptCategories(context.getSystemPrompt(), undefined) : promptEstimates,
      { tools: estimateToolDefinitionTokens(api) },
      estimateMessageCategories(messages),
    );
    const categories = tokens === null
      ? reconcileContextCategories({}, 0)
      : reconcileContextCategories(estimates, tokens);
    const stable = { usage: { tokens, contextWindow, percent }, categories };
    const signature = JSON.stringify(stable);
    if (signature === lastSignature) return;

    const manifest: ContextManifestV1 = {
      version: 1,
      capturedAt: Date.now(),
      ...stable,
    };
    const payload = JSON.stringify(manifest);
    if (new TextEncoder().encode(payload).byteLength > OCODE_CONTEXT_MANIFEST_MAX_BYTES) return;
    context.ui.setWidget(OCODE_CONTEXT_WIDGET_KEY, [payload]);
    lastSignature = signature;
  };

  api.on("session_start", (_event, context) => {
    promptEstimates = estimateSystemPromptCategories(context.getSystemPrompt(), undefined);
    messages = contextMessages(context);
    emit(context);
  });
  api.on("before_agent_start", (event, context) => {
    const options = recordOf(event.systemPromptOptions) as ContextSystemPromptOptions | undefined;
    promptEstimates = estimateSystemPromptCategories(
      typeof event.systemPrompt === "string" ? event.systemPrompt : context.getSystemPrompt(),
      options,
    );
  });
  api.on("context", (event, context) => {
    // All before_agent_start handlers have completed by this point, so align the
    // structured breakdown to Pi's final chained system prompt. Context handlers
    // loaded after this extension remain unobservable; their delta is reconciled
    // into provider overhead once Pi reports authoritative usage.
    promptEstimates = alignPromptEstimatesToFinalSystemPrompt(promptEstimates, context.getSystemPrompt());
    messages = Array.isArray(event.messages) ? event.messages : messages;
    emit(context);
  });
  api.on("agent_settled", (_event, context) => {
    messages = contextMessages(context);
    emit(context);
  });
  api.on("session_compact", (_event, context) => {
    messages = contextMessages(context);
    emit(context);
  });
  api.on("session_tree", (_event, context) => {
    messages = contextMessages(context);
    emit(context);
  });
  api.on("model_select", (_event, context) => emit(context));
}
