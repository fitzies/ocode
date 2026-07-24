import type { InteractionRequest } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractionPanel, selectionCountIsValid } from "./InteractionDialog";

const request: InteractionRequest = {
  id: "multi-1",
  sessionId: "session-1",
  method: "multiSelect",
  title: "Choose checks",
  message: "Select everything that applies.",
  requestedAt: "2026-07-23T01:00:00.000Z",
  options: [
    { id: "types", label: "Typecheck", value: "types" },
    { id: "tests", label: "Tests", value: "tests" },
  ],
  minSelections: 1,
};

describe("InteractionPanel", () => {
  it("enforces multi-select minimum and maximum counts", () => {
    expect(selectionCountIsValid(0, 1, 2)).toBe(false);
    expect(selectionCountIsValid(1, 1, 2)).toBe(true);
    expect(selectionCountIsValid(2, 1, 2)).toBe(true);
    expect(selectionCountIsValid(3, 1, 2)).toBe(false);
  });

  it("renders multi-select inside the originating thread rather than a global modal", () => {
    const html = renderToStaticMarkup(
      <InteractionPanel requests={[request]} onRespond={() => undefined} />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Choose checks"');
    expect(html).toContain("Search and select…");
    expect(html).toContain("Choose at least 1");
    expect(html).toContain('aria-describedby="selection-requirement-multi-1"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("this thread");
    expect(html).not.toContain("dialog-backdrop");
    expect(html).not.toContain('aria-modal="true"');
  });
});
