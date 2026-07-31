import type { ContentBlock } from "@anvil/protocol";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MarkdownNode[];
};

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "tableCell",
]);
const RAW_URL = /^(?:https?:\/\/|www\.|mailto:|[^\s@]+@[^\s@]+\.[^\s@]+$)/i;
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<]+/gi;

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function inlineText(node: MarkdownNode): string {
  if (node.type === "code" || node.type === "html") return "";
  if (node.type === "text") return normalized((node.value ?? "").replace(URL_IN_TEXT, ""));
  // Inline code is spoken literally, without announcing Markdown delimiters.
  if (node.type === "inlineCode") return normalized(node.value ?? "");
  // Useful image descriptions are spoken; source URLs and empty alt text are not.
  if (node.type === "image") {
    const alt = normalized(node.alt ?? "");
    return RAW_URL.test(alt) ? "" : alt;
  }
  if (node.type === "break") return ". ";
  if (node.type === "link") {
    const label = normalized((node.children ?? []).map(inlineText).join(" "));
    return RAW_URL.test(label) ? "" : label;
  }
  return normalized((node.children ?? []).map(inlineText).filter(Boolean).join(" "));
}

function collectSegments(node: MarkdownNode, segments: string[]): void {
  if (node.type === "code" || node.type === "html" || node.type === "image") return;

  if (BLOCK_TYPES.has(node.type)) {
    if (node.type === "blockquote" || node.type === "listItem") {
      for (const child of node.children ?? []) collectSegments(child, segments);
      return;
    }
    const value = inlineText(node);
    if (value) segments.push(value);
    return;
  }

  for (const child of node.children ?? []) collectSegments(child, segments);
}

/** Joins only original assistant text blocks, preserving their Markdown verbatim. */
export function assistantMarkdown(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * Converts GFM Markdown to deterministic speech text. Code blocks and raw HTML
 * are omitted; inline code and image alt text are spoken literally.
 */
export function markdownToSpeakableText(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode;
  const segments: string[] = [];
  collectSegments(tree, segments);
  return segments.join("\n\n");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function splitOversizedUnit(value: string, maxCodePoints: number): string[] {
  const remaining = Array.from(value);
  const result: string[] = [];
  while (remaining.length > maxCodePoints) {
    let sentenceBoundary = -1;
    let wordBoundary = -1;
    for (let index = 0; index < maxCodePoints; index += 1) {
      const character = remaining[index]!;
      const next = remaining[index + 1];
      if (/\s/u.test(character)) wordBoundary = index + 1;
      if (/[.!?。！？]/u.test(character) && (next === undefined || /\s/u.test(next))) {
        sentenceBoundary = index + 1;
      }
    }
    const boundary = sentenceBoundary > 0 ? sentenceBoundary : wordBoundary > 0 ? wordBoundary : maxCodePoints;
    const chunk = remaining.splice(0, boundary).join("").trim();
    if (chunk) result.push(chunk);
    while (remaining[0] && /\s/u.test(remaining[0])) remaining.shift();
  }
  const tail = remaining.join("").trim();
  if (tail) result.push(tail);
  return result;
}

function preferredBoundary(value: string, maxCodePoints: number, preferredMinimum: number): number {
  const characters = Array.from(value);
  if (characters.length <= maxCodePoints) return characters.length;
  let paragraph = -1;
  let sentence = -1;
  let word = -1;
  for (let index = 0; index < maxCodePoints; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    if (/\s/u.test(character)) word = index + 1;
    if (character === "\n" && next === "\n") paragraph = index;
    if (/[.!?。！？]/u.test(character) && (next === undefined || /\s/u.test(next))) sentence = index + 1;
  }
  const structuralBoundary = Math.max(paragraph, sentence);
  if (structuralBoundary >= preferredMinimum) return structuralBoundary;
  if (structuralBoundary > 0) return structuralBoundary;
  return word > 0 ? word : maxCodePoints;
}

/** Splits without truncation, preferring paragraph, sentence, then word boundaries. */
export function splitSpeakableText(text: string, maxCodePoints: number): string[] {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1) throw new Error("Speech chunk size must be positive");
  const paragraphs = text.split(/\n\s*\n/u).map(normalized).filter(Boolean);
  const units = paragraphs.flatMap((paragraph) => (
    codePointLength(paragraph) <= maxCodePoints
      ? [paragraph]
      : splitOversizedUnit(paragraph, maxCodePoints)
  ));
  const chunks: string[] = [];
  for (const unit of units) {
    const current = chunks.at(-1);
    if (current && codePointLength(`${current}\n\n${unit}`) <= maxCodePoints) {
      chunks[chunks.length - 1] = `${current}\n\n${unit}`;
    } else {
      chunks.push(unit);
    }
  }
  return chunks;
}

/**
 * Uses a deliberately short first request so speech can begin quickly, then
 * allows the provider's full request size for the remaining response.
 */
export function splitSpeakableTextForPlayback(
  text: string,
  maxCodePoints: number,
  firstChunkCodePoints = 500,
): string[] {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1) throw new Error("Speech chunk size must be positive");
  const normalizedText = text.trim();
  if (!normalizedText) return [];
  const firstMaximum = Math.min(maxCodePoints, firstChunkCodePoints);
  if (codePointLength(normalizedText) <= firstMaximum) return splitSpeakableText(normalizedText, maxCodePoints);
  const boundary = preferredBoundary(normalizedText, firstMaximum, Math.min(400, firstMaximum));
  const characters = Array.from(normalizedText);
  const first = characters.slice(0, boundary).join("").trim();
  const remaining = characters.slice(boundary).join("").trim();
  return [first, ...splitSpeakableText(remaining, maxCodePoints)].filter(Boolean);
}
