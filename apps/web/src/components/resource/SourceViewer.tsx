import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";

const SOURCE_LINE_HEIGHT = 20;
const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "import",
  "in", "interface", "let", "new", "null", "of", "private", "public", "return", "static", "struct", "switch",
  "throw", "true", "try", "type", "undefined", "var", "while", "with", "yield",
]);

export function sourceLanguage(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return extension || "text";
}

type Token = { text: string; kind?: "comment" | "string" | "number" | "keyword" };

export function tokenizeSourceLine(line: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(\/\/.*$|#.*$|\/\*.*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: line.slice(cursor, index) });
    const text = match[0];
    const kind = text.startsWith("//") || text.startsWith("#") || text.startsWith("/*")
      ? "comment"
      : text.startsWith("\"") || text.startsWith("'") || text.startsWith("`")
        ? "string"
        : /^\d/.test(text)
          ? "number"
          : KEYWORDS.has(text)
            ? "keyword"
            : undefined;
    tokens.push({ text, ...(kind ? { kind } : {}) });
    cursor = index + text.length;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor) });
  return tokens;
}

export function SourceViewer({ path, text, line, column }: {
  path: string;
  text: string;
  line?: number;
  column?: number;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const targetIndex = Math.min(Math.max((line ?? 1) - 1, 0), Math.max(lines.length - 1, 0));
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => SOURCE_LINE_HEIGHT,
    overscan: 24,
    initialOffset: targetIndex * SOURCE_LINE_HEIGHT,
    initialRect: { width: 800, height: 600 },
  });

  useEffect(() => {
    if (line) virtualizer.scrollToIndex(targetIndex, { align: "center" });
    if (column && scrollerRef.current) {
      scrollerRef.current.scrollLeft = Math.max(0, (column - 1) * 8 - scrollerRef.current.clientWidth / 3);
    }
  }, [column, line, path, targetIndex, text, virtualizer]);

  if (!text.length) return <div className="resource-empty">This file is empty.</div>;

  return (
    <div
      ref={scrollerRef}
      className="source-viewer"
      role="region"
      aria-label={`Read-only source for ${path}`}
      tabIndex={0}
      data-language={sourceLanguage(path)}
      data-line-count={lines.length}
    >
      <div className="source-virtual-space" style={{ height: virtualizer.getTotalSize() }} role="list">
        {virtualizer.getVirtualItems().map((item) => {
          const lineNumber = item.index + 1;
          const content = lines[item.index] ?? "";
          const targeted = lineNumber === (line ?? 0);
          return (
            <div
              key={lineNumber}
              role="listitem"
              className={targeted ? "source-line source-line--target" : "source-line"}
              data-line={lineNumber}
              data-target-column={targeted && column ? column : undefined}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <span className="source-line-number" aria-hidden="true">{lineNumber}</span>
              <code>{tokenizeSourceLine(content).map((token, tokenIndex) => (
                token.kind
                  ? <span key={tokenIndex} className={`syntax-${token.kind}`}>{token.text}</span>
                  : token.text
              ))}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
