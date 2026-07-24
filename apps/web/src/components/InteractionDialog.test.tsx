import type { InteractionRequest } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InteractionPanel } from "./InteractionDialog";

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
  it("renders multi-select inside the originating thread rather than a global modal", () => {
    const html = renderToStaticMarkup(
      <InteractionPanel requests={[request]} onRespond={() => undefined} />,
    );

    expect(html).toContain("interaction-panel-wrap");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Typecheck");
    expect(html).toContain("this thread");
    expect(html).not.toContain("dialog-backdrop");
    expect(html).not.toContain('aria-modal="true"');
  });
});
