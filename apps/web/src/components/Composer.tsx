import type {
  ArtifactReference,
  CommandDescriptor,
  ExtensionWidget,
  ModelDescriptor,
  SessionQueue,
  SessionStatus,
  SkillDescriptor,
  ThinkingLevel,
} from "@anvil/protocol";
import {
  ArrowUp02Icon,
  AtIcon,
  Attachment01Icon,
  Cancel01Icon,
  CommandIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DeliveryMode, WorkspaceFile } from "../lib/anvilClient";

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  reference?: ArtifactReference;
  error?: string;
}

interface ComposerProps {
  sessionId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  status: SessionStatus;
  models: ModelDescriptor[];
  modelsReady: boolean;
  commands: CommandDescriptor[];
  skills: SkillDescriptor[];
  queue: SessionQueue;
  draft?: string;
  prompt: string;
  pending?: boolean;
  creationError?: string;
  widgets: ExtensionWidget[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  attachments: ComposerAttachment[];
  onAttachFiles: (sessionId: string, files: File[]) => void;
  onRemoveAttachment: (sessionId: string, attachmentId: string) => void;
  onSearchFiles: (sessionId: string, query: string) => Promise<WorkspaceFile[]>;
  onCancel: () => void;
  onDraftConsumed: (sessionId: string) => void;
  onPromptChange: (sessionId: string, prompt: string) => void;
  onModelChange: (modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (prompt: string, mode: DeliveryMode, attachments: ArtifactReference[]) => void;
}

type SlashItem = {
  key: string;
  command: string;
  label: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
};

export function updateComposerDraft(
  drafts: Record<string, string>,
  sessionId: string,
  prompt: string,
): Record<string, string> {
  if (drafts[sessionId] === prompt) return drafts;
  if (prompt) return { ...drafts, [sessionId]: prompt };
  const next = { ...drafts };
  delete next[sessionId];
  return next;
}

export function selectAnvilModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.filter((model) => model.id.includes("5.6") || model.name.includes("5.6"));
}

export function nextThinkingLevel(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel,
): ThinkingLevel | undefined {
  if (levels.length < 2) return undefined;
  const currentIndex = levels.indexOf(current);
  return levels[(currentIndex + 1) % levels.length];
}

function fuzzyScore(value: string, query: string): number {
  if (!query) return 1;
  const target = value.toLowerCase();
  const needle = query.toLowerCase();
  if (target.startsWith(needle)) return 100 - (target.length - needle.length);
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const index = target.indexOf(character, cursor);
    if (index === -1) return -1;
    score += index === cursor ? 4 : 1;
    cursor = index + 1;
  }
  return score;
}

export function activeFileMention(text: string, cursor: number): { start: number; query: string } | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = /(^|[\s([{=:])@(?:"([^"]*)|([^\s@"']*))$/.exec(beforeCursor);
  if (!match) return undefined;
  const token = match[0].slice(match[1]?.length ?? 0);
  return {
    start: cursor - token.length,
    query: match[2] ?? match[3] ?? "",
  };
}

function mentionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function namePastedFile(file: File, index: number): File {
  if (file.name.trim()) return file;
  const extension = file.type.split("/", 2)[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9.+-]/gi, "") || "bin";
  return new File([file], `pasted-attachment-${index + 1}.${extension}`, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  });
}

function Widget({ widget }: { widget: ExtensionWidget }) {
  return (
    <aside className="extension-widget" aria-label={`Extension widget ${widget.key}`}>
      <span className="extension-widget-key">{widget.key}</span>
      {widget.lines.map((line, index) => <span key={`${widget.key}-${index}`}>{line}</span>)}
    </aside>
  );
}

export function Composer({
  sessionId,
  modelId,
  thinkingLevel,
  status,
  models,
  modelsReady,
  commands,
  skills,
  queue,
  draft,
  prompt,
  pending = false,
  creationError,
  widgets,
  contextUsage,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  onSearchFiles,
  onCancel,
  onDraftConsumed,
  onPromptChange,
  onModelChange,
  onThinkingLevelChange,
  onSend,
}: ComposerProps) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(prompt.length);
  const [fileItems, setFileItems] = useState<WorkspaceFile[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const running = status === "running";
  const readyAttachments = attachments.flatMap((attachment) => attachment.reference ? [attachment.reference] : []);
  const uploadsPending = attachments.some((attachment) => attachment.status === "uploading");
  const hasPrompt = Boolean(prompt.trim()) || readyAttachments.length > 0;
  const visibleModels = useMemo(() => selectAnvilModels(models), [models]);
  const model = visibleModels.find((candidate) => candidate.id === modelId);
  const modelsLoading = !modelsReady && status !== "failed";
  const queueCount = queue.steering.length + queue.followUp.length;
  const aboveWidgets = widgets.filter((widget) => widget.placement === "aboveEditor");
  const belowWidgets = widgets.filter((widget) => widget.placement === "belowEditor");
  const fileMention = activeFileMention(prompt, cursorPosition);

  const slashQuery = prompt.match(/^\/([^\s]*)$/)?.[1];
  const slashItems = useMemo<SlashItem[]>(() => {
    if (slashQuery === undefined) return [];
    return [
      ...commands.map((command) => ({
        key: `command-${command.source}-${command.name}`,
        command: command.name,
        label: command.name,
        description: command.description,
        source: command.source,
      })),
      ...skills.map((skill) => ({
        key: `skill-${skill.command}`,
        command: skill.command,
        label: skill.name,
        description: skill.description,
        source: "skill" as const,
      })),
    ]
      .map((item) => ({ item, score: fuzzyScore(`${item.label} ${item.description ?? ""}`, slashQuery) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .slice(0, 8)
      .map(({ item }) => item);
  }, [commands, skills, slashQuery]);

  useEffect(() => {
    setSlashIndex(0);
    setCursorPosition(0);
    setFileItems([]);
    setFileIndex(0);
    setFileMenuDismissed(false);
  }, [sessionId]);

  useEffect(() => {
    if (!draft) return;
    if (!prompt) onPromptChange(sessionId, draft);
    onDraftConsumed(sessionId);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draft, onDraftConsumed, onPromptChange, prompt, sessionId]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [prompt]);

  useEffect(() => setSlashIndex(0), [slashQuery]);

  useEffect(() => {
    setFileIndex(0);
    setFileMenuDismissed(false);
  }, [fileMention?.query, fileMention?.start]);

  useEffect(() => {
    if (!fileMention || fileMenuDismissed) {
      setFileItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearchFiles(sessionId, fileMention.query).then((files) => {
        if (!cancelled) setFileItems(files);
      });
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMention?.query, fileMention?.start, fileMenuDismissed, onSearchFiles, sessionId]);

  const chooseSlashItem = (item: SlashItem) => {
    const value = `/${item.command} `;
    onPromptChange(sessionId, value);
    setCursorPosition(value.length);
    setSlashIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseFile = (item: WorkspaceFile) => {
    if (!fileMention) return;
    const value = `${mentionValue(item.path)} `;
    const next = `${prompt.slice(0, fileMention.start)}${value}${prompt.slice(cursorPosition)}`;
    const nextCursor = fileMention.start + value.length;
    onPromptChange(sessionId, next);
    setCursorPosition(nextCursor);
    setFileItems([]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const insertMention = () => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(prompt[start - 1] ?? "") ? " @" : "@";
    const next = `${prompt.slice(0, start)}${prefix}${prompt.slice(end)}`;
    const nextCursor = start + prefix.length;
    onPromptChange(sessionId, next);
    setCursorPosition(nextCursor);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!hasPrompt || uploadsPending || creationError) return;
    onSend(prompt, running ? "steer" : "prompt", readyAttachments);
    onPromptChange(sessionId, "");
    setCursorPosition(0);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files, namePastedFile);
    if (!files.length) return;

    event.preventDefault();
    onAttachFiles(sessionId, files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Tab" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const nextLevel = nextThinkingLevel(model?.supportedThinkingLevels ?? [], thinkingLevel);
      if (nextLevel) {
        event.preventDefault();
        onThinkingLevelChange(nextLevel);
        return;
      }
    }
    if (fileMention && fileItems.length && !fileMenuDismissed) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFileIndex((index) => (index + 1) % fileItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFileIndex((index) => (index - 1 + fileItems.length) % fileItems.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const item = fileItems[fileIndex];
        if (item) chooseFile(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setFileMenuDismissed(true);
        setFileItems([]);
        return;
      }
    }
    if (slashItems.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const item = slashItems[slashIndex];
        if (item) chooseSlashItem(item);
        return;
      }
      if (event.key === "Escape") {
        onPromptChange(sessionId, "");
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      {aboveWidgets.map((widget) => <Widget key={widget.key} widget={widget} />)}
      {status === "waiting" && (
        <div className="attention-banner">
          <span /> Pi is waiting for your input before it can continue.
        </div>
      )}
      {queueCount > 0 && (
        <div className="queue-banner" aria-live="polite">
          {queue.steering.length > 0 && `${queue.steering.length} steering`}
          {queue.steering.length > 0 && queue.followUp.length > 0 && " · "}
          {queue.followUp.length > 0 && `${queue.followUp.length} follow-up`}
          {" queued"}
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        {fileMention && fileItems.length > 0 && !fileMenuDismissed && (
          <div id="file-mention-menu" className="slash-menu file-menu" role="listbox" aria-label="Workspace files">
            <div className="slash-menu-heading">
              <span>Workspace files</span>
              <kbd>↑↓ navigate · ↵ tag</kbd>
            </div>
            {fileItems.map((item, index) => (
              <button
                id={`file-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === fileIndex}
                tabIndex={-1}
                className={index === fileIndex ? "slash-option slash-option--active" : "slash-option"}
                key={item.path}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chooseFile(item)}
              >
                <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-3.5" />
                <span className="slash-option-copy"><strong>{item.path}</strong></span>
                <span className="slash-source">file</span>
              </button>
            ))}
          </div>
        )}
        {slashQuery !== undefined && slashItems.length > 0 && (
          <div id="slash-command-menu" className="slash-menu" role="listbox" aria-label="Commands and skills">
            <div className="slash-menu-heading">
              <span>Commands &amp; skills</span>
              <kbd>↑↓ navigate · ↵ insert</kbd>
            </div>
            {slashItems.map((item, index) => (
              <button
                id={`slash-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === slashIndex}
                tabIndex={-1}
                className={index === slashIndex ? "slash-option slash-option--active" : "slash-option"}
                key={item.key}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chooseSlashItem(item)}
              >
                <HugeiconsIcon icon={CommandIcon} strokeWidth={2} className="size-3.5" />
                <span className="slash-option-copy">
                  <strong>/{item.command}</strong>
                  {item.description && <small>{item.description}</small>}
                </span>
                <span className={`slash-source slash-source--${item.source}`}>{item.source}</span>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached files">
            {attachments.map((attachment) => (
              <span className={`composer-attachment composer-attachment--${attachment.status}`} key={attachment.id} title={attachment.error}>
                <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-3" />
                <span><strong>{attachment.name}</strong><small>{attachment.status === "uploading" ? "Uploading…" : attachment.status === "failed" ? attachment.error ?? "Upload failed" : formatAttachmentSize(attachment.size)}</small></span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment(sessionId, attachment.id)}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" /></button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          ref={textareaRef}
          rows={1}
          value={prompt}
          onChange={(event) => {
            onPromptChange(sessionId, event.target.value);
            setCursorPosition(event.target.selectionStart);
          }}
          onSelect={(event) => setCursorPosition(event.currentTarget.selectionStart)}
          onClick={(event) => setCursorPosition(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursorPosition(event.currentTarget.selectionStart)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder={running ? "Steer Pi…" : "Message Pi…"}
          aria-label="Message Pi"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={(fileMention && fileItems.length > 0 && !fileMenuDismissed) || slashItems.length > 0}
          aria-controls={fileMention && fileItems.length > 0 && !fileMenuDismissed ? "file-mention-menu" : slashItems.length ? "slash-command-menu" : undefined}
          aria-activedescendant={fileMention && fileItems.length > 0 && !fileMenuDismissed ? `file-option-${fileIndex}` : slashItems.length ? `slash-option-${slashIndex}` : undefined}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) onAttachFiles(sessionId, files);
                event.target.value = "";
              }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="composer-icon" aria-label="Attach file" onClick={() => fileInputRef.current?.click()}>
                  <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach files from this device</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="composer-icon" aria-label="Tag workspace file" onClick={insertMention}>
                  <HugeiconsIcon icon={AtIcon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tag a workspace file</TooltipContent>
            </Tooltip>
            <span className="toolbar-divider" />
            <Select value={model?.id} onValueChange={onModelChange} disabled={modelsLoading || visibleModels.length === 0}>
              <SelectTrigger
                size="sm"
                className={`model-select max-w-32${modelsLoading ? " model-select--loading" : ""}`}
                aria-label={modelsLoading ? "Loading models" : "Model"}
                aria-busy={modelsLoading}
              >
                {modelsLoading
                  ? <Spinner className="size-3.5" aria-hidden="true" />
                  : <SelectValue placeholder={visibleModels.length ? "Choose model" : "No models available"} />}
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Model</SelectLabel>
                  {visibleModels.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={thinkingLevel} onValueChange={(value) => onThinkingLevelChange(value as ThinkingLevel)} disabled={modelsLoading || !model?.reasoning}>
              <SelectTrigger size="sm" className="thinking-level" aria-label="Reasoning level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="top" align="start" sideOffset={6}>
                <SelectGroup>
                  <SelectLabel>Reasoning</SelectLabel>
                  {model?.supportedThinkingLevels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="composer-actions">
            {contextUsage && (
              <span
                className={`composer-context ${(contextUsage.percent ?? 0) >= 70 ? "composer-context--high" : ""}`}
                title={`${contextUsage.tokens?.toLocaleString() ?? "Unknown"} of ${contextUsage.contextWindow.toLocaleString()} context tokens`}
              >
                ctx {contextUsage.percent === null ? "?" : Math.round(contextUsage.percent)}%
              </span>
            )}
            {running && !hasPrompt ? (
              <Button type="button" variant="secondary" size="icon-sm" className="stop-button" onClick={onCancel} aria-label="Stop run" title="Stop run">
                <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                className="send-button"
                disabled={!hasPrompt || uploadsPending || Boolean(creationError)}
                aria-label={pending ? "Queue message while thread starts" : running ? "Send steering message" : "Send message"}
                title={creationError ? "Thread creation failed" : pending ? "Queue while starting" : running ? "Steer Pi" : undefined}
              >
                <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
              </Button>
            )}
          </div>
        </div>
      </form>
      {belowWidgets.map((widget) => <Widget key={widget.key} widget={widget} />)}
      <div className="composer-note">
        {creationError
          ? "Thread creation failed. Your text is preserved here so you can copy it before removing the thread."
          : pending
            ? "Starting thread… You can type while Forge connects."
            : "Pi has full Forge access. Review consequential changes before using them."}
      </div>
    </div>
  );
}
