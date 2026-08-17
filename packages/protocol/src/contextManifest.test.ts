import { describe, expect, it } from "vitest";

import {
  OCODE_CONTEXT_CATEGORY_IDS,
  OCODE_CONTEXT_MANIFEST_MAX_BYTES,
  parseContextManifestV1,
  reconcileContextCategories,
  type ContextManifestV1,
} from "./contextManifest";

function manifest(): ContextManifestV1 {
  return {
    version: 1,
    capturedAt: 1_776_000_000_000,
    usage: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
    categories: OCODE_CONTEXT_CATEGORY_IDS.map((id) => ({ id, tokens: id === "other" ? 12_000 : 0 })),
  };
}

describe("ContextManifestV1", () => {
  it("accepts only the bounded, versioned totals-only schema", () => {
    const valid = manifest();
    expect(parseContextManifestV1(JSON.stringify(valid))).toEqual(valid);

    expect(parseContextManifestV1(JSON.stringify({ ...valid, version: 2 }))).toBeUndefined();
    expect(parseContextManifestV1(JSON.stringify({ ...valid, secret: "prompt" }))).toBeUndefined();
    expect(parseContextManifestV1(JSON.stringify({
      ...valid,
      categories: valid.categories.map((category) => ({ ...category, label: category.id })),
    }))).toBeUndefined();
    expect(parseContextManifestV1(JSON.stringify({
      ...valid,
      categories: valid.categories.slice(1),
    }))).toBeUndefined();
    expect(parseContextManifestV1(JSON.stringify({
      ...valid,
      usage: { ...valid.usage, tokens: 12_001 },
    }))).toBeUndefined();
    expect(parseContextManifestV1(JSON.stringify({
      ...valid,
      usage: { ...valid.usage, percent: 60 },
    }))).toBeUndefined();
  });

  it("rejects malformed and oversized payloads before they reach product UI", () => {
    expect(parseContextManifestV1("not json")).toBeUndefined();
    expect(parseContextManifestV1("x".repeat(OCODE_CONTEXT_MANIFEST_MAX_BYTES + 1))).toBeUndefined();
    expect(parseContextManifestV1(`"${"é".repeat(OCODE_CONTEXT_MANIFEST_MAX_BYTES / 2)}"`)).toBeUndefined();
  });

  it("assigns positive residuals to provider overhead", () => {
    const categories = reconcileContextCategories({ system: 1_000, user: 2_000 }, 5_000);
    expect(categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(5_000);
    expect(categories.find((category) => category.id === "other")?.tokens).toBe(2_000);
  });

  it("proportionally reconciles overestimates to the authoritative total", () => {
    const categories = reconcileContextCategories({ system: 8_000, tools: 4_000, user: 4_000 }, 8_000);
    expect(categories.reduce((sum, category) => sum + category.tokens, 0)).toBe(8_000);
    expect(categories.find((category) => category.id === "system")?.tokens).toBe(4_000);
    expect(categories.find((category) => category.id === "tools")?.tokens).toBe(2_000);
    expect(categories.find((category) => category.id === "user")?.tokens).toBe(2_000);
  });
});
