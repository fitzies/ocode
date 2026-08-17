import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nextStreamingTextLength, StreamingText } from "./StreamingText";

describe("StreamingText", () => {
  it("shows existing content immediately and preserves Markdown rendering", () => {
    const html = renderToStaticMarkup(<StreamingText text="Building **smoothly**" />);

    expect(html).toContain("streaming-text");
    expect(html).toContain("Building ");
    expect(html).toContain("<strong>smoothly</strong>");
  });

  it("paces small deltas while catching up with large backlogs", () => {
    expect(nextStreamingTextLength(10, 10)).toBe(10);
    expect(nextStreamingTextLength(10, 12)).toBe(12);
    expect(nextStreamingTextLength(10, 110)).toBe(25);
    expect(nextStreamingTextLength(10, 10_000)).toBe(58);
  });
});
