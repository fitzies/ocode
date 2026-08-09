import type { SubagentCommandReceipt, SubagentRun, SubagentRunStatus } from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  Copy01Icon,
  Loading03Icon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { MarkdownText } from "@/components/MarkdownText";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SubagentActivity } from "@/lib/subagentActivity";

export function subagentResponse(entry: SubagentRun): string {
  return entry.response ?? "";
}

function baseAgentName(entry: SubagentRun): string {
  const name = entry.role || entry.agent || entry.key || "agent";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function subagentDisplayNames(entries: readonly SubagentRun[]): Map<string, string> {
  const chronological = [...entries].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const totals = new Map<string, number>();
  for (const entry of chronological) {
    const base = baseAgentName(entry);
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return new Map(chronological.map((entry) => {
    const base = baseAgentName(entry);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return [entry.id, (totals.get(base) ?? 0) > 1 ? `${base} ${occurrence}` : base];
  }));
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

function statusLabel(status: SubagentRunStatus): string {
  if (status === "completed") return "Done";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function statusIcon(status: SubagentRunStatus) {
  if (status === "queued" || status === "running") return Loading03Icon;
  if (status === "completed") return Tick02Icon;
  if (status === "paused") return PauseIcon;
  return status === "cancelled" ? Cancel01Icon : AlertCircleIcon;
}

function isActive(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

function durationMilliseconds(entry: SubagentRun, now: number): number | undefined {
  const started = Date.parse(entry.startedAt);
  const ended = entry.endedAt ? Date.parse(entry.endedAt) : isActive(entry.status) ? now : Number.NaN;
  const duration = ended - started;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function formatSubagentDuration(entry: SubagentRun, now: number): string | undefined {
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

function AgentRow({ entry, name, now, onSelect }: {
  entry: SubagentRun;
  name: string;
  now: number;
  onSelect(): void;
}) {
  const duration = formatSubagentDuration(entry, now);
  return (
    <button type="button" className="subagent-panel-row" onClick={onSelect}>
      <span className={`subagent-panel-state subagent-panel-state--${entry.status}`} aria-hidden="true" />
      <span className="subagent-panel-row-copy">
        <span className="subagent-panel-row-name"><strong>{name}</strong><small>{statusLabel(entry.status)}</small></span>
        <span className="subagent-panel-row-task">{entry.task ? taskSummary(entry.task) : entry.role ?? entry.key}</span>
        {isActive(entry.status) && <span className="subagent-panel-row-activity">{entry.currentActivity ?? (entry.status === "queued" ? "Waiting to start" : "Working")}</span>}
      </span>
      <time className="subagent-panel-row-duration">{duration}</time>
    </button>
  );
}

function AgentSection({ title, entries, names, now, onSelect }: {
  title: string;
  entries: SubagentRun[];
  names: Map<string, string>;
  now: number;
  onSelect(entry: SubagentRun): void;
}) {
  if (!entries.length) return null;
  return (
    <section className="subagent-panel-section">
      <h3>{title}<span>{entries.length}</span></h3>
      {entries.map((entry) => (
        <AgentRow key={entry.id} entry={entry} name={names.get(entry.id) ?? baseAgentName(entry)} now={now} onSelect={() => onSelect(entry)} />
      ))}
    </section>
  );
}

function AgentList({ activity, names, now, onSelect }: {
  activity: SubagentActivity;
  names: Map<string, string>;
  now: number;
  onSelect(entry: SubagentRun): void;
}) {
  const active = activity.items.filter((entry) => isActive(entry.status));
  const attention = activity.items.filter((entry) => entry.status === "failed" || entry.status === "cancelled" || entry.status === "rejected");
  const completed = activity.items.filter((entry) => entry.status === "completed");
  return (
    <div className="subagent-panel-list-view">
      <header className="subagent-panel-titlebar"><h2>Agents</h2><span>{activity.active} active</span></header>
      <ScrollArea className="subagent-panel-scroll">
        <div className="subagent-panel-list">
          <AgentSection title="Active" entries={active} names={names} now={now} onSelect={onSelect} />
          <AgentSection title="Needs attention" entries={attention} names={names} now={now} onSelect={onSelect} />
          <AgentSection title="Completed" entries={completed} names={names} now={now} onSelect={onSelect} />
          {!activity.items.length && <div className="subagent-panel-empty">No agents have been dispatched in this thread.</div>}
        </div>
      </ScrollArea>
      <footer className="subagent-panel-summary"><span>{activity.items.length} this thread</span><span>{activity.finished} finished</span></footer>
    </div>
  );
}

export function receiptLabel(receipt: SubagentCommandReceipt): string {
  if (receipt.state === "failed") return receipt.error ?? `${receipt.kind} failed`;
  if (receipt.kind === "stop") {
    if (receipt.state === "delivered") return "Workflow stopped";
    return "Stop requested";
  }
  if (receipt.kind === "interrupt") {
    if (receipt.state === "delivered") return "Agent paused";
    return "Pause requested";
  }
  if (receipt.kind === "resume") {
    if (receipt.state === "delivered" || receipt.state === "recovered") return "Follow-up launched";
    return "Launching follow-up";
  }
  if (receipt.state === "scheduled") return "Queued for the next turn";
  if (receipt.state === "pending") return "Waiting for acknowledgement";
  if (receipt.state === "delivered") return "Delivered";
  if (receipt.state === "recovered") return "Delivered after recovery";
  if (receipt.state === "partial") return "Partially delivered";
  return "Sending";
}

export interface SubagentPanelControls {
  onSteer(runId: string, message: string): Promise<SubagentCommandReceipt | undefined>;
  onInterrupt(runId: string): Promise<SubagentCommandReceipt | undefined>;
  onStop(runId: string): Promise<SubagentCommandReceipt | undefined>;
  onResume(runId: string, message: string): Promise<SubagentCommandReceipt | undefined>;
}

function AgentDetail({ entry, name, now, controls, onBack }: {
  entry: SubagentRun;
  name: string;
  now: number;
  controls: SubagentPanelControls;
  onBack(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [controlError, setControlError] = useState<string>();
  const copiedTimer = useRef<number | undefined>(undefined);
  const response = subagentResponse(entry);
  const waiting = entry.status === "queued" || entry.status === "running";
  const duration = formatSubagentDuration(entry, now);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
  }, []);

  const copyResponse = async () => {
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

  const runControl = async (action: () => Promise<SubagentCommandReceipt | undefined>): Promise<boolean> => {
    setSending(true);
    setControlError(undefined);
    try {
      const receipt = await action();
      if (receipt?.state === "failed") {
        setControlError(receipt.error ?? "Command failed");
        return false;
      }
      return true;
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || sending) return;
    void runControl(() => entry.capabilities.resume ? controls.onResume(entry.id, clean) : controls.onSteer(entry.id, clean))
      .then((delivered) => { if (delivered) setMessage(""); });
  };

  const finalTranscriptText = [...entry.transcript].reverse().find((item) => item.type === "message" && item.role === "assistant")?.text;

  return (
    <div className="subagent-panel-detail-view">
      <header className="subagent-panel-detail-header">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to all agents">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <span className="subagent-panel-detail-title"><strong>{name}</strong><small>{duration ?? statusLabel(entry.status)}{entry.model ? ` · ${entry.model}` : ""}</small></span>
        <span className={`subagent-panel-detail-status subagent-panel-detail-status--${entry.status}`}>
          <HugeiconsIcon icon={statusIcon(entry.status)} strokeWidth={2} className={waiting ? "subagent-panel-spin" : undefined} aria-hidden="true" />
          {statusLabel(entry.status)}
        </span>
      </header>
      {entry.task && <div className="subagent-panel-task"><strong>Task</strong><span>{taskSummary(entry.task)}</span></div>}
      <ScrollArea className="subagent-panel-scroll">
        <div className="subagent-panel-conversation">
          {entry.transcript.map((item) => item.type === "message" ? (
            <section className="subagent-panel-chat-message" key={item.id}>
              <header>Agent</header>
              <MarkdownText className="subagent-panel-markdown markdown-body">{item.text ?? ""}</MarkdownText>
            </section>
          ) : (
            <div className={`subagent-panel-transcript-event subagent-panel-transcript-event--${item.status ?? "status"}`} key={item.id}>
              {item.type === "tool" && <HugeiconsIcon icon={item.status === "running" ? Loading03Icon : item.status === "failed" ? AlertCircleIcon : Tick02Icon} strokeWidth={2} className={item.status === "running" ? "subagent-panel-spin" : undefined} aria-hidden="true" />}
              <span>
                <strong>{item.toolName ?? "Activity"}</strong>
                {item.type === "tool" && <span className="sr-only"> {item.status ?? "completed"}</span>}
                {item.text && <small>{item.text}</small>}
              </span>
            </div>
          ))}
          {response && response !== finalTranscriptText && (
            <section className="subagent-panel-response">
              <header>
                <span>Response</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void copyResponse()} aria-label="Copy subagent response">
                  <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                </Button>
              </header>
              <MarkdownText className="subagent-panel-markdown markdown-body">{response}</MarkdownText>
            </section>
          )}
          {entry.error && !response && (
            <div className="subagent-panel-control-error" role="alert">{entry.error}</div>
          )}
          {!entry.transcript.length && !response && !entry.error && (
            <div className="subagent-panel-waiting" role="status">
              {waiting && <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="subagent-panel-spin" aria-hidden="true" />}
              <span>{waiting
                ? entry.status === "queued" ? "Waiting to start…" : "Working…"
                : entry.status === "paused" ? "Paused. Resume with a follow-up when ready."
                : entry.status === "cancelled" ? "Workflow stopped before a response was returned."
                : entry.status === "rejected" ? "The run was rejected."
                : "No response returned."}</span>
              {entry.currentActivity && <small>{entry.currentActivity}</small>}
            </div>
          )}
          {entry.receipts.map((receipt) => (
            <div className={`subagent-panel-receipt subagent-panel-receipt--${receipt.state}`} key={receipt.id}>
              {receipt.message && <span>{receipt.message}</span>}
              <small>{receiptLabel(receipt)}</small>
            </div>
          ))}
          {controlError && <div className="subagent-panel-control-error" role="alert">{controlError}</div>}
        </div>
      </ScrollArea>
      <footer className="subagent-panel-controls">
        {entry.capabilities.interrupt && (
          <Button type="button" variant="ghost" size="icon-sm" disabled={sending} onClick={() => void runControl(() => controls.onInterrupt(entry.id))} aria-label="Pause agent" title="Pause agent">
            <HugeiconsIcon icon={PauseIcon} strokeWidth={2} />
          </Button>
        )}
        {entry.capabilities.stop && (
          <Button type="button" variant="ghost" size="icon-sm" disabled={sending} onClick={() => void runControl(() => controls.onStop(entry.id))} aria-label="Stop workflow" title="Stop workflow">
            <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
          </Button>
        )}
        <form onSubmit={submit}>
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={sending || (!entry.capabilities.steer && !entry.capabilities.resume)}
            placeholder={entry.capabilities.resume ? "Resume with a follow-up…" : entry.capabilities.steer ? "Message agent…" : "Agent cannot receive messages"}
            aria-label="Message agent"
          />
          <Button type="submit" variant="secondary" size="icon-sm" disabled={sending || !message.trim() || (!entry.capabilities.steer && !entry.capabilities.resume)} aria-label={entry.capabilities.resume ? "Resume agent" : "Send to agent"}>
            <HugeiconsIcon icon={entry.capabilities.resume ? PlayIcon : ArrowUp02Icon} strokeWidth={2} />
          </Button>
        </form>
      </footer>
    </div>
  );
}

export function SubagentActivityPanel({ activity, controls }: { activity: SubagentActivity; controls: SubagentPanelControls }) {
  const [selectedId, setSelectedId] = useState<string>();
  const names = useMemo(() => subagentDisplayNames(activity.items), [activity.items]);
  const selected = activity.items.find((entry) => entry.id === selectedId);
  const now = useActivityClock(activity.active > 0);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(undefined);
  }, [selected, selectedId]);

  return selected ? (
    <AgentDetail entry={selected} name={names.get(selected.id) ?? baseAgentName(selected)} now={now} controls={controls} onBack={() => setSelectedId(undefined)} />
  ) : (
    <AgentList activity={activity} names={names} now={now} onSelect={(entry) => setSelectedId(entry.id)} />
  );
}
