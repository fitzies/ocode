export const OCODE_CONTEXT_WIDGET_KEY = "ocode.context.v1";
export const OCODE_CONTEXT_MANIFEST_VERSION = 1 as const;
export const OCODE_CONTEXT_MANIFEST_MAX_BYTES = 8 * 1024;

export const OCODE_CONTEXT_CATEGORY_IDS = [
  "system",
  "tools",
  "skills",
  "memory",
  "user",
  "assistant",
  "toolCalls",
  "toolOutput",
  "compaction",
  "other",
] as const;

export type OcodeContextCategoryId = typeof OCODE_CONTEXT_CATEGORY_IDS[number];

export const OCODE_CONTEXT_CATEGORY_LABELS: Record<OcodeContextCategoryId, string> = {
  system: "System",
  tools: "Tools",
  skills: "Skills",
  memory: "Memory",
  user: "You",
  assistant: "Assistant",
  toolCalls: "Tool calls",
  toolOutput: "Tool output",
  compaction: "Compaction",
  other: "Overhead",
};

export interface ContextManifestV1 {
  version: typeof OCODE_CONTEXT_MANIFEST_VERSION;
  capturedAt: number;
  usage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  categories: Array<{
    id: OcodeContextCategoryId;
    tokens: number;
  }>;
}

const CATEGORY_ID_SET = new Set<string>(OCODE_CONTEXT_CATEGORY_IDS);
const MAX_TOKEN_VALUE = 1_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => expected.has(key));
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isPercent(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000);
}

export function isContextManifestV1(value: unknown): value is ContextManifestV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "capturedAt", "usage", "categories"])) return false;
  if (value.version !== OCODE_CONTEXT_MANIFEST_VERSION || !isBoundedInteger(value.capturedAt, 0, Number.MAX_SAFE_INTEGER)) return false;

  const usage = value.usage;
  if (!isRecord(usage) || !hasOnlyKeys(usage, ["tokens", "contextWindow", "percent"])) return false;
  if (usage.tokens !== null && !isBoundedInteger(usage.tokens, 0, MAX_TOKEN_VALUE)) return false;
  if (!isBoundedInteger(usage.contextWindow, 1, MAX_TOKEN_VALUE) || !isPercent(usage.percent)) return false;
  if ((usage.tokens === null) !== (usage.percent === null)) return false;
  if (usage.tokens !== null && usage.percent !== null) {
    const expectedPercent = (usage.tokens / usage.contextWindow) * 100;
    if (Math.abs(usage.percent - expectedPercent) > 0.05) return false;
  }

  if (!Array.isArray(value.categories) || value.categories.length !== OCODE_CONTEXT_CATEGORY_IDS.length) return false;
  const seen = new Set<string>();
  let categoryTotal = 0;
  for (const category of value.categories) {
    if (!isRecord(category) || !hasOnlyKeys(category, ["id", "tokens"])) return false;
    if (typeof category.id !== "string" || !CATEGORY_ID_SET.has(category.id) || seen.has(category.id)) return false;
    if (!isBoundedInteger(category.tokens, 0, MAX_TOKEN_VALUE)) return false;
    categoryTotal += category.tokens;
    if (!Number.isSafeInteger(categoryTotal) || categoryTotal > MAX_TOKEN_VALUE) return false;
    seen.add(category.id);
  }
  if (usage.tokens === null ? categoryTotal !== 0 : categoryTotal !== usage.tokens) return false;
  return seen.size === OCODE_CONTEXT_CATEGORY_IDS.length;
}

export function parseContextManifestV1(payload: string): ContextManifestV1 | undefined {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > OCODE_CONTEXT_MANIFEST_MAX_BYTES) return undefined;
  if (new TextEncoder().encode(payload).byteLength > OCODE_CONTEXT_MANIFEST_MAX_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isContextManifestV1(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseContextManifestWidgetLines(lines: unknown): ContextManifestV1 | undefined {
  return Array.isArray(lines) && lines.length === 1 && typeof lines[0] === "string"
    ? parseContextManifestV1(lines[0])
    : undefined;
}

/** Reconcile local estimates to Pi's authoritative context total. */
export function reconcileContextCategories(
  estimates: Partial<Record<OcodeContextCategoryId, number>>,
  authoritativeTokens: number,
): ContextManifestV1["categories"] {
  const total = Number.isFinite(authoritativeTokens)
    ? Math.max(0, Math.min(MAX_TOKEN_VALUE, Math.round(authoritativeTokens)))
    : 0;
  const values = OCODE_CONTEXT_CATEGORY_IDS.map((id) => {
    const estimate = estimates[id];
    return {
      id,
      tokens: typeof estimate === "number" && Number.isFinite(estimate)
        ? Math.max(0, Math.min(MAX_TOKEN_VALUE, Math.round(estimate)))
        : 0,
    };
  });
  const estimatedTotal = values.reduce((sum, category) => sum + category.tokens, 0);

  if (estimatedTotal <= total) {
    values.find((category) => category.id === "other")!.tokens += total - estimatedTotal;
    return values;
  }
  if (total === 0 || estimatedTotal === 0) {
    return values.map((category) => ({ ...category, tokens: 0 }));
  }

  const scaled = values.map((category, index) => {
    const exact = (category.tokens / estimatedTotal) * total;
    return { ...category, index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = total - scaled.reduce((sum, category) => sum + category.tokens, 0);
  for (const category of [...scaled].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (unassigned-- <= 0) break;
    category.tokens++;
  }
  return scaled.map(({ id, tokens }) => ({ id, tokens }));
}
