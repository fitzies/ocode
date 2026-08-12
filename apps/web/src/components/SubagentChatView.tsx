import type { SessionSummary, TimelineEntry, ToolEntry } from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  InformationCircleIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { canCancelSubagentStatus, isActiveSubagentStatus, type SubagentActivityItem } from "../lib/subagentActivity";
import {
  cleanSubagentResult,
  formatSubagentDuration,
  formatSubagentTimestamp,
  subagentNotificationCopy,
  subagentRoleLabel,
  subagentStatusLabel,
} from "../lib/subagentPresentation";
import { MarkdownText } from "./MarkdownText";
import { SubagentStatusBadge, SubagentStatusIcon } from "./SubagentStatusIcon";

function textContent(entry: Extract<TimelineEntry, { kind: "message" }>): string {
  return entry.content
    .filter((block): block is Extract<(typeof entry.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function toolOutput(entry: ToolEntry): string {
  return entry.output
    .filter((block): block is Extract<(typeof entry.output)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function finalAssistantResponse(entries: TimelineEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "message" || entry.role !== "assistant") continue;
    const text = textContent(entry);
    if (text) return text;
  }
  return undefined;
}

function ToolStatusIcon({ entry }: { entry: ToolEntry }) {
  const icon = entry.status === "running" || entry.status === "queued"
    ? Loading03Icon
    : entry.status === "completed"
      ? Tick02Icon
      : AlertCircleIcon;
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={2}
      className={entry.status === "running" ? "subagent-activity-icon-spin" : undefined}
    />
  );
}

function ToolRow({ entry }: { entry: ToolEntry }) {
  const output = toolOutput(entry);
  const label = entry.label ?? entry.summary ?? entry.name;
  const secondary = entry.summary && entry.summary !== label ? entry.summary : undefined;
  return (
    <Collapsible className={`subagent-chat-tool subagent-chat-tool--${entry.status}`}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="subagent-chat-tool-trigger h-auto" data-has-output={Boolean(output)}>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="subagent-chat-tool-chevron" />
          <ToolStatusIcon entry={entry} />
          <span className="subagent-chat-tool-name">{label}</span>
          {secondary && <span className="subagent-chat-tool-summary">{secondary}</span>}
          <small>{entry.status}</small>
        </Button>
      </CollapsibleTrigger>
      {output && (
        <CollapsibleContent>
          <MarkdownText className="subagent-chat-tool-output markdown-body">{output}</MarkdownText>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function visibleTranscriptEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const firstTaskId = entries.find((entry) => entry.kind === "message" && entry.role === "user")?.id;
  return entries.filter((entry) => {
    if (entry.id === firstTaskId) return false;
    if (entry.kind === "message") return Boolean(textContent(entry));
    return entry.kind === "tool" || entry.kind === "event" || entry.kind === "interaction";
  });
}

function ActiveTranscript({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="subagent-chat-stream">
      {visibleTranscriptEntries(entries).map((entry) => {
        if (entry.kind === "message") {
          const text = textContent(entry);
          return (
            <article className={`subagent-chat-message subagent-chat-message--${entry.role}`} key={entry.id}>
              {entry.role !== "assistant" && <strong>{entry.role}</strong>}
              <MarkdownText className={`subagent-chat-markdown markdown-body${entry.error ? " subagent-detail-error" : ""}`}>{text}</MarkdownText>
            </article>
          );
        }
        if (entry.kind === "tool") return <ToolRow entry={entry} key={entry.id} />;
        if (entry.kind === "event") {
          return (
            <Alert className={`subagent-chat-event subagent-chat-event--${entry.tone}`} key={entry.id}>
              <HugeiconsIcon icon={entry.tone === "error" || entry.tone === "warning" ? AlertCircleIcon : InformationCircleIcon} strokeWidth={2} />
              <AlertDescription>{entry.title}{entry.message ? ` · ${entry.message}` : ""}</AlertDescription>
            </Alert>
          );
        }
        if (entry.kind === "interaction") {
          return (
            <div className="subagent-chat-event subagent-chat-event--interaction" key={entry.id}>
              <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" />
              <span><small>Waiting</small>{entry.title}{entry.summary ? ` · ${entry.summary}` : ""}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function RunDetails({ item }: { item: SubagentActivityItem }) {
  return (
    <details className="subagent-run-details">
      <summary>Run details</summary>
      <dl>
        <div><dt>Child session</dt><dd><code>{item.childSessionId}</code></dd></div>
        <div><dt>Role</dt><dd>{subagentRoleLabel(item.role)}</dd></div>
        <div><dt>Status</dt><dd>{subagentStatusLabel(item.status)}</dd></div>
        <div><dt>Created</dt><dd>{formatSubagentTimestamp(item.createdAt)}</dd></div>
        <div><dt>Started</dt><dd>{formatSubagentTimestamp(item.startedAt)}</dd></div>
        <div><dt>Ended</dt><dd>{formatSubagentTimestamp(item.endedAt)}</dd></div>
        <div><dt>Notification</dt><dd className={item.notification?.status === "uncertain" ? "subagent-notification--uncertain" : undefined}>{subagentNotificationCopy(item)}</dd></div>
      </dl>
      {item.notification?.error && <p className="subagent-notification-error">{item.notification.error}</p>}
    </details>
  );
}

function CompletedOutcome({ item, entries, response, copied, onCopy }: {
  item: SubagentActivityItem;
  entries: TimelineEntry[];
  response?: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const tools = entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
  const failed = item.status === "failed" || item.status === "interrupted";
  return (
    <div className="subagent-outcome">
      {item.notification?.status === "uncertain" && (
        <Alert className="subagent-inline-alert subagent-inline-alert--warning">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <AlertDescription>
            Delivery to the parent thread is uncertain. Check the parent conversation before retrying this task.
          </AlertDescription>
        </Alert>
      )}
      <section className="subagent-outcome-result">
        <div className="subagent-detail-section-heading">
          <h3 className="subagent-result-label">{failed ? "Outcome" : "Result"}</h3>
          {response && (
            <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
              <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} />
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
        <div className={`subagent-result-card${failed ? " subagent-result-card--error" : ""}`}>
          {response
            ? <MarkdownText className={`subagent-outcome-markdown markdown-body${item.error ? " subagent-detail-error" : ""}`}>{cleanSubagentResult(response)}</MarkdownText>
            : <p className="subagent-detail-placeholder">No result preview was retained.</p>}
        </div>
      </section>
      {tools.length > 0 && (
        <section className="subagent-outcome-section">
          <div className="subagent-outcome-section-heading"><h3>Activity</h3><span>{tools.length}</span></div>
          <div className="subagent-outcome-tools">{tools.map((entry) => <ToolRow entry={entry} key={entry.id} />)}</div>
        </section>
      )}
      <RunDetails item={item} />
    </div>
  );
}

function DetailHeader({ item, duration, onBack }: { item: SubagentActivityItem; duration?: string; onBack: () => void }) {
  return (
    <header className="subagent-chat-header">
      <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to Agents">
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
      </Button>
      <SubagentStatusIcon item={item} />
      <strong className="subagent-detail-role">{subagentRoleLabel(item.role)}</strong>
      <SubagentStatusBadge item={item} />
      <span className="subagent-detail-timer">
        <HugeiconsIcon icon={Clock01Icon} strokeWidth={2} />
        {duration ?? "—"}
      </span>
    </header>
  );
}

export function SubagentChatView({
  item,
  session,
  entries,
  now,
  loading,
  loadError,
  cancelling,
  actionError,
  onBack,
  onCancel,
}: {
  item: SubagentActivityItem;
  session?: SessionSummary;
  entries: TimelineEntry[];
  now: number;
  loading: boolean;
  loadError?: string;
  cancelling: boolean;
  actionError?: string;
  onBack: () => void;
  onCancel: () => void;
}) {
  const duration = formatSubagentDuration(item, now);
  const active = isActiveSubagentStatus(item.status) || item.status === "needs_attention";
  const response = item.error ?? item.result ?? finalAssistantResponse(entries);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

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

  return (
    <div className="subagent-chat-view">
      <DetailHeader item={item} duration={duration} onBack={onBack} />

      <ScrollArea className="subagent-chat-scroll">
        {loading && !session ? (
          <Empty className="h-full min-h-48 rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Spinner /></EmptyMedia>
              <EmptyTitle>Loading agent activity</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : loadError ? (
          <Empty className="h-full min-h-48 rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HugeiconsIcon icon={AlertCircleIcon} /></EmptyMedia>
              <EmptyTitle>Could not load agent activity</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : active ? (
          <div className="subagent-running-content">
            <section className="subagent-chat-task"><strong>Task</strong><p>{item.task}</p></section>
            {item.status === "needs_attention" && item.result && (
              <Alert className="subagent-inline-alert subagent-inline-alert--warning">
                <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
                <AlertDescription>{item.result}</AlertDescription>
              </Alert>
            )}
            <div className="subagent-activity-heading">
              <h3>Activity</h3>
              {item.status === "running" && <span><i aria-hidden="true" />Live</span>}
            </div>
            {visibleTranscriptEntries(entries).length > 0 ? (
              <ActiveTranscript entries={entries} />
            ) : (
              <div className="subagent-waiting-state" role="status">
                <Spinner aria-hidden="true" />
                <span>{item.status === "starting" ? "Provisioning the child session…" : "Waiting for the agent's first activity…"}</span>
              </div>
            )}
          </div>
        ) : (
          <CompletedOutcome item={item} entries={entries} response={response} copied={copied} onCopy={() => { void copyResponse(); }} />
        )}
      </ScrollArea>

      {(active || actionError) && (
        <footer className="subagent-chat-footer">
          {actionError && (
            <Alert variant="destructive" className="subagent-action-error">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {active && <span className="subagent-read-only"><i aria-hidden="true" />Read-only</span>}
          {canCancelSubagentStatus(item.status) && (
            <Button type="button" variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" /> : <HugeiconsIcon icon={Cancel01Icon} />}
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}
