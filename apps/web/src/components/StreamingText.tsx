import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "./MarkdownText";

const MINIMUM_CHARACTERS_PER_FRAME = 3;
const MAXIMUM_CHARACTERS_PER_FRAME = 48;

export function nextStreamingTextLength(currentLength: number, targetLength: number): number {
  const backlog = Math.max(0, targetLength - currentLength);
  if (!backlog) return targetLength;
  const step = Math.min(
    MAXIMUM_CHARACTERS_PER_FRAME,
    Math.max(MINIMUM_CHARACTERS_PER_FRAME, Math.ceil(backlog * 0.14)),
  );
  return Math.min(targetLength, currentLength + step);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function avoidSplittingSurrogatePair(text: string, length: number): number {
  if (length <= 0 || length >= text.length) return length;
  const previous = text.charCodeAt(length - 1);
  const next = text.charCodeAt(length);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? length + 1
    : length;
}

/**
 * Buffered text reveal adapted for Pi's real, growing response.
 * Existing text is shown immediately on mount; only newly received deltas are
 * paced, and any corrected/non-prefix content is applied without replaying it.
 */
export function StreamingText({ text, className = "text-block markdown-body streaming-text" }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const targetRef = useRef(text);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    targetRef.current = text;

    if (prefersReducedMotion() || !text.startsWith(shownRef.current)) {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
      shownRef.current = text;
      setShown(text);
      return;
    }

    if (shownRef.current.length >= text.length || frameRef.current !== undefined) return;

    const reveal = () => {
      const target = targetRef.current;
      const nextLength = avoidSplittingSurrogatePair(
        target,
        nextStreamingTextLength(shownRef.current.length, target.length),
      );
      const next = target.slice(0, nextLength);
      shownRef.current = next;
      setShown(next);

      if (nextLength < target.length) {
        frameRef.current = requestAnimationFrame(reveal);
      } else {
        frameRef.current = undefined;
      }
    };

    frameRef.current = requestAnimationFrame(reveal);
  }, [text]);

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
  }, []);

  return <MarkdownText className={className}>{shown}</MarkdownText>;
}
