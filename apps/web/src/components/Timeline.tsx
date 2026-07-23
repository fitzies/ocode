import type {
  ContentBlock,
  JsonValue,
  SessionSummary,
  TimelineEntry,
  ToolEntry,
} from "@anvil/protocol";
import { Icon } from "@iconify/react";
import altArrowRightIcon from "@iconify-icons/solar/alt-arrow-right-linear";
import checkCircleIcon from "@iconify-icons/solar/check-circle-bold-duotone";
import commandIcon from "@iconify-icons/solar/command-bold-duotone";
import dangerCircleIcon from "@iconify-icons/solar/danger-circle-bold-duotone";
import infoCircleIcon from "@iconify-icons/solar/info-circle-bold-duotone";
import questionCircleIcon from "@iconify-icons/solar/question-circle-bold-duotone";
import refreshIcon from "@iconify-icons/solar/refresh-linear";
import sledgehammerIcon from "@iconify-icons/solar/sledgehammer-bold-duotone";
import starsIcon from "@iconify-icons/solar/stars-minimalistic-bold-duotone";
import { type ReactNode, useLayoutEffect, useRef } from "react";

interface TimelineProps {
  session: SessionSummary;
  entries: TimelineEntry[];
  onSuggestion: (prompt: string) => void;
}

function JsonDetails({ label, value }: { label: string; value?: JsonValue }) {
  if (value === undefined) return null;
  return (
    <details className="technical-detail">
      <summary>{label}<Icon icon={altArrowRightIcon} width={12} /></summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function ContentBlocks({ blocks, compact = false }: { blocks: ContentBlock[]; compact?: boolean }) {
  if (!blocks.length) return null;
  return (
    <div className={compact ? "content-blocks content-blocks--compact" : "content-blocks"}>
      {blocks.map((block) => {
        if (block.type === "text") return <div className="text-block" key={block.id}>{block.text}</div>;
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
    return <Icon icon={refreshIcon} className="spin" width={15} aria-label="Running" />;
  }
  if (entry.status === "failed") return <Icon icon={dangerCircleIcon} width={15} aria-label="Failed" />;
  if (entry.status === "cancelled") return <Icon icon={dangerCircleIcon} width={15} aria-label="Cancelled" />;
  return <Icon icon={checkCircleIcon} width={15} aria-label="Completed" />;
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "message") {
    const visibleContent = entry.content.filter((block) => block.type !== "toolCall");
    if (!visibleContent.length && !entry.error && entry.status !== "streaming") return null;
    const messageClass = entry.role === "user" ? "user-message" : entry.role === "assistant" ? "assistant-message" : "system-message";
    return (
      <article className={`${messageClass} message-status--${entry.status}`}>
        <ContentBlocks blocks={visibleContent} />
        {entry.status === "streaming" && <span className="stream-caret" aria-label="Streaming" />}
        {entry.error && <div className="message-error">{entry.error}</div>}
        {(entry.role === "extension" || entry.status === "failed") && <JsonDetails label="Raw message" value={entry.raw} />}
      </article>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <details className={`thinking-event thinking-event--${entry.status}`}>
        <summary>
          <Icon icon={starsIcon} width={15} />
          <span>{entry.status === "streaming" ? "Reasoning" : "Reasoning trace"}</span>
          {entry.status === "streaming" && <span className="thinking-pulse" aria-label="Streaming reasoning" />}
          {entry.status === "cancelled" && <span className="event-state-label">cancelled</span>}
          <Icon icon={altArrowRightIcon} className="disclosure-icon" width={14} />
        </summary>
        <p>{entry.content || "Reasoning stream started…"}</p>
      </details>
    );
  }

  if (entry.kind === "tool") {
    return (
      <details className={`tool-event tool-event--${entry.status}`}>
        <summary>
          <span className="tool-icon"><Icon icon={commandIcon} width={15} /></span>
          <span className="tool-main">
            <strong>{entry.summary}</strong>
            <span>{entry.name} · {entry.toolCallId}</span>
          </span>
          <span className="tool-status"><ToolStatus entry={entry} /></span>
          <Icon icon={altArrowRightIcon} className="disclosure-icon" width={14} />
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
        <span className="interaction-icon"><Icon icon={questionCircleIcon} width={16} /></span>
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
      <span className="system-event-icon"><Icon icon={entry.tone === "error" ? dangerCircleIcon : infoCircleIcon} width={16} /></span>
      <span className="system-event-copy">
        <strong>{entry.title}</strong>
        {entry.message && <span>{entry.message}</span>}
        {entry.source && <small>{entry.source}</small>}
      </span>
      <JsonDetails label="Technical details" value={entry.details ?? entry.raw} />
    </article>
  );
}

function renderEntries(entries: TimelineEntry[]): ReactNode[] {
  const rendered: ReactNode[] = [];
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
        const running = tools.filter((tool) => tool.status === "running").length;
        rendered.push(
          <section className="tool-batch" key={`batch-${entry.batchId}`} aria-label={`${tools.length} parallel tools`}>
            <div className="tool-batch-label"><span>{tools.length} parallel tools</span><small>{running ? `${running} running` : "settled"}</small></div>
            {tools.map((tool) => <TimelineItem key={tool.id} entry={tool} />)}
          </section>,
        );
        index = nextIndex;
        continue;
      }
    }
    rendered.push(<TimelineItem key={entry.id} entry={entry} />);
    index += 1;
  }
  return rendered;
}

export function Timeline({ session, entries, onSuggestion }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottom = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && shouldStickToBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [entries, session.status]);

  const trackScrollPosition = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    shouldStickToBottom.current = distanceFromBottom < 96;
  };

  if (entries.length === 0) {
    return (
      <div ref={scrollRef} className="timeline timeline--empty" onScroll={trackScrollPosition}>
        <div className="empty-mark"><Icon icon={sledgehammerIcon} width={25} /></div>
        <h2>What should Pi work on?</h2>
        <p>This session is ready for Forge. Ask a question, request a change, or replay a recorded Pi RPC fixture.</p>
        <div className="prompt-suggestions">
          {["Review the current project structure", "Help me plan the next milestone", "Summarize recent changes"].map((prompt) => (
            <button key={prompt} onClick={() => onSuggestion(prompt)}>{prompt}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="timeline" onScroll={trackScrollPosition}>
      <div className="timeline-inner">
        <div className="timeline-date"><span>Recorded session</span></div>
        <div className="timeline-events" aria-live="polite" aria-relevant="additions text">
          {renderEntries(entries)}
        </div>
        {session.status === "running" && <div className="run-tail" aria-label="Pi is working"><span /><span /><span /></div>}
      </div>
    </div>
  );
}
