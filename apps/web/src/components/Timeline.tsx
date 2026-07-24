import type {
  ArtifactReference,
  ContentBlock,
  JsonValue,
  SessionSummary,
  TimelineEntry,
  ToolEntry,
} from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  CommandIcon,
  HelpCircleIcon,
  InformationCircleIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface TimelineProps {
  session: SessionSummary;
  entries: TimelineEntry[];
  loading?: boolean;
  onSuggestion: (prompt: string) => void;
}

const WORKING_MESSAGES = [
  "Locking in…",
  "Dialing in…",
  "Cooking…",
  "Bug hunting…",
  "Reading stack…",
  "Parsing vibes…",
  "Tracing bugs…",
  "Pushing pixels…",
  "Moving bytes…",
  "Diffmaxxing…",
  "Contextmaxxing…",
  "Refactormaxxing…",
  "Testmaxxing…",
  "Finding alpha…",
  "Token farming…",
  "Optimizing…",
] as const;

function workingMessage(key: string): string {
  let hash = 0;
  for (const character of key) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return WORKING_MESSAGES[Math.abs(hash) % WORKING_MESSAGES.length]!;
}

function hasVisibleContent(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => (
    block.type !== "toolCall" && (block.type !== "text" || block.text.length > 0)
  ));
}

function artifactReference(value: JsonValue | undefined): ArtifactReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (
    record.type !== "artifactReference" ||
    typeof record.artifactId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.artifactId) ||
    typeof record.url !== "string" ||
    record.url !== `/api/v1/artifacts/${record.artifactId}` ||
    typeof record.mediaType !== "string" ||
    typeof record.byteLength !== "number"
  ) return undefined;
  return record as unknown as ArtifactReference;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function ArtifactLink({ artifact, preview }: {
  artifact: Omit<ArtifactReference, "type">;
  preview?: string;
}) {
  const safeUrl = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifact.artifactId) &&
    artifact.url === `/api/v1/artifacts/${artifact.artifactId}`;
  if (!safeUrl) return <span className="artifact-unavailable">Invalid artifact reference</span>;
  return (
    <div className="artifact-block">
      {preview && <pre>{preview}</pre>}
      <a href={artifact.url} download={artifact.name}>
        <span>{artifact.name ?? "Download artifact"}</span>
        <small>{formatBytes(artifact.byteLength)} · {artifact.mediaType}</small>
      </a>
    </div>
  );
}

function JsonDetails({ label, value }: { label: string; value?: JsonValue }) {
  if (value === undefined) return null;
  const artifact = artifactReference(value);
  if (artifact) return <ArtifactLink artifact={artifact} />;
  return (
    <details className="technical-detail">
      <summary>{label}<HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3" /></summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table {...props} />
    </div>
  ),
};

const MarkdownText = memo(function MarkdownText({
  children,
  className = "text-block markdown-body",
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{children}</Markdown>
    </div>
  );
});

function ContentBlocks({ blocks, compact = false }: { blocks: ContentBlock[]; compact?: boolean }) {
  if (!blocks.length) return null;
  return (
    <div className={compact ? "content-blocks content-blocks--compact" : "content-blocks"}>
      {blocks.map((block) => {
        if (block.type === "text") {
          return compact
            ? <div className="text-block" key={block.id}>{block.text}</div>
            : <MarkdownText key={block.id}>{block.text}</MarkdownText>;
        }
        if (block.type === "artifact") {
          return <ArtifactLink key={block.id} artifact={block} preview={block.preview} />;
        }
        if (block.type === "image") {
          const source = block.url ?? (block.data ? `data:${block.mimeType};base64,${block.data}` : undefined);
          return (
            <figure className="image-block" key={block.id}>
              {source ? <img src={source} alt={block.alt ?? block.name ?? "Tool output"} /> : <div className="image-placeholder">Image data unavailable</div>}
              {(block.name || block.alt) && <figcaption>{block.name ?? block.alt}</figcaption>}
            </figure>
          );
        }
        if (block.type === "data") return <JsonDetails key={block.id} label={block.label ?? "Structured data"} value={block.data} />;
        if (block.type === "toolCall") return null;
        return <JsonDetails key={block.id} label={`Unknown content: ${block.contentType}`} value={block.raw} />;
      })}
    </div>
  );
}

function ToolStatus({ entry }: { entry: ToolEntry }) {
  if (entry.status === "running" || entry.status === "queued") {
    return <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="spin size-3.5" aria-label="Running" />;
  }
  if (entry.status === "failed") return <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-3.5" aria-label="Failed" />;
  if (entry.status === "cancelled") return <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-3.5" aria-label="Cancelled" />;
  return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-3.5" aria-label="Completed" />;
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "message") {
    const visibleContent = entry.content.filter((block) => block.type !== "toolCall");
    if (!visibleContent.length && !entry.error && entry.status !== "streaming") return null;
    const messageClass = entry.role === "user" ? "user-message" : entry.role === "assistant" ? "assistant-message" : "system-message";
    return (
      <article className={`${messageClass} message-status--${entry.status}`}>
        <ContentBlocks blocks={visibleContent} />
        {entry.status === "streaming" && entry.role === "user" && entry.id.startsWith("optimistic-")
          ? <span className="message-pending" role="status">Sending…</span>
          : entry.status === "streaming" && hasVisibleContent(visibleContent) && <span className="stream-caret" aria-label="Streaming" />}
        {entry.error && <div className="message-error">{entry.error}</div>}
        {(entry.role === "extension" || entry.status === "failed") && <JsonDetails label="Raw message" value={entry.raw} />}
      </article>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <div className={`thinking-event thinking-event--${entry.status}`}>
        <span className="thinking-label">Thinking:</span>
        <MarkdownText className="thinking-markdown markdown-body">
          {entry.content || "Getting started…"}
        </MarkdownText>
        {entry.status === "cancelled" && <span className="event-state-label">cancelled</span>}
      </div>
    );
  }

  if (entry.kind === "tool") {
    const failureBlock = entry.status === "failed"
      ? entry.output.find((block) => block.type === "text" && block.text.trim())
      : undefined;
    const failureText = failureBlock?.type === "text" ? failureBlock.text : undefined;
    return (
      <details className={`tool-event tool-event--${entry.status}`}>
        <summary>
          <span className="tool-icon"><HugeiconsIcon icon={CommandIcon} strokeWidth={2} className="size-3.5" /></span>
          <span className="tool-main">
            <strong>{entry.summary}</strong>
            <span className={failureText ? "tool-failure-summary" : undefined}>
              {failureText ?? `${entry.name} · ${entry.toolCallId}`}
            </span>
          </span>
          <span className="tool-status"><ToolStatus entry={entry} /></span>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="disclosure-icon size-3.5" />
        </summary>
        <div className="tool-detail">
          {entry.output.length > 0 && <section className="tool-output"><span className="detail-label">Output</span><ContentBlocks blocks={entry.output} compact /></section>}
          <JsonDetails label="Arguments" value={entry.arguments} />
          <JsonDetails label="Details" value={entry.details} />
          <JsonDetails label="Raw RPC event" value={entry.raw} />
        </div>
      </details>
    );
  }

  if (entry.kind === "interaction") {
    return (
      <article className={`interaction-event interaction-event--${entry.status}`}>
        <span className="interaction-icon"><HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} className="size-4" /></span>
        <span className="interaction-copy">
          <strong>{entry.title}</strong>
          <span>{entry.summary ?? (entry.status === "pending" ? "Waiting for your response" : `Request ${entry.status}`)}</span>
        </span>
        <span className="event-state-label">{entry.status}</span>
        <JsonDetails label="Request payload" value={entry.raw} />
      </article>
    );
  }

  return (
    <article className={`system-event system-event--${entry.tone}`}>
      <span className="system-event-icon"><HugeiconsIcon icon={entry.tone === "error" ? AlertCircleIcon : InformationCircleIcon} strokeWidth={2} className="size-4" /></span>
      <span className="system-event-copy">
        <strong>{entry.title}</strong>
        {entry.message && <span>{entry.message}</span>}
        {entry.source && <small>{entry.source}</small>}
      </span>
      <JsonDetails label="Technical details" value={entry.details ?? entry.raw} />
    </article>
  );
}

type TimelineRow =
  | { key: string; kind: "entry"; entry: TimelineEntry }
  | { key: string; kind: "tool-batch"; tools: ToolEntry[] };

function timelineRows(entries: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind === "tool" && entry.batchId) {
      const tools: ToolEntry[] = [entry];
      let nextIndex = index + 1;
      while (nextIndex < entries.length) {
        const candidate = entries[nextIndex];
        if (candidate?.kind !== "tool" || candidate.batchId !== entry.batchId) break;
        tools.push(candidate);
        nextIndex += 1;
      }
      if (tools.length > 1) {
        rows.push({ key: `batch-${entry.batchId}`, kind: "tool-batch", tools });
        index = nextIndex;
        continue;
      }
    }
    rows.push({ key: entry.id, kind: "entry", entry });
    index += 1;
  }
  return rows;
}

function TimelineRowView({ row }: { row: TimelineRow }) {
  if (row.kind === "entry") return <TimelineItem entry={row.entry} />;
  const running = row.tools.filter((tool) => tool.status === "running").length;
  return (
    <section className="tool-batch" aria-label={`${row.tools.length} parallel tools`}>
      <div className="tool-batch-label">
        <span>{row.tools.length} parallel tools</span>
        <small>{running ? `${running} running` : "settled"}</small>
      </div>
      {row.tools.map((tool) => <TimelineItem key={tool.id} entry={tool} />)}
    </section>
  );
}

export const Timeline = memo(function Timeline({ session, entries, loading = false }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottom = useRef(true);
  const rows = useMemo(() => timelineRows(entries), [entries]);
  const virtualized = rows.length > 100;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "tool-batch" ? 180 : 96,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });
  const activeTool = entries.some((entry) => entry.kind === "tool" && (entry.status === "running" || entry.status === "queued"));
  const streamingResponse = entries.some((entry) => (
    entry.kind === "message" &&
    entry.role === "assistant" &&
    entry.status === "streaming" &&
    hasVisibleContent(entry.content)
  ));
  const lastUserMessage = [...entries].reverse().find((entry) => entry.kind === "message" && entry.role === "user");
  const showWorkingStatus = session.status === "running" && !activeTool && !streamingResponse;
  const statusMessage = workingMessage(`${session.id}:${lastUserMessage?.id ?? "start"}`);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !shouldStickToBottom.current) return;

    if (virtualized && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
    scroller.scrollTop = scroller.scrollHeight;

    const frame = requestAnimationFrame(() => {
      if (shouldStickToBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, rows.length, session.status, virtualized, virtualizer]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;

    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottom.current) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (shouldStickToBottom.current) scroller.scrollTop = scroller.scrollHeight;
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  const trackScrollPosition = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    shouldStickToBottom.current = distanceFromBottom < 96;
  };

  if (entries.length === 0) {
    return (
      <div ref={scrollRef} className="timeline timeline--empty" onScroll={trackScrollPosition}>
        {loading ? (
          <div role="status" aria-label="Loading thread">
            <span className="forge-spinner" aria-hidden="true" />
          </div>
        ) : (
          <h2>What should Pi work on?</h2>
        )}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="timeline" onScroll={trackScrollPosition}>
      <div ref={contentRef} className="timeline-inner">
        <div className="timeline-date"><span>Recorded session</span></div>
        <div className="timeline-events" aria-live="polite" aria-relevant="additions text">
          {virtualized ? (
            <div className="timeline-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]!;
                return (
                  <div
                    className="timeline-virtual-row"
                    data-index={item.index}
                    key={row.key}
                    ref={virtualizer.measureElement}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <TimelineRowView row={row} />
                  </div>
                );
              })}
            </div>
          ) : rows.map((row) => <TimelineRowView key={row.key} row={row} />)}
        </div>
        {showWorkingStatus && (
          <div className="working-status" role="status" aria-live="polite">
            <span className="thinking-ellipsis" aria-hidden="true"><i /><i /><i /></span>
            <span>{statusMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
});
