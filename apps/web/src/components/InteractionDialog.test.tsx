import type { InteractionRequest } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  askUserQuestionAnswerIsValid,
  buildAskUserQuestionResponseValue,
} from "./AskUserQuestion";
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

  it("builds deterministic ask responses and requires meaningful option answers", () => {
    expect(askUserQuestionAnswerIsValid("single-select", [], true, "   ")).toBe(false);
    expect(askUserQuestionAnswerIsValid("single-select", [], true, "Custom")).toBe(true);
    expect(askUserQuestionAnswerIsValid("multi-select", [], false, "")).toBe(false);
    expect(askUserQuestionAnswerIsValid("multi-select", [1], false, "")).toBe(true);
    expect(buildAskUserQuestionResponseValue("multi-select", [1, 0, 1], true, "  Custom  ")).toEqual({
      kind: "ocode.ask-user-question-response",
      schemaVersion: 1,
      answers: [
        { type: "option", optionIndex: 0 },
        { type: "option", optionIndex: 1 },
        { type: "other", value: "Custom" },
      ],
    });
  });

  it("renders a minimal specialized shadcn ask_user_question", () => {
    const askRequest: InteractionRequest = {
      id: "ask-1",
      sessionId: "session-1",
      method: "select",
      title: "Choose an architecture",
      message: "This choice affects future maintenance.",
      requestedAt: "2026-07-23T01:00:00.000Z",
      options: [
        { id: "ask-option-0", label: "Direct", value: "direct", description: "Smallest change" },
        { id: "ask-option-1", label: "Layered", value: "layered", description: "More extensible" },
      ],
      presentation: { type: "ask_user_question", schemaVersion: 1, otherLabel: "Other" },
    };
    const html = renderToStaticMarkup(
      <InteractionPanel requests={[askRequest]} onRespond={() => undefined} />,
    );

    expect(html).toContain('data-presentation="ask-user-question"');
    expect(html).toContain('data-slot="radio-group"');
    expect(html).toContain('data-slot="radio-group-item"');
    expect(html).not.toContain("Smallest change");
    expect(html).not.toContain("More extensible");
    expect(html).toContain("Other");
    expect(html).toContain("Submit");
    expect(html).toContain("Choose one");
    expect(html).not.toContain("this thread");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain("pb-[var(--composer-overlay-height)]");

    const multiHtml = renderToStaticMarkup(
      <InteractionPanel
        requests={[{ ...askRequest, method: "multiSelect", minSelections: 1 }]}
        onRespond={() => undefined}
      />,
    );
    expect(multiHtml).toContain('data-slot="checkbox"');
    expect(multiHtml).toContain("Choose one or more answers");
    expect(multiHtml).not.toContain("Select at least one answer.");
    expect(multiHtml).not.toContain("Choose an option or provide a custom answer.");
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
    expect(html).not.toContain("this thread");
    expect(html).not.toContain("dialog-backdrop");
    expect(html).not.toContain('aria-modal="true"');
  });
});
