import type { SessionSummary, TimelineEntry } from "@anvil/protocol";
import { useLayoutEffect, useRef } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Hammer,
  LoaderCircle,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

interface TimelineProps {
  session: SessionSummary;
  entries: TimelineEntry[];
  onSuggestion: (prompt: string) => void;
}

function ToolStatus({ entry }: { entry: Extract<TimelineEntry, { kind: "tool" }> }) {
  if (entry.status === "running") return <LoaderCircle className="spin" size={14} />;
  if (entry.status === "failed") return <CircleAlert size={14} />;
  return <Check size={14} />;
}

export function Timeline({ session, entries, onSuggestion }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottom = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && shouldStickToBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
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
        <div className="empty-mark"><Hammer size={23} /></div>
        <h2>What should Pi work on?</h2>
        <p>
          This session is attached to Forge. Ask a question, request a change, or continue work from
          another device.
        </p>
        <div className="prompt-suggestions">
          {[
            "Review the current project structure",
            "Help me plan the next milestone",
            "Summarize recent changes",
          ].map((prompt) => (
            <button key={prompt} onClick={() => onSuggestion(prompt)}>{prompt}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="timeline" aria-live="polite" onScroll={trackScrollPosition}>
      <div className="timeline-inner">
        <div className="timeline-date"><span>Today</span></div>
        {entries.map((entry) => {
          if (entry.kind === "message" && entry.role === "user") {
            return (
              <article className="user-message" key={entry.id}>
                <div className="message-content">{entry.content}</div>
              </article>
            );
          }

          if (entry.kind === "thinking") {
            return (
              <details className="thinking-event" key={entry.id} open={entry.active}>
                <summary>
                  <Sparkles size={14} />
                  <span>{entry.active ? "Thinking" : "Thought process"}</span>
                  {entry.active && <span className="thinking-pulse" />}
                  <ChevronRight className="disclosure-icon" size={14} />
                </summary>
                <p>{entry.content}</p>
              </details>
            );
          }

          if (entry.kind === "tool") {
            return (
              <details className={`tool-event tool-event--${entry.status}`} key={entry.id}>
                <summary>
                  <span className="tool-icon"><TerminalSquare size={14} /></span>
                  <span className="tool-main">
                    <strong>{entry.summary}</strong>
                    <span>{entry.name}</span>
                  </span>
                  <span className="tool-status"><ToolStatus entry={entry} /></span>
                  <ChevronRight className="disclosure-icon" size={14} />
                </summary>
                {entry.detail && <div className="tool-detail">{entry.detail}</div>}
              </details>
            );
          }

          return (
            <article className="assistant-message" key={entry.id}>
              <div className="assistant-avatar"><Hammer size={14} /></div>
              <div>
                <div className="assistant-label">Pi</div>
                <div className="message-content">{entry.content}</div>
              </div>
            </article>
          );
        })}
        {session.status === "running" && <div className="run-tail"><span /><span /><span /></div>}
      </div>
    </div>
  );
}
