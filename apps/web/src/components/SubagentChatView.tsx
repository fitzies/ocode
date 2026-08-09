import type { SessionSummary, TimelineEntry, ToolEntry } from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { canCancelSubagentStatus, isActiveSubagentStatus, type SubagentActivityItem } from "../lib/subagentActivity";
import { formatSubagentDuration, subagentRoleLabel, subagentStatusLabel } from "../lib/subagentPresentation";
import { MarkdownText } from "./MarkdownText";

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

function ToolStatusIcon({ entry }: { entry: ToolEntry }) {
  const icon = entry.status === "running" || entry.status === "queued"
    ? Loading03Icon
    : entry.status === "completed"
      ? Tick02Icon
      : AlertCircleIcon;
  return <HugeiconsIcon icon={icon} strokeWidth={2} className={entry.status === "running" ? "subagent-activity-icon-spin" : undefined} />;
}

function CompactTranscript({ entries, task }: { entries: TimelineEntry[]; task: string }) {
  const firstTaskId = entries.find((entry) => entry.kind === "message" && entry.role === "user")?.id;
  const visible = entries.filter((entry) => {
    if (entry.id === firstTaskId) return false;
    if (entry.kind === "message") return Boolean(textContent(entry));
    return entry.kind === "tool" || entry.kind === "event" || entry.kind === "interaction";
  });

  return (
    <div className="subagent-chat-stream">
      <section className="subagent-chat-task">
        <span>Task</span>
        <p>{task}</p>
      </section>
      {visible.map((entry) => {
        if (entry.kind === "message") {
          const text = textContent(entry);
          return (
            <article className={`subagent-chat-message subagent-chat-message--${entry.role}`} key={entry.id}>
              <strong>{entry.role === "assistant" ? "Agent" : entry.role}</strong>
              <MarkdownText className={`subagent-chat-markdown markdown-body${entry.error ? " subagent-detail-error" : ""}`}>{text}</MarkdownText>
            </article>
          );
        }
        if (entry.kind === "tool") {
          const output = toolOutput(entry);
          return (
            <Collapsible key={entry.id} className="subagent-chat-tool">
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" className="subagent-chat-tool-trigger h-auto">
                  <ToolStatusIcon entry={entry} />
                  <span>{entry.label ?? entry.summary ?? entry.name}</span>
                  <small>{entry.status}</small>
                </Button>
              </CollapsibleTrigger>
              {output && <CollapsibleContent><MarkdownText className="subagent-chat-tool-output markdown-body">{output}</MarkdownText></CollapsibleContent>}
            </Collapsible>
          );
        }
        if (entry.kind === "event") {
          return <div className={`subagent-chat-event subagent-chat-event--${entry.tone}`} key={entry.id}>{entry.title}{entry.message ? ` · ${entry.message}` : ""}</div>;
        }
        if (entry.kind === "interaction") {
          return <div className="subagent-chat-event" key={entry.id}>{entry.title}{entry.summary ? ` · ${entry.summary}` : ""}</div>;
        }
        return null;
      })}
    </div>
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

  return (
    <div className="subagent-chat-view">
      <header className="subagent-chat-header">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to Agents">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div className="subagent-chat-heading">
          <strong>{subagentRoleLabel(item.role)}</strong>
          <span className={`subagent-chat-status subagent-chat-status--${item.status}`}>{subagentStatusLabel(item.status)}</span>
        </div>
        <span className="subagent-chat-duration">{duration ?? "—"}</span>
      </header>

      <ScrollArea className="subagent-chat-scroll">
        {loading && !session ? (
          <Empty className="h-full min-h-48 rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" /></EmptyMedia>
              <EmptyTitle>Loading agent chat</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : loadError ? (
          <Empty className="h-full min-h-48 rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HugeiconsIcon icon={AlertCircleIcon} /></EmptyMedia>
              <EmptyTitle>Could not load agent chat</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : entries.length ? (
          <CompactTranscript entries={entries} task={item.task} />
        ) : (
          <Empty className="h-full min-h-48 rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HugeiconsIcon icon={active ? Loading03Icon : Tick02Icon} className={active ? "subagent-activity-icon-spin" : undefined} /></EmptyMedia>
              <EmptyTitle>{active ? "Waiting for agent activity" : "No transcript retained"}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>

      {(canCancelSubagentStatus(item.status) || actionError) && (
        <footer className="subagent-chat-footer">
          <span>Read-only while the agent works</span>
          {canCancelSubagentStatus(item.status) && (
            <Button type="button" variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" /> : <HugeiconsIcon icon={Cancel01Icon} />}
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          )}
          {actionError && <p className="subagent-cancel-error" role="alert">{actionError}</p>}
        </footer>
      )}
    </div>
  );
}
