import type { SessionSummary, TimelineEntry } from "@anvil/protocol";
import { useLayoutEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import altArrowRightIcon from "@iconify-icons/solar/alt-arrow-right-linear";
import checkCircleIcon from "@iconify-icons/solar/check-circle-bold-duotone";
import commandIcon from "@iconify-icons/solar/command-bold-duotone";
import dangerCircleIcon from "@iconify-icons/solar/danger-circle-bold-duotone";
import refreshIcon from "@iconify-icons/solar/refresh-linear";
import sledgehammerIcon from "@iconify-icons/solar/sledgehammer-bold-duotone";
import starsIcon from "@iconify-icons/solar/stars-minimalistic-bold-duotone";

interface TimelineProps {
  session: SessionSummary;
  entries: TimelineEntry[];
  onSuggestion: (prompt: string) => void;
}

function ToolStatus({ entry }: { entry: Extract<TimelineEntry, { kind: "tool" }> }) {
  if (entry.status === "running") {
    return <Icon icon={refreshIcon} className="spin" width={15} />;
  }
  if (entry.status === "failed") return <Icon icon={dangerCircleIcon} width={15} />;
  return <Icon icon={checkCircleIcon} width={15} />;
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
        <div className="empty-mark"><Icon icon={sledgehammerIcon} width={25} /></div>
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
                  <Icon icon={starsIcon} width={15} />
                  <span>{entry.active ? "Thinking" : "Thought process"}</span>
                  {entry.active && <span className="thinking-pulse" />}
                  <Icon icon={altArrowRightIcon} className="disclosure-icon" width={14} />
                </summary>
                <p>{entry.content}</p>
              </details>
            );
          }

          if (entry.kind === "tool") {
            return (
              <details className={`tool-event tool-event--${entry.status}`} key={entry.id}>
                <summary>
                  <span className="tool-icon"><Icon icon={commandIcon} width={15} /></span>
                  <span className="tool-main">
                    <strong>{entry.summary}</strong>
                    <span>{entry.name}</span>
                  </span>
                  <span className="tool-status"><ToolStatus entry={entry} /></span>
                  <Icon icon={altArrowRightIcon} className="disclosure-icon" width={14} />
                </summary>
                {entry.detail && <div className="tool-detail">{entry.detail}</div>}
              </details>
            );
          }

          return (
            <article className="assistant-message" key={entry.id}>
              <div className="message-content">{entry.content}</div>
            </article>
          );
        })}
        {session.status === "running" && <div className="run-tail"><span /><span /><span /></div>}
      </div>
    </div>
  );
}
