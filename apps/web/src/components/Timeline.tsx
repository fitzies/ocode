import { normalizeProjectResourcePath } from "@anvil/protocol";
import type {
  ArtifactReference,
  ContentBlock,
  ContextManifestV1,
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
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { AgentLoadingState } from "./AgentLoadingState";
import { CompactionCard, type CompactionStatus } from "./CompactionCard";
import { HandoffCard, type HandoffPresentation } from "./HandoffCard";
import { InlineHtmlArtifact, InlineHtmlArtifactPending } from "./InlineHtmlArtifact";
import { MarkdownText } from "./MarkdownText";
import { MessageActions } from "./MessageActions";
import { StreamingText } from "./StreamingText";
import { ToolChip } from "./ToolChip";
import { contextSourcesFromTool, ToolContextCards } from "./ToolContextCards";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { useTimelineScroll } from "./timelineScroll";
import { displayToolName, presentTool, type ToolCategory } from "./toolPresentation";

interface TimelineProps {
  session: SessionSummary;
  projectName?: string;
  entries: TimelineEntry[];
  loading?: boolean;
  onSuggestion: (prompt: string) => void;
  onRequestProjectChange?: () => void;
  onOpenProjectResource?: (block: ProjectResourceContentBlock) => void;
  sessions?: SessionSummary[];
  onSelectSession?: (sessionId: string) => void;
}

function hasVisibleContent(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => (
    block.type !== "toolCall" && (block.type !== "text" || block.text.length > 0)
  ));
}

function isHumanUserMessage(entry: TimelineEntry): entry is MessageEntry {
  return entry.kind === "message" && entry.role === "user" && entry.origin?.type !== "subagentCompletion";
}

function subagentCompletionBlocks(entry: MessageEntry): ContentBlock[] {
  const origin = entry.origin;
  if (origin?.type !== "subagentCompletion") return entry.content;
  const prefix = `[ocode ${origin.role} subagent ${origin.runId} ${origin.status}]\nChild session: ${origin.childSessionId}`;
  return entry.content.map((block) => block.type === "text" && block.text.startsWith(prefix)
    ? { ...block, text: block.text.slice(prefix.length).replace(/^\n+/, "") }
    : block);
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function contentPreview(blocks: ContentBlock[]): string {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

const EMPTY_FILE_ATTACHMENT_MARKER = /^<file name="[^"\r\n]*"><\/file>\r?$/gm;
const SKILL_INVOCATION_PREFIX = /^\/skill:([^\s]+)(?:[\t\n\r ]+|$)/;
const EXPANDED_SKILL_INVOCATION = /^<skill name="([^"]+)" location="[^"]+">\r?\n[\s\S]*?\r?\n<\/skill>(?:[\t ]*\r?\n){0,2}([\s\S]*)$/;
const COMMAND_INVOCATION_PREFIX = /^\/([^\s:]+)[\t\n\r ]+/;

function userSkillName(blocks: ContentBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.type !== "text") continue;
    return SKILL_INVOCATION_PREFIX.exec(block.text)?.[1] ?? EXPANDED_SKILL_INVOCATION.exec(block.text)?.[1];
  }
  return undefined;
}

function userCommandName(blocks: ContentBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.type !== "text") continue;
    return COMMAND_INVOCATION_PREFIX.exec(block.text)?.[1];
  }
  return undefined;
}

function userVisibleContent(blocks: ContentBlock[]): ContentBlock[] {
  const hasImage = blocks.some((block) => block.type === "image");
  let checkedSkillPrefix = false;
  return blocks.flatMap<ContentBlock>((block) => {
    if (block.type === "toolCall") return [];
    if (block.type !== "text") return [block];

    let text = block.text;
    if (!checkedSkillPrefix) {
      const expandedSkill = EXPANDED_SKILL_INVOCATION.exec(text);
      text = expandedSkill ? expandedSkill[2] ?? "" : text.replace(SKILL_INVOCATION_PREFIX, "");
      checkedSkillPrefix = true;
    }
    if (hasImage) text = text.replace(EMPTY_FILE_ATTACHMENT_MARKER, "");
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

function handoffPresentation(entry: SystemEventEntry): HandoffPresentation | undefined {
  const details = jsonRecord(entry.details);
  if (
    entry.category !== "lifecycle" ||
    details?.kind !== "ocode.handoff" ||
    (details.direction !== "incoming" && details.direction !== "outgoing") ||
    typeof details.sourceSessionId !== "string" ||
    typeof details.targetSessionId !== "string"
  ) return undefined;
  return {
    direction: details.direction,
    sourceSessionId: details.sourceSessionId,
    targetSessionId: details.targetSessionId,
  };
}

function compactionEventType(entry: TimelineEntry): "compaction_start" | "compaction_end" | undefined {
  if (entry.kind !== "event") return undefined;
  const raw = jsonRecord(entry.raw);
  return raw?.type === "compaction_start" || raw?.type === "compaction_end" ? raw.type : undefined;
}

function compactionStatus(events: SystemEventEntry[]): CompactionStatus {
  const end = events.find((entry) => compactionEventType(entry) === "compaction_end");
  if (!end) return "running";
  if (end.title.includes("cancelled")) return "cancelled";
  if (end.tone === "error") return "failed";
  return "completed";
}

function compactionTokens(events: SystemEventEntry[]): { before?: number; after?: number } {
  const end = events.find((entry) => compactionEventType(entry) === "compaction_end");
  const raw = jsonRecord(end?.raw);
  const result = jsonRecord(raw?.result);
  return {
    before: typeof result?.tokensBefore === "number" ? result.tokensBefore : undefined,
    after: typeof result?.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : undefined,
  };
}

function ImageBlock({ source, alt, caption }: { source?: string; alt: string; caption?: string }) {
  return (
    <figure className="image-block">
      {source ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="ghost" className="image-block__trigger" aria-label={`Open ${caption ?? alt}`}>
              <img src={source} alt={alt} />
            </Button>
          </DialogTrigger>
          <DialogContent showCloseButton={false} className="image-lightbox w-auto rounded-none bg-transparent p-0 ring-0" aria-describedby={undefined}>
            <DialogTitle className="sr-only">{caption ?? alt}</DialogTitle>
            <img src={source} alt={alt} />
          </DialogContent>
        </Dialog>
      ) : <div className="image-placeholder">Image data unavailable</div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function ContentBlocks({ blocks, compact = false, streamText = false, onOpenProjectResource }: {
  blocks: ContentBlock[];
  compact?: boolean;
  streamText?: boolean;
  onOpenProjectResource?: (block: ProjectResourceContentBlock) => void;
}) {
  if (!blocks.length) return null;
  return (
    <div className={compact ? "content-blocks content-blocks--compact" : "content-blocks"}>
      {blocks.map((block) => {
        if (block.type === "text") {
          if (streamText && !compact) return <StreamingText key={block.id} text={block.text} />;
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
          return <ImageBlock key={block.id} source={source} alt={block.alt ?? block.name ?? "Tool output"} caption={block.name ?? block.alt} />;
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
      <summary className="tool-event-trigger">
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

function ToolEventShell({
  title,
  detail,
  category,
  appearanceCategory = category,
  status,
  statusIcon,
  detailClassName,
  entering = false,
  children,
}: {
  title: string;
  detail: string;
  category: ToolCategory;
  appearanceCategory?: ToolCategory;
  status: string;
  statusIcon: ReactNode;
  detailClassName?: string;
  entering?: boolean;
  children: ReactNode;
}) {
  return (
    <ToolChip
      title={title}
      detail={detail}
      appearance={appearanceCategory}
      status={status}
      icon={<ToolGlyph category={category} />}
      statusIcon={statusIcon}
      detailClassName={detailClassName}
      entering={entering}
    >
      {children}
    </ToolChip>
  );
}

function TimelineItem({ entry, entering = false, onOpenProjectResource, sessions = [], onSelectSession }: {
  entry: TimelineEntry;
  entering?: boolean;
  onOpenProjectResource: (block: ProjectResourceContentBlock) => void;
  sessions?: SessionSummary[];
  onSelectSession?: (sessionId: string) => void;
}) {
  const entranceClass = entering ? " timeline-entry--entering" : "";
  if (entry.kind === "message") {
    if (entry.origin?.type === "subagentCompletion") {
      const blocks = subagentCompletionBlocks(entry);
      const successful = entry.origin.status === "completed";
      const preview = contentPreview(blocks);
      return (
        <ToolEventShell
          title={`${titleCase(entry.origin.role)} subagent`}
          detail={preview || "No response returned"}
          category="agent"
          appearanceCategory="generic"
          status={entry.origin.status}
          statusIcon={<HugeiconsIcon icon={successful ? CheckmarkCircle02Icon : AlertCircleIcon} strokeWidth={2} className="size-3.5" aria-label={titleCase(entry.origin.status)} />}
          entering={entering}
        >
          <div className="tool-detail">
            <section className="tool-output">
              <span className="detail-label">Answer</span>
              {hasVisibleContent(blocks)
                ? <ContentBlocks blocks={blocks} compact onOpenProjectResource={onOpenProjectResource} />
                : <span className="agent-detail-placeholder">No response returned.</span>}
            </section>
          </div>
        </ToolEventShell>
      );
    }
    const skillName = entry.role === "user" ? userSkillName(entry.content) : undefined;
    const commandName = entry.role === "user" && !skillName ? userCommandName(entry.content) : undefined;
    const visibleContent = entry.role === "user"
      ? userVisibleContent(entry.content)
      : entry.content.filter((block) => block.type !== "toolCall");
    if (!visibleContent.length && !skillName && !commandName && !entry.error && entry.status !== "streaming") return null;
    const messageClass = entry.role === "user" ? "user-message" : entry.role === "assistant" ? "assistant-message" : "system-message";
    const responseMarkdown = entry.role === "assistant" && entry.status === "complete"
      ? entry.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n\n")
      : "";
    const showResponseActions = responseMarkdown.trim().length > 0;
    return (
      <article className={`${messageClass} message-status--${entry.status}${entranceClass}`}>
        {skillName || commandName ? (
          <div className="user-invocation-message">
            {skillName && <span className="user-invocation user-invocation--skill" aria-label={`Skill: ${skillName}`}>{skillName}</span>}
            {commandName && <span className="user-invocation user-invocation--command" aria-label={`Command: ${commandName}`}>{commandName}</span>}
            <ContentBlocks blocks={skillName ? visibleContent : visibleContent.map((block, index) => (
              index === 0 && block.type === "text" ? { ...block, text: block.text.replace(COMMAND_INVOCATION_PREFIX, "") } : block
            ))} onOpenProjectResource={onOpenProjectResource} />
          </div>
        ) : (
          <ContentBlocks
            blocks={visibleContent}
            streamText={entry.role === "assistant" && entry.status === "streaming"}
            onOpenProjectResource={onOpenProjectResource}
          />
        )}
        {entry.status === "streaming" && entry.role === "user" && entry.id.startsWith("optimistic-")
          ? <span className="message-pending" role="status">
              {entry.raw && typeof entry.raw === "object" && !Array.isArray(entry.raw) && entry.raw.delivery === "steer" ? "Queueing…" : "Sending…"}
            </span>
          : entry.status === "streaming" && hasVisibleContent(visibleContent) && <span className="stream-caret" aria-label="Streaming" />}
        {showResponseActions && <MessageActions markdown={responseMarkdown} />}
        {entry.error && <div className="message-error">{entry.error}</div>}
        {(entry.role === "extension" || entry.status === "failed") && <JsonDetails label="Raw message" value={entry.raw} />}
      </article>
    );
  }

  // Reasoning entries are consolidated into turn-level rows by timelineRows.
  if (entry.kind === "reasoning") return null;

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
    const contextSources = presentation.category === "search" ? contextSourcesFromTool(entry) : [];
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
      <ToolEventShell
        title={presentation.title}
        detail={summaryDetail}
        category={presentation.category}
        status={entry.status}
        statusIcon={<ToolStatus entry={entry} />}
        detailClassName={failureText ? "tool-failure-summary" : undefined}
        entering={entering}
      >
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
            {contextSources.length > 0 && <section className="tool-output"><span className="detail-label">Source links</span><ToolContextCards sources={contextSources} /></section>}
            {entry.output.length > 0 && <section className="tool-output"><span className="detail-label">{entry.status === "running" ? "Live output" : "Output"}</span><ContentBlocks blocks={entry.output} compact onOpenProjectResource={onOpenProjectResource} /></section>}
            <JsonDetails label="Arguments" value={entry.arguments} />
            <JsonDetails label="Details" value={entry.details} />
            <JsonDetails label="Raw RPC event" value={entry.raw} />
          </div>
        )}
      </ToolEventShell>
    );
  }

  if (entry.kind === "interaction") {
    const statusLabel = entry.status === "pending" ? "Waiting" : entry.status === "answered" ? "Done" : entry.status;
    const statusIcon = entry.status === "pending"
      ? Loading03Icon
      : entry.status === "answered" ? CheckmarkCircle02Icon : AlertCircleIcon;
    return (
      <details className={`tool-event tool-event--interaction tool-event--${entry.status}${entranceClass}`}>
        <summary className="tool-event-trigger">
          <span className="tool-icon"><HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} className="size-4" /></span>
          <span className="tool-main">
            <strong>{entry.title}</strong>
            <span>{entry.summary ?? (entry.status === "pending" ? "Waiting for your response" : `Request ${entry.status}`)}</span>
          </span>
          <span className="tool-status-copy" aria-hidden="true">{statusLabel}</span>
          <span className="tool-status"><HugeiconsIcon icon={statusIcon} strokeWidth={2} className={entry.status === "pending" ? "size-3.5 animate-spin" : "size-4"} /></span>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="disclosure-icon size-3.5" />
        </summary>
        <div className="tool-detail">
          <JsonDetails label="Request payload" value={entry.raw} />
        </div>
      </details>
    );
  }

  const handoff = handoffPresentation(entry);
  if (handoff) {
    return (
      <HandoffCard
        handoff={handoff}
        sourceTitle={sessions.find((candidate) => candidate.id === handoff.sourceSessionId)?.title ?? "Source thread"}
        targetTitle={sessions.find((candidate) => candidate.id === handoff.targetSessionId)?.title ?? "Handoff thread"}
        onOpenSession={onSelectSession}
      />
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
  | { key: string; kind: "retry"; retry: RetryCycle }
  | { key: string; kind: "compaction"; events: SystemEventEntry[] };

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
  let activeCompaction: Extract<TimelineRow, { kind: "compaction" }> | undefined;
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (isHumanUserMessage(entry)) activeRetry = undefined;
    if (entry.kind === "reasoning") {
      index += 1;
      continue;
    }
    const compactionType = compactionEventType(entry);
    if (entry.kind === "event" && compactionType === "compaction_start") {
      activeCompaction = { key: `compaction-${entry.id}`, kind: "compaction", events: [entry] };
      rows.push(activeCompaction);
      index += 1;
      continue;
    }
    if (entry.kind === "event" && compactionType === "compaction_end") {
      if (activeCompaction) activeCompaction.events.push(entry);
      else rows.push({ key: `compaction-${entry.id}`, kind: "compaction", events: [entry] });
      activeCompaction = undefined;
      index += 1;
      continue;
    }
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

function TimelineRowView({ row, entering = false, onOpenProjectResource, sessions, onSelectSession }: {
  row: TimelineRow;
  entering?: boolean;
  onOpenProjectResource: (block: ProjectResourceContentBlock) => void;
  sessions?: SessionSummary[];
  onSelectSession?: (sessionId: string) => void;
}) {
  const animateEntrance = useRef(entering).current;
  if (row.kind === "entry") return <TimelineItem entry={row.entry} entering={animateEntrance} onOpenProjectResource={onOpenProjectResource} sessions={sessions} onSelectSession={onSelectSession} />;
  if (row.kind === "retry") return <RetryTimelineItem retry={row.retry} entering={animateEntrance} />;
  if (row.kind === "compaction") {
    const tokens = compactionTokens(row.events);
    return (
      <CompactionCard
        status={compactionStatus(row.events)}
        tokensBefore={tokens.before}
        tokensAfter={tokens.after}
        entering={animateEntrance}
        details={<JsonDetails label="Technical details" value={row.events.map((entry) => entry.raw ?? entry.details ?? null)} />}
      />
    );
  }
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
      {row.tools.map((tool) => <TimelineItem key={tool.id} entry={tool} onOpenProjectResource={onOpenProjectResource} sessions={sessions} onSelectSession={onSelectSession} />)}
    </section>
  );
}

export const Timeline = memo(function Timeline({ session, projectName = "this project", entries, loading = false, onRequestProjectChange = () => undefined, onOpenProjectResource = () => undefined, sessions = [], onSelectSession }: TimelineProps) {
  const hasEntries = entries.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => timelineRows(entries), [entries]);
  const seenRowKeys = useRef<Set<string> | null>(null);
  if (seenRowKeys.current === null) seenRowKeys.current = new Set(rows.map((row) => row.key));
  const enteringRowKeys = new Set(rows.filter((row) => {
    if (seenRowKeys.current!.has(row.key)) return false;
    // The optimistic user row already supplied the visual acknowledgement; do not flash again on server reconciliation.
    return row.kind !== "entry" || row.entry.kind !== "message" || !isHumanUserMessage(row.entry) || row.entry.id.startsWith("optimistic-");
  }).map((row) => row.key));
  useLayoutEffect(() => {
    for (const row of rows) seenRowKeys.current!.add(row.key);
  }, [rows]);
  const virtualized = rows.length > 100;
  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.kind === "tool-batch") return 44 + row.tools.length * 34;
      if (row?.kind === "entry" && row.entry.kind === "tool") return 34;
      if (row?.kind === "entry" && row.entry.kind === "message") return 112;
      return 64;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });
  const { following, isFollowingRef, followLatest, handlers: scrollHandlers } = useTimelineScroll({
    sessionId: session.id,
    hasEntries,
    loading,
    scrollRef,
    contentRef,
    getAnchor: virtualized ? () => {
      const scroller = scrollRef.current;
      if (!scroller) return undefined;
      const item = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
      return item ? { key: String(item.key), offset: scroller.scrollTop - item.start } : undefined;
    } : undefined,
    restoreAnchor: virtualized ? (anchor) => {
      const index = rows.findIndex((row) => row.key === anchor.key);
      if (index < 0) return false;
      const target = virtualizer.getOffsetForIndex(index, "start");
      if (!target) return false;
      virtualizer.scrollToOffset(target[0] + anchor.offset, { align: "start" });
      return true;
    } : undefined,
  });
  // The scroll controller owns live following; TanStack only preserves a detached reader's viewport.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    !isFollowingRef.current &&
    instance.scrollDirection !== "backward" &&
    item.start < (instance.scrollOffset ?? 0)
  );
  const lastUserMessage = [...entries].reverse().find(isHumanUserMessage);

  const previousUserMessageId = useRef(lastUserMessage?.id);
  useLayoutEffect(() => {
    const currentId = lastUserMessage?.id;
    if (currentId !== previousUserMessageId.current && currentId?.startsWith("optimistic-")) {
      followLatest(false);
    }
    previousUserMessageId.current = currentId;
  }, [followLatest, lastUserMessage?.id]);

  if (!hasEntries) {
    return (
      <div className="timeline-frame">
        <div ref={scrollRef} className="timeline timeline--empty">
          {loading ? (
            <AgentLoadingState label="Loading thread" className="timeline-loading-state" />
          ) : (
            <h2>
              What are we building in{" "}
              <Button
                type="button"
                variant="link"
                className="timeline-empty-project"
                aria-label={`Change project from ${projectName}`}
                onClick={onRequestProjectChange}
              >
                {projectName}
              </Button>
            </h2>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-frame">
      <div
        ref={scrollRef}
        className={`timeline${virtualized ? " timeline--virtualized" : ""}${following ? "" : " timeline--detached"}`}
        {...scrollHandlers}
      >
        <div ref={contentRef} className="timeline-inner">
          <div className="timeline-date"><span>Recorded session</span></div>
          <div className="timeline-events" aria-live="polite" aria-relevant="additions">
            {virtualized ? (
              <div className="timeline-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const row = rows[item.index]!;
                  return (
                    <div
                      className={`timeline-virtual-row timeline-virtual-row--${row.kind === "entry" ? row.entry.kind : row.kind}`}
                      data-index={item.index}
                      key={row.key}
                      ref={virtualizer.measureElement}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <TimelineRowView row={row} entering={enteringRowKeys.has(row.key)} onOpenProjectResource={onOpenProjectResource} sessions={sessions} onSelectSession={onSelectSession} />
                    </div>
                  );
                })}
              </div>
            ) : rows.map((row) => <TimelineRowView key={row.key} row={row} entering={enteringRowKeys.has(row.key)} onOpenProjectResource={onOpenProjectResource} sessions={sessions} onSelectSession={onSelectSession} />)}
          </div>
          <div className="timeline-follow-space" aria-hidden="true" />
          <div className="timeline-bottom-anchor" aria-hidden="true" />
        </div>
      </div>
      {!following && (
        <button type="button" className="timeline-jump-latest" onClick={() => followLatest()}>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
});
