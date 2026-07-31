import type { ContentBlock } from "@anvil/protocol";
import { describe, expect, it } from "vitest";
import { assistantMarkdown, markdownToSpeakableText, splitSpeakableText, splitSpeakableTextForPlayback } from "./speechText";

describe("speech text", () => {
  it("copies only original text blocks and preserves their Markdown", () => {
    const blocks: ContentBlock[] = [
      { id: "a", type: "text", text: "**First**" },
      { id: "tool", type: "toolCall", toolCallId: "call", name: "read", arguments: {} },
      { id: "image", type: "image", mimeType: "image/png", data: "cG5n", alt: "Screenshot" },
      { id: "b", type: "text", text: "Second\nline" },
    ];
    expect(assistantMarkdown(blocks)).toBe("**First**\n\nSecond\nline");
  });

  it("serializes GFM structure while omitting code, HTML, and raw URLs", () => {
    const markdown = [
      "# Release notes",
      "",
      "Read [the guide](https://example.com/guide), not https://example.com/raw.",
      "",
      "- Use `pnpm test`",
      "- ![Architecture diagram](diagram.png)",
      "",
      "> A quoted note",
      "",
      "| Name | State |",
      "| --- | --- |",
      "| Web | Ready |",
      "",
      "```ts",
      "const secret = true",
      "```",
      "",
      "    indented code",
      "",
      "<div>raw block</div>",
    ].join("\n");

    const speech = markdownToSpeakableText(markdown);
    expect(speech).toContain("Release notes\n\nRead the guide, not.");
    expect(speech).toContain("Use pnpm test");
    expect(speech).toContain("Architecture diagram");
    expect(speech).toContain("A quoted note");
    expect(speech).toContain("Name\n\nState\n\nWeb\n\nReady");
    expect(speech).not.toContain("example.com");
    expect(speech).not.toContain("secret");
    expect(speech).not.toContain("indented code");
    expect(speech).not.toContain("raw block");
  });

  it("splits by Unicode code points without truncating", () => {
    const text = "One two. Three four.\n\n🙂🙂🙂🙂🙂🙂";
    const chunks = splitSpeakableText(text, 10);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 10)).toBe(true);
    expect(chunks).toEqual(["One two.", "Three", "four.", "🙂🙂🙂🙂🙂🙂"]);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe("One two. Three four. 🙂🙂🙂🙂🙂🙂");
  });

  it("makes only the first playback chunk short, preferring a sentence boundary", () => {
    const firstSentence = `${"a".repeat(430)}.`;
    const remainder = `${"b".repeat(700)} ${"c".repeat(700)}`;
    const chunks = splitSpeakableTextForPlayback(`${firstSentence} ${remainder}`, 1_500);
    expect(chunks[0]).toBe(firstSentence);
    expect(Array.from(chunks[0]!).length).toBeGreaterThanOrEqual(400);
    expect(Array.from(chunks[0]!).length).toBeLessThanOrEqual(500);
    expect(Array.from(chunks[1]!).length).toBeGreaterThan(500);
    expect(chunks.join(" ")).toBe(`${firstSentence} ${remainder}`);
  });

  it("hard-splits a single oversized Unicode token", () => {
    expect(splitSpeakableText("🙂🙂🙂🙂🙂", 2)).toEqual(["🙂🙂", "🙂🙂", "🙂"]);
  });
});
