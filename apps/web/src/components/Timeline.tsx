import { normalizeProjectResourcePath } from "@anvil/protocol";
import type {
  ArtifactReference,
  ContentBlock,
  JsonValue,
  MessageEntry,
  ProjectResourceContentBlock,
  SessionSummary,
  SystemEventEntry,
  TimelineEntry,
  ToolEntry,
} from "@anvil/protocol";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArtificialIntelligence02Icon,
  BrowserIcon,
  CheckmarkCircle02Icon,
  CloudUploadIcon,
  CommandIcon,
  File01Icon,
  FileEditIcon,
  GitBranchIcon,
  Globe02Icon,
  HelpCircleIcon,
  Image02Icon,
  InformationCircleIcon,
  Loading03Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InlineHtmlArtifact, InlineHtmlArtifactPending } from "./InlineHtmlArtifact";
import { MarkdownText } from "./MarkdownText";
import { Button } from "./ui/button";
import { displayToolName, presentTool, type ToolCategory } from "./toolPresentation";

interface TimelineProps {
  session: SessionSummary;
  entries: TimelineEntry[];
  loading?: boolean;
  onSuggestion: (prompt: string) => void;
  onOpenProjectResource?: (block: ProjectResourceContentBlock) => void;
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

const EMPTY_FILE_ATTACHMENT_MARKER = /^<file name="[^"\r\n]*"><\/file>\r?$/gm;

function userVisibleContent(blocks: ContentBlock[]): ContentBlock[] {
  const hasImage = blocks.some((block) => block.type === "image");
  if (!hasImage) return blocks.filter((block) => block.type !== "toolCall");
  return blocks.flatMap<ContentBlock>((block) => {
    if (block.type === "toolCall") return [];
    if (block.type !== "text") return [block];
    const text = block.text.replace(EMPTY_FILE_ATTACHMENT_MARKER, "");
    if (text === block.text) return [block];
    return text.trim() ? [{ ...block, text }] : [];
  });
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

function ContentBlocks({ blocks, compact = false, onOpenProjectResource }: {
  blocks: ContentBlock[];
  compact?: boolean;
  onOpenProjectResource?: (block: ProjectResourceContentBlock) => void;
}) {
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
        if (block.type === "inlineHtml") {
          return <InlineHtmlArtifact key={block.id} block={block} />;
        }
        if (block.type === "projectResource") {
          return (
            <div className="project-resource-block" key={block.id}>
              <span><strong>{block.path.split("/").at(-1)}</strong><small>{block.path}{block.line ? `:${block.line}${block.column ? `:${block.column}` : ""}` : ""}</small></span>
              <Button type="button" size="sm" variant="outline" onClick={() => onOpenProjectResource?.(block)}>Open file</Button>
            </div>
          );
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
    return <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="spin size-3.5" aria-label={entry.status === "queued" ? "Queued" : "Running"} />;
  }
  if (entry.status === "failed") return <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-3.5" aria-label="Failed" />;
  if (entry.status === "cancelled") return <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="size-3.5" aria-label="Cancelled" />;
  return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-3.5" aria-label="Completed" />;
}

function ToolGlyph({ category }: { category: ToolCategory }) {
  const icon = category === "file" ? File01Icon
    : category === "edit" ? FileEditIcon
      : category === "search" ? Search01Icon
        : category === "browser" ? BrowserIcon
          : category === "agent" ? ArtificialIntelligence02Icon
            : category === "image" ? Image02Icon
              : category === "git" ? GitBranchIcon
                : category === "parallel" ? Globe02Icon
                  : CommandIcon;
  return <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />;
}

function firstTextOutput(entry: ToolEntry): string | undefined {
  const block = entry.output.find((candidate) => candidate.type === "text" && candidate.text.trim());
  if (block?.type !== "text") return undefined;
  const text = block.text.replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function trustedFileToolResource(entry: ToolEntry): ProjectResourceContentBlock | undefined {
  if (entry.status !== "completed" || !["write", "edit"].includes(entry.name)) return undefined;
  if (!entry.arguments || typeof entry.arguments !== "object" || Array.isArray(entry.arguments)) return undefined;
  const path = (entry.arguments as Record<string, JsonValue>).path;
  if (typeof path !== "string" || normalizeProjectResourcePath(path) !== path) return undefined;
  return { id: `${entry.id}-project-resource`, type: "projectResource", path, view: "auto" };
}

function isInlineHtmlTool(name: string): boolean {
  return name === "ocode_render_html_file" || name === "anvil_render_html_file";
}

interface RetryCycle {
  starts: SystemEventEntry[];
  end?: SystemEventEntry;
  errors: MessageEntry[];
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function retryEventType(entry: TimelineEntry): "auto_retry_start" | "auto_retry_end" | undefined {
  if (entry.kind !== "event") return undefined;
  const type = jsonRecord(entry.raw)?.type;
  return type === "auto_retry_start" || type === "auto_retry_end" ? type : undefined;
}

function retryString(entry: SystemEventEntry, field: string): string | undefined {
  const value = jsonRecord(entry.raw)?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function retryNumber(entry: SystemEventEntry, field: string): number | undefined {
  const value = jsonRecord(entry.raw)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retryOriginalError(retry: RetryCycle): string {
  return retryString(retry.starts[0]!, "errorMessage") ?? retry.starts[0]?.message ?? "Connection error";
}

function retryAttemptCount(retry: RetryCycle): number {
  return retry.end
    ? retryNumber(retry.end, "attempt") ?? retry.starts.length
    : retryNumber(retry.starts.at(-1)!, "attempt") ?? retry.starts.length;
}

function RetryTimelineItem({ retry, entering }: { retry: RetryCycle; entering: boolean }) {
  const active = !retry.end;
  const succeeded = retry.end ? jsonRecord(retry.end.raw)?.success === true : false;
  const state = active ? "active" : succeeded ? "success" : "failed";
  const title = active ? "Reconnecting…" : succeeded ? "Connection recovered" : "Connection failed";
  const attempts = retryAttemptCount(retry);
  const detail = active
    ? `${retryOriginalError(retry)} · attempt ${attempts}`
    : `${retryOriginalError(retry)} · ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
  const rawDetails: JsonValue = {
    retryEvents: [...retry.starts, ...(retry.end ? [retry.end] : [])].map((entry) => entry.raw ?? entry.details ?? null),
    assistantErrors: retry.errors.map((entry) => ({
      messageId: entry.id,
      error: entry.error ?? null,
      content: entry.content.map((block) => JSON.parse(JSON.stringify(block)) as JsonValue),
      raw: entry.raw ?? null,
    })),
  };

  return (
    <details className={`tool-event retry-event retry-event--${state} tool-event--${active ? "running" : succeeded ? "completed" : "failed"}${entering ? " timeline-entry--entering" : ""}`}>
      <summary>
        <span className="tool-icon">
          <HugeiconsIcon icon={active ? Loading03Icon : CloudUploadIcon} strokeWidth={2} className={`${active ? "spin " : ""}size-3.5`} />
        </span>
        <span className="tool-main">
          <strong>{title}</strong>
          <span title={detail}>{detail}</span>
        </span>
        <span className="tool-status-copy" aria-hidden="true">{active ? "Retrying" : succeeded ? "Resolved" : "Failed"}</span>
        {!active && (
          <span className="tool-status">
            <HugeiconsIcon
              icon={succeeded ? CheckmarkCircle02Icon : AlertCircleIcon}
              strokeWidth={2}
              className="size-3.5"
              aria-label={succeeded ? "Resolved" : "Failed"}
            />
          </span>
        )}
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="disclosure-icon size-3.5" />
      </summary>
      <div className="tool-detail retry-detail">
        <section>
          <span className="detail-label">Original error</span>
          <p>{retryOriginalError(retry)}</p>
        </section>
        <section>
          <span className="detail-label">Attempts</span>
          <ol>
            {retry.starts.map((entry, index) => {
              const attempt = retryNumber(entry, "attempt") ?? index + 1;
              const delayMs = retryNumber(entry, "delayMs");
              return (
                <li key={entry.id}>
                  <strong>Attempt {attempt}</strong>
                  <span>{delayMs === undefined ? "Automatic retry" : `Retrying after ${delayMs.toLocaleString()} ms`}</span>
                </li>
              );
            })}
          </ol>
          {!active && !succeeded && retry.end && <p className="retry-final-error">{retryString(retry.end, "finalError") ?? retry.end.message}</p>}
        </section>
        <JsonDetails label="Raw retry events and errors" value={rawDetails} />
      </div>
    </details>
  );
}

function TimelineItem({ entry, entering = false, onOpenProjectResource }: {
  entry: TimelineEntry;
  entering?: boolean;
  onOpenProjectResource: (block: ProjectResourceContentBlock) => void;
}) {
  const entranceClass = entering ? " timeline-entry--entering" : "";
  const reasoningStartedEmpty = useRef(entry.kind === "reasoning" && !entry.content).current;
  if (entry.kind === "message") {
    const visibleContent = entry.role === "user"
      ? userVisibleContent(entry.content)
      : entry.content.filter((block) => block.type !== "toolCall");
    if (!visibleContent.length && !entry.error && entry.status !== "streaming") return null;
    const messageClass = entry.role === "user" ? "user-message" : entry.role === "assistant" ? "assistant-message" : "system-message";
    return (
      <article className={`${messageClass} message-status--${entry.status}${entranceClass}`}>
        <ContentBlocks blocks={visibleContent} onOpenProjectResource={onOpenProjectResource} />
        {entry.status === "streaming" && entry.role === "user" && entry.id.startsWith("optimistic-")
          ? <span className="message-pending" role="status">
              {entry.raw && typeof entry.raw === "object" && !Array.isArray(entry.raw) && entry.raw.delivery === "steer" ? "Queueing…" : "Sending…"}
            </span>
          : entry.status === "streaming" && hasVisibleContent(visibleContent) && <span className="stream-caret" aria-label="Streaming" />}
        {entry.error && <div className="message-error">{entry.error}</div>}
        {(entry.role === "extension" || entry.status === "failed") && <JsonDetails label="Raw message" value={entry.raw} />}
      </article>
    );
  }

  if (entry.kind === "reasoning") {
    const revealReasoning = reasoningStartedEmpty && Boolean(entry.content);
    return (
      <div className={`thinking-event thinking-event--${entry.status}${entranceClass}`}>
        <span className="thinking-label">Thinking:</span>
        <span className={`thinking-content${revealReasoning ? " thinking-content--revealing" : ""}`}>
          {(!entry.content || revealReasoning) && (
            <span className="thinking-placeholder" aria-hidden={revealReasoning || undefined}>Getting started…</span>
          )}
          {entry.content && (
            <MarkdownText className="thinking-markdown markdown-body">{entry.content}</MarkdownText>
          )}
        </span>
        {entry.status === "cancelled" && <span className="event-state-label">cancelled</span>}
      </div>
    );
  }

  if (entry.kind === "tool") {
    const presentation = presentTool(entry);
    const inlineHtml = entry.output.find((block) => block.type === "inlineHtml");
    if (presentation.category !== "agent" && inlineHtml?.type === "inlineHtml" && entry.status === "completed") {
      return (
        <div className={`inline-html-artifact-event${entranceClass}`}>
          <InlineHtmlArtifact block={inlineHtml} />
        </div>
      );
    }
    if (isInlineHtmlTool(entry.name) && (entry.status === "running" || entry.status === "queued")) {
      const args = entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
        ? entry.arguments as Record<string, JsonValue>
        : {};
      const title = typeof args.title === "string" && args.title.trim()
        ? args.title
        : typeof args.path === "string"
          ? args.path.split("/").pop()?.replace(/\.html?$/i, "") || "HTML artifact"
          : "HTML artifact";
      return (
        <div className={`inline-html-artifact-event${entranceClass}`}>
          <InlineHtmlArtifactPending title={title} />
        </div>
      );
    }
    const fileToolResource = trustedFileToolResource(entry);
    const failureText = entry.status === "failed" ? firstTextOutput(entry) : undefined;
    const summaryDetail = failureText && presentation.category === "generic"
      ? `${displayToolName(entry.name)} · ${failureText}`
      : failureText ?? presentation.detail;
    const argumentsRecord = entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
      ? entry.arguments as Record<string, JsonValue>
      : undefined;
    const subagentTask = presentation.category === "agent" && typeof argumentsRecord?.task === "string"
      ? argumentsRecord.task
      : undefined;
    const subagentResponse = presentation.category === "agent"
      ? entry.output
          .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .filter((text) => text.trim())
          .join("\n\n")
      : "";
    return (
      <details className={`tool-event tool-event--${entry.status} tool-event--${presentation.category}${entranceClass}`}>
        <summary>
          <span className="tool-icon"><ToolGlyph category={presentation.category} /></span>
          <span className="tool-main">
            <strong>{presentation.title}</strong>
            <span className={failureText ? "tool-failure-summary" : undefined} title={failureText}>
              {summaryDetail}
            </span>
          </span>
          <span className="tool-status-copy" aria-hidden="true">{presentation.status}</span>
          <span className="tool-status"><ToolStatus entry={entry} /></span>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="disclosure-icon size-3.5" />
        </summary>
        {presentation.category === "agent" ? (
          <div className="tool-detail agent-detail">
            <section className="agent-detail-section">
              <h4 className="detail-label">Message</h4>
              {subagentTask
                ? <MarkdownText className="agent-detail-markdown markdown-body">{subagentTask}</MarkdownText>
                : <span className="agent-detail-placeholder">No message available.</span>}
            </section>
            <section className="agent-detail-section">
              <h4 className="detail-label">Response</h4>
              {subagentResponse
                ? <MarkdownText className="agent-detail-markdown markdown-body">{subagentResponse}</MarkdownText>
                : <span className="agent-detail-placeholder">{entry.status === "running" || entry.status === "queued" ? "Waiting for response…" : "No response returned."}</span>}
            </section>
          </div>
        ) : (
          <div className="tool-detail">
            {fileToolResource && <section className="tool-output"><span className="detail-label">File</span><ContentBlocks blocks={[fileToolResource]} compact onOpenProjectResource={onOpenProjectResource} /></section>}
            {entry.output.length > 0 && <section className="tool-output"><span className="detail-label">{entry.status === "running" ? "Live output" : "Output"}</span><ContentBlocks blocks={entry.output} compact onOpenProjectResource={onOpenProjectResource} /></section>}
            <JsonDetails label="Arguments" value={entry.arguments} />
            <JsonDetails label="Details" value={entry.details} />
            <JsonDetails label="Raw RPC event" value={entry.raw} />
          </div>
        )}
      </details>
    );
  }

  if (entry.kind === "interaction") {
    return (
      <article className={`interaction-event interaction-event--${entry.status}${entranceClass}`}>
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
    <article className={`system-event system-event--${entry.tone}${entranceClass}`}>
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
  | { key: string; kind: "tool-batch"; tools: ToolEntry[] }
  | { key: string; kind: "retry"; retry: RetryCycle };

function takeAssociatedRetryError(rows: TimelineRow[], expectedError: string | undefined): MessageEntry | undefined {
  if (!expectedError) return undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "retry") return undefined;
    if (row?.kind !== "entry" || row.entry.kind !== "message") continue;
    if (row.entry.role === "user") return undefined;
    if (row.entry.role !== "assistant") continue;
    if (row.entry.status !== "failed" || row.entry.error?.trim() !== expectedError) return undefined;
    rows.splice(index, 1);
    return row.entry;
  }
  return undefined;
}

function timelineRows(entries: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let activeRetry: Extract<TimelineRow, { kind: "retry" }> | undefined;
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (entry.kind === "message" && entry.role === "user") activeRetry = undefined;
    const retryType = retryEventType(entry);
    if (entry.kind === "event" && retryType === "auto_retry_start") {
      const associatedError = takeAssociatedRetryError(rows, retryString(entry, "errorMessage"));
      if (activeRetry) {
        activeRetry.retry.starts.push(entry);
        if (associatedError) activeRetry.retry.errors.push(associatedError);
      } else {
        activeRetry = {
          key: `retry-cycle-${entry.id}`,
          kind: "retry",
          retry: { starts: [entry], errors: associatedError ? [associatedError] : [] },
        };
        rows.push(activeRetry);
      }
      index += 1;
      continue;
    }
    if (entry.kind === "event" && retryType === "auto_retry_end" && activeRetry) {
      const associatedError = takeAssociatedRetryError(rows, retryString(entry, "finalError"));
      activeRetry.retry.end = entry;
      if (associatedError) activeRetry.retry.errors.push(associatedError);
      activeRetry = undefined;
      index += 1;
      continue;
    }
    if (entry.kind === "tool" && entry.batchId && !isInlineHtmlTool(entry.name)) {
      const tools: ToolEntry[] = [entry];
      let nextIndex = index + 1;
      while (nextIndex < entries.length) {
        const candidate = entries[nextIndex];
        if (candidate?.kind !== "tool" || candidate.batchId !== entry.batchId || isInlineHtmlTool(candidate.name)) break;
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

function TimelineRowView({ row, entering = false, onOpenProjectResource }: {
  row: TimelineRow;
  entering?: boolean;
  onOpenProjectResource: (block: ProjectResourceContentBlock) => void;
}) {
  const animateEntrance = useRef(entering).current;
  if (row.kind === "entry") return <TimelineItem entry={row.entry} entering={animateEntrance} onOpenProjectResource={onOpenProjectResource} />;
  if (row.kind === "retry") return <RetryTimelineItem retry={row.retry} entering={animateEntrance} />;
  const completed = row.tools.filter((tool) => tool.status === "completed").length;
  const running = row.tools.filter((tool) => tool.status === "running").length;
  const queued = row.tools.filter((tool) => tool.status === "queued").length;
  const failed = row.tools.filter((tool) => tool.status === "failed").length;
  const cancelled = row.tools.filter((tool) => tool.status === "cancelled").length;
  const settled = completed + failed + cancelled;
  const batchStatus = running || queued
    ? [
        `${settled}/${row.tools.length} settled`,
        running ? `${running} running` : undefined,
        queued ? `${queued} queued` : undefined,
        failed ? `${failed} failed` : undefined,
        cancelled ? `${cancelled} cancelled` : undefined,
      ].filter(Boolean).join(" · ")
    : failed || cancelled
      ? [
          completed ? `${completed} complete` : undefined,
          failed ? `${failed} failed` : undefined,
          cancelled ? `${cancelled} cancelled` : undefined,
        ].filter(Boolean).join(" · ")
      : `${completed}/${row.tools.length} complete`;
  return (
    <section className={`tool-batch${failed || cancelled ? " tool-batch--has-errors" : ""}${animateEntrance ? " timeline-entry--entering" : ""}`} aria-label={`${row.tools.length} parallel tools`}>
      <div className="tool-batch-label">
        <span><strong>Parallel work</strong><small>{row.tools.length} tools</small></span>
        <small>{batchStatus}</small>
      </div>
      <div className="tool-batch-progress" aria-hidden="true">
        <span className="tool-batch-progress-complete" style={{ width: `${(completed / row.tools.length) * 100}%` }} />
        <span className="tool-batch-progress-error" style={{ width: `${((failed + cancelled) / row.tools.length) * 100}%` }} />
      </div>
      {row.tools.map((tool) => <TimelineItem key={tool.id} entry={tool} onOpenProjectResource={onOpenProjectResource} />)}
    </section>
  );
}

export const Timeline = memo(function Timeline({ session, entries, loading = false, onOpenProjectResource = () => undefined }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const rows = useMemo(() => timelineRows(entries), [entries]);
  const seenRowKeys = useRef<Set<string> | null>(null);
  if (seenRowKeys.current === null) seenRowKeys.current = new Set(rows.map((row) => row.key));
  const enteringRowKeys = new Set(rows.filter((row) => {
    if (seenRowKeys.current!.has(row.key)) return false;
    // The optimistic user row already supplied the visual acknowledgement; do not flash again on server reconciliation.
    return row.kind !== "entry" || row.entry.kind !== "message" || row.entry.role !== "user" || row.entry.id.startsWith("optimistic-");
  }).map((row) => row.key));
  useLayoutEffect(() => {
    for (const row of rows) seenRowKeys.current!.add(row.key);
  }, [rows]);
  const virtualized = rows.length > 100;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "tool-batch" ? 180 : 96,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });
  // The CSS bottom anchor owns follow behavior; virtual measurements must not issue competing scroll corrections.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const activeTool = entries.some((entry) => entry.kind === "tool" && (entry.status === "running" || entry.status === "queued"));
  const activeRetry = rows.some((row) => row.kind === "retry" && !row.retry.end);
  const streamingResponse = entries.some((entry) => (
    entry.kind === "message" &&
    entry.role === "assistant" &&
    entry.status === "streaming" &&
    hasVisibleContent(entry.content)
  ));
  const lastUserMessage = [...entries].reverse().find((entry) => entry.kind === "message" && entry.role === "user");
  const showWorkingStatus = session.status === "running" && !activeTool && !activeRetry && !streamingResponse;
  const statusMessage = workingMessage(`${session.id}:${lastUserMessage?.id ?? "start"}`);
  const hasEntries = entries.length > 0;

  const updateFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const scheduleScrollToLatest = useCallback(() => {
    if (scrollFrame.current !== undefined) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      if (!followingRef.current) return;
      bottomRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    });
  }, []);

  const followLatest = useCallback(() => {
    updateFollowing(true);
    scheduleScrollToLatest();
  }, [scheduleScrollToLatest, updateFollowing]);

  const previousUserMessageId = useRef(lastUserMessage?.id);
  useLayoutEffect(() => {
    const currentId = lastUserMessage?.id;
    if (currentId !== previousUserMessageId.current && currentId?.startsWith("optimistic-")) {
      followLatest();
    }
    previousUserMessageId.current = currentId;
  }, [followLatest, lastUserMessage?.id]);

  const previousRowCount = useRef(rows.length);
  useLayoutEffect(() => {
    if (!hasEntries) {
      previousRowCount.current = 0;
      updateFollowing(true);
      return;
    }
    if (previousRowCount.current === 0 || rows.length > previousRowCount.current) {
      scheduleScrollToLatest();
    }
    previousRowCount.current = rows.length;
  }, [hasEntries, rows.length, scheduleScrollToLatest, updateFollowing]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const bottom = bottomRef.current;
    if (!hasEntries || !scroller || !bottom || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => {
      updateFollowing(entry?.isIntersecting ?? false);
    }, { root: scroller, threshold: 0 });
    observer.observe(bottom);
    scheduleScrollToLatest();
    return () => observer.disconnect();
  }, [hasEntries, scheduleScrollToLatest, updateFollowing]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const supportsScrollAnchoring = typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto");
    if (!hasEntries || !content || supportsScrollAnchoring || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (followingRef.current) scheduleScrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasEntries, scheduleScrollToLatest]);

  useLayoutEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);

  if (!hasEntries) {
    return (
      <div className="timeline-frame">
        <div ref={scrollRef} className="timeline timeline--empty">
          {loading ? (
            <div role="status" aria-label="Loading thread">
              <span className="forge-spinner" aria-hidden="true" />
            </div>
          ) : (
            <h2>What should Pi work on?</h2>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-frame">
      <div
        ref={scrollRef}
        className={`timeline${following ? "" : " timeline--detached"}`}
        onWheel={(event) => {
          if (event.deltaY < 0) updateFollowing(false);
        }}
      >
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
                      <TimelineRowView row={row} entering={enteringRowKeys.has(row.key)} onOpenProjectResource={onOpenProjectResource} />
                    </div>
                  );
                })}
              </div>
            ) : rows.map((row) => <TimelineRowView key={row.key} row={row} entering={enteringRowKeys.has(row.key)} onOpenProjectResource={onOpenProjectResource} />)}
          </div>
          {showWorkingStatus && (
            <div className="working-status" role="status" aria-live="polite">
              <span className="thinking-ellipsis" aria-hidden="true"><i /><i /><i /></span>
              <span>{statusMessage}</span>
            </div>
          )}
          <div className="timeline-follow-space" aria-hidden="true" />
          <div ref={bottomRef} className="timeline-bottom-anchor" aria-hidden="true" />
        </div>
      </div>
      {!following && (
        <button type="button" className="timeline-jump-latest" onClick={followLatest}>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
});
