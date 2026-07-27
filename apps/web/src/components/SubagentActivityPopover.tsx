import type { JsonValue, ToolEntry, ToolStatus } from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Copy01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SubagentActivity } from "../lib/subagentActivity";
import { MarkdownText } from "./MarkdownText";

function argument(entry: ToolEntry, key: string): string | undefined {
  if (!entry.arguments || typeof entry.arguments !== "object" || Array.isArray(entry.arguments)) return undefined;
  const value = (entry.arguments as Record<string, JsonValue>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function subagentResponse(entry: ToolEntry): string {
  return entry.output
    .filter((block): block is Extract<(typeof entry.output)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

function agentName(entry: ToolEntry): string {
  const name = argument(entry, "agent") ?? "Subagent";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function taskSummary(task: string): string {
  return task
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]\s)\s*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function statusLabel(status: ToolStatus): string {
  if (status === "completed") return "Completed";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function statusIcon(entry: ToolEntry) {
  if (entry.status === "queued" || entry.status === "running") return Loading03Icon;
  if (entry.status === "completed") return Tick02Icon;
  if (entry.status === "cancelled") return Cancel01Icon;
  return AlertCircleIcon;
}

function durationMilliseconds(entry: ToolEntry, now: number): number | undefined {
  const started = Date.parse(entry.startedAt ?? entry.createdAt);
  const active = entry.status === "queued" || entry.status === "running";
  if (!active && !entry.endedAt) return undefined;
  const ended = entry.endedAt ? Date.parse(entry.endedAt) : now;
  const duration = ended - started;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function formatSubagentDuration(entry: ToolEntry, now: number): string | undefined {
  const milliseconds = durationMilliseconds(entry, now);
  if (milliseconds === undefined) return undefined;
  if (milliseconds < 1_000) return "<1s";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

function AgentStatusIcon({ entry }: { entry: ToolEntry }) {
  return (
    <span className={`subagent-activity-icon subagent-activity-icon--${entry.status}`}>
      <HugeiconsIcon
        icon={statusIcon(entry)}
        strokeWidth={2}
        className={entry.status === "queued" || entry.status === "running" ? "subagent-activity-icon-spin" : undefined}
        aria-hidden="true"
      />
    </span>
  );
}

function AgentList({ activity, now, restoreFocusId, restoreScrollTop, scrollAreaRef, onSelect, onClose }: {
  activity: SubagentActivity;
  now: number;
  restoreFocusId?: string;
  restoreScrollTop: number;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useLayoutEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (viewport) viewport.scrollTop = restoreScrollTop;
    if (!restoreFocusId) return;
    const rows = Array.from(scrollAreaRef.current?.querySelectorAll<HTMLButtonElement>("[data-subagent-id]") ?? []);
    const row = rows.find((candidate) => candidate.dataset.subagentId === restoreFocusId) ?? rows[0];
    row?.focus();
  }, [restoreFocusId, restoreScrollTop, scrollAreaRef]);

  return (
    <>
      <header className="subagent-popover-header">
        <div>
          <PopoverTitle className="subagent-popover-title">Subagents</PopoverTitle>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close subagent activity">
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <ScrollArea ref={scrollAreaRef} className="subagent-popover-scroll subagent-popover-list-scroll">
        <div className="subagent-activity-list">
          {activity.items.map((entry) => {
            const task = argument(entry, "task");
            const duration = formatSubagentDuration(entry, now);
            return (
              <button key={entry.id} type="button" className="subagent-activity-row" data-subagent-id={entry.id} onClick={() => onSelect(entry.id)}>
                <AgentStatusIcon entry={entry} />
                <span className="subagent-activity-copy">
                  <span className="subagent-activity-name">
                    <strong>{agentName(entry)}</strong>
                  </span>
                  <span className="subagent-activity-task">{task ? taskSummary(task) : "No message available."}</span>
                </span>
                <span className="subagent-activity-duration">
                  {duration}
                  <span className="sr-only">, {statusLabel(entry.status)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}

function AgentDetail({ entry, now, copied, backButtonRef, onBack, onClose, onCopy }: {
  entry: ToolEntry;
  now: number;
  copied: boolean;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const task = argument(entry, "task");
  const response = subagentResponse(entry);
  const duration = formatSubagentDuration(entry, now);
  const waiting = entry.status === "queued" || entry.status === "running";

  return (
    <>
      <header className="subagent-popover-header subagent-detail-header">
        <Button ref={backButtonRef} type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div>
          <PopoverTitle className="subagent-popover-title">{agentName(entry)}</PopoverTitle>
          {duration && <span className="subagent-detail-duration">{duration}</span>}
          <span className="sr-only">{statusLabel(entry.status)}</span>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close subagent activity">
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <ScrollArea className="subagent-popover-scroll subagent-detail-scroll">
        <div className="subagent-detail-body">
          <section className="subagent-detail-section">
            <h3>Original message</h3>
            {task
              ? <MarkdownText className="subagent-detail-markdown markdown-body">{task}</MarkdownText>
              : <p className="subagent-detail-placeholder">No message available.</p>}
          </section>
          <section className="subagent-detail-section">
            <header>
              <h3>Response</h3>
              {response && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="subagent-copy-button"
                  onClick={onCopy}
                  aria-label={copied ? "Subagent response copied" : "Copy subagent response"}
                  title={copied ? "Copied" : "Copy response"}
                >
                  <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                </Button>
              )}
            </header>
            {response
              ? <MarkdownText className="subagent-detail-markdown markdown-body">{response}</MarkdownText>
              : <p className="subagent-detail-placeholder">{waiting ? "Waiting for response…" : "No response returned."}</p>}
          </section>
        </div>
      </ScrollArea>
    </>
  );
}

export function SubagentActivityPopover({ activity }: { activity: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const listScrollAreaRef = useRef<HTMLDivElement | null>(null);
  const listScrollTop = useRef(0);
  const returnFocusId = useRef<string | undefined>(undefined);
  const selected = useMemo(
    () => activity.items.find((entry) => entry.id === selectedId),
    [activity.items, selectedId],
  );
  const now = useActivityClock(open && activity.active > 0);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(undefined);
  }, [selected, selectedId]);

  useLayoutEffect(() => {
    if (selectedId) detailBackRef.current?.focus();
  }, [selectedId]);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSelectedId(undefined);
      setCopied(false);
      returnFocusId.current = undefined;
      listScrollTop.current = 0;
    }
  };

  const copyResponse = async () => {
    if (!selected) return;
    const response = subagentResponse(selected);
    if (!response) return;
    try {
      await navigator.clipboard.writeText(response);
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const label = activity.items.length
    ? `Open subagent activity: ${activity.active} active, ${activity.finished} finished`
    : "No subagents used in this thread";

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="composer-status-subagents"
          aria-label={label}
          title={label}
          disabled={!activity.items.length}
        >
          {activity.active > 0 && (
            <>
              <span className="composer-status-metric" title="Active subagents">
                <HugeiconsIcon
                  icon={Loading03Icon}
                  strokeWidth={2}
                  className="composer-status-icon composer-status-icon--active composer-status-icon--spinning"
                  aria-hidden="true"
                />
                {activity.active}<span className="sr-only"> active</span>
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="composer-status-metric" title="Finished subagents">
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="composer-status-icon composer-status-icon--finished" aria-hidden="true" />
            {activity.finished}<span className="sr-only"> finished</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="subagent-popover" aria-label="Subagent activity">
        {selected
          ? (
              <AgentDetail
                entry={selected}
                now={now}
                copied={copied}
                backButtonRef={detailBackRef}
                onBack={() => { setSelectedId(undefined); setCopied(false); }}
                onClose={() => changeOpen(false)}
                onCopy={() => { void copyResponse(); }}
              />
            )
          : (
              <AgentList
                activity={activity}
                now={now}
                restoreFocusId={returnFocusId.current}
                restoreScrollTop={listScrollTop.current}
                scrollAreaRef={listScrollAreaRef}
                onSelect={(id) => {
                  const viewport = listScrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
                  listScrollTop.current = viewport?.scrollTop ?? 0;
                  returnFocusId.current = id;
                  setSelectedId(id);
                }}
                onClose={() => changeOpen(false)}
              />
            )}
      </PopoverContent>
    </Popover>
  );
}
