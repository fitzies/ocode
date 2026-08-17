import {
  OCODE_CONTEXT_CATEGORY_IDS,
  OCODE_CONTEXT_WIDGET_KEY,
  type ContextManifestV1,
  type ExtensionWidget,
} from "@anvil/protocol";
import { describe, expect, it } from "vitest";

import { consumeContextManifestWidget } from "./contextManifest";

function widget(key: string, lines: string[], capturedAt = 1): ExtensionWidget {
  return {
    sessionId: "session-1",
    key,
    lines,
    placement: "aboveEditor",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function manifest(capturedAt = 1): ContextManifestV1 {
  return {
    version: 1,
    capturedAt,
    usage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
    categories: OCODE_CONTEXT_CATEGORY_IDS.map((id) => ({ id, tokens: id === "other" ? 10_000 : 0 })),
  };
}

describe("context manifest widgets", () => {
  it("consumes the reserved widget internally and preserves ordinary composer widgets", () => {
    const ordinary = widget("branch", ["main"]);
    const result = consumeContextManifestWidget([
      ordinary,
      widget(OCODE_CONTEXT_WIDGET_KEY, [JSON.stringify(manifest())]),
    ]);

    expect(result.manifest).toEqual(manifest());
    expect(result.composerWidgets).toEqual([ordinary]);
  });

  it("hides malformed reserved widgets instead of exposing telemetry JSON above the composer", () => {
    const result = consumeContextManifestWidget([
      widget(OCODE_CONTEXT_WIDGET_KEY, ["malformed"]),
      widget("status", ["Ready"]),
    ]);

    expect(result.manifest).toBeUndefined();
    expect(result.composerWidgets.map((item) => item.key)).toEqual(["status"]);
  });

  it("selects the newest valid snapshot when reconnect state contains duplicates", () => {
    const result = consumeContextManifestWidget([
      widget(OCODE_CONTEXT_WIDGET_KEY, [JSON.stringify(manifest(2))]),
      widget(OCODE_CONTEXT_WIDGET_KEY, [JSON.stringify(manifest(3))]),
    ]);
    expect(result.manifest?.capturedAt).toBe(3);
  });
});
