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
  AiMagicIcon,
  ArrowUp02Icon,
  AtIcon,
  Attachment01Icon,
  Cancel01Icon,
  CommandIcon,
  File01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DeliveryMode, WorkspaceFile } from "../lib/anvilClient";
import { isTerminalInputTarget } from "../lib/keyboardScope";
import {
  loadPromptStashes,
  prependPromptStash,
  savePromptStashes,
  type PromptStash,
} from "../lib/promptStashes";
import { matchesShortcut } from "../lib/shortcuts";
import { PromptStashDialog } from "./PromptStashDialog";

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  reference?: ArtifactReference;
  error?: string;
}

export interface ComposerProps {
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
  skill?: SkillDescriptor;
};

interface SkillPrompt {
  skill?: SkillDescriptor;
  text: string;
}

interface CommandPrompt {
  command?: CommandDescriptor;
  text: string;
}

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

function slashItemScore(item: SlashItem, query: string): number {
  return fuzzyScore(item.label, query);
}

export function splitSkillPrompt(prompt: string, skills: readonly SkillDescriptor[]): SkillPrompt {
  const match = /^\/(skill:[^\s]+)(?:([\t\n\r ]+)([\s\S]*))?$/.exec(prompt);
  if (!match) return { text: prompt };

  const command = match[1]!;
  const knownSkill = skills.find((skill) => skill.command === command);
  if (!knownSkill && match[2] === undefined) return { text: prompt };

  return {
    skill: knownSkill ?? { name: command.replace(/^skill:/, ""), command },
    text: match[3] ?? "",
  };
}

export function joinSkillPrompt(skill: SkillDescriptor, text: string): string {
  return `/${skill.command} ${text}`;
}

export function splitCommandPrompt(prompt: string, commands: readonly CommandDescriptor[]): CommandPrompt {
  const match = /^\/([^\s]+)[\t\n\r ]+([\s\S]*)$/.exec(prompt);
  if (!match || match[1]?.startsWith("skill:")) return { text: prompt };
  const command = commands.find((candidate) => candidate.name === match[1]);
  return command ? { command, text: match[2] ?? "" } : { text: prompt };
}

export function joinCommandPrompt(command: CommandDescriptor, text: string): string {
  return `/${command.name} ${text}`;
}

function workspaceFileParts(path: string): { name: string; directory?: string; extension?: string } {
  const segments = path.split("/");
  const name = segments.pop() || path;
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  return { name, directory: segments.join("/") || undefined, extension };
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

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

function Widget({ widget }: { widget: ExtensionWidget }) {
  return (
    <aside className="extension-widget" aria-label={`Extension widget ${widget.key}`}>
      <span className="extension-widget-key">{widget.key}</span>
      {widget.lines.map((line, index) => <span key={`${widget.key}-${index}`}>{line}</span>)}
    </aside>
  );
}

function ContextProgress({ percent }: { percent: number | null }) {
  const progress = Math.min(100, Math.max(0, percent ?? 0));
  const level = progress >= 90 ? "danger" : progress >= 70 ? "warning" : "default";
  const percentageLabel = percent === null ? "Unknown" : `${Math.round(percent)}%`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`composer-context composer-context--${level}`}
          role="img"
          tabIndex={0}
          aria-label={`${percentageLabel} of context window used`}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle className="composer-context-track" cx="10" cy="10" r="7.5" />
            <circle
              className="composer-context-progress"
              cx="10"
              cy="10"
              r="7.5"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - progress}
            />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent>{percentageLabel} used</TooltipContent>
    </Tooltip>
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
  const [slashSelectionQuery, setSlashSelectionQuery] = useState<string>();
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(prompt.length);
  const [fileItems, setFileItems] = useState<WorkspaceFile[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  const [fileSearchPending, setFileSearchPending] = useState(false);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [stashDialogOpen, setStashDialogOpen] = useState(false);
  const [stashes, setStashes] = useState(loadPromptStashes);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileDragDepthRef = useRef(0);
  const running = status === "running";
  const readyAttachments = attachments.flatMap((attachment) => attachment.reference ? [attachment.reference] : []);
  const uploadsPending = attachments.some((attachment) => attachment.status === "uploading");
  const skillPrompt = splitSkillPrompt(prompt, skills);
  const commandPrompt = skillPrompt.skill ? { text: skillPrompt.text } : splitCommandPrompt(prompt, commands);
  const selectedSkill = skillPrompt.skill;
  const selectedCommand = commandPrompt.command;
  const displayPrompt = selectedSkill ? skillPrompt.text : commandPrompt.text;
  const hasPrompt = Boolean(displayPrompt.trim()) || Boolean(selectedSkill) || Boolean(selectedCommand) || readyAttachments.length > 0;
  const visibleModels = useMemo(() => selectAnvilModels(models), [models]);
  const model = visibleModels.find((candidate) => candidate.id === modelId);
  const modelsLoading = !modelsReady && status !== "failed";
  const queueCount = queue.steering.length + queue.followUp.length;
  const aboveWidgets = widgets.filter((widget) => widget.placement === "aboveEditor");
  const belowWidgets = widgets.filter((widget) => widget.placement === "belowEditor");
  const fileMention = activeFileMention(displayPrompt, cursorPosition);

  const slashQuery = displayPrompt.match(/^\/([^\s]*)$/)?.[1];
  const { slashCommandItems, slashSkillItems } = useMemo(() => {
    if (slashQuery === undefined) return { slashCommandItems: [], slashSkillItems: [] };
    const rank = (items: SlashItem[]) => items
      .map((item) => ({ item, score: slashItemScore(item, slashQuery) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
    const rankedCommands = rank(commands.map((command) => ({
      key: `command-${command.source}-${command.name}`,
      command: command.name,
      label: command.name,
      description: command.description,
      source: command.source,
    })));
    const rankedSkills = rank(skills.map((skill) => ({
      key: `skill-${skill.command}`,
      command: skill.command,
      label: skill.name,
      description: skill.description,
      source: "skill" as const,
      skill,
    })));

    return {
      slashCommandItems: rankedCommands.map(({ item }) => item),
      slashSkillItems: rankedSkills.map(({ item }) => item),
    };
  }, [commands, skills, slashQuery]);
  const slashItems = [...slashCommandItems, ...slashSkillItems];
  const activeSlashIndex = slashItems.length && slashSelectionQuery === slashQuery
    ? Math.min(slashIndex, slashItems.length - 1)
    : 0;
  const fileMenuOpen = Boolean(fileMention && !fileMenuDismissed);
  const slashMenuOpen = slashQuery !== undefined && !slashMenuDismissed;

  useEffect(() => {
    setSlashIndex(0);
    setSlashSelectionQuery(undefined);
    setSlashMenuDismissed(false);
    setCursorPosition(0);
    setFileItems([]);
    setFileIndex(0);
    setFileMenuDismissed(false);
    setFileSearchPending(false);
    setFileDropActive(false);
    setStashDialogOpen(false);
    fileDragDepthRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    const onStashShortcut = (event: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(event, "stash") || isTerminalInputTarget(event.target)) return;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (!stashDialogOpen && target?.closest('[role="dialog"], [role="alertdialog"]')) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || stashDialogOpen) return;

      if (prompt.length === 0) {
        setStashDialogOpen(true);
        return;
      }

      const next = prependPromptStash(stashes, prompt);
      if (!savePromptStashes(next)) {
        toast.error("Could not stash message", {
          description: "Browser storage rejected the message, so your input was left unchanged.",
        });
        return;
      }

      setStashes(next);
      onPromptChange(sessionId, "");
      setCursorPosition(0);
      toast.success("Message stashed", { description: "Use the stash shortcut with an empty composer to reuse it." });
    };

    window.addEventListener("keydown", onStashShortcut, true);
    return () => window.removeEventListener("keydown", onStashShortcut, true);
  }, [onPromptChange, prompt, sessionId, stashDialogOpen, stashes]);

  useEffect(() => {
    const resetFileDrag = () => {
      fileDragDepthRef.current = 0;
      setFileDropActive(false);
    };
    const onFileDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      fileDragDepthRef.current += 1;
      setFileDropActive(true);
    };
    const onFileDragOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setFileDropActive(true);
    };
    const onFileDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
      if (fileDragDepthRef.current === 0) setFileDropActive(false);
    };
    const onFileDrop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer?.files ?? []);
      resetFileDrag();
      if (files.length) onAttachFiles(sessionId, files);
    };

    window.addEventListener("dragenter", onFileDragEnter, true);
    window.addEventListener("dragover", onFileDragOver, true);
    window.addEventListener("dragleave", onFileDragLeave, true);
    window.addEventListener("drop", onFileDrop, true);
    window.addEventListener("blur", resetFileDrag);
    return () => {
      window.removeEventListener("dragenter", onFileDragEnter, true);
      window.removeEventListener("dragover", onFileDragOver, true);
      window.removeEventListener("dragleave", onFileDragLeave, true);
      window.removeEventListener("drop", onFileDrop, true);
      window.removeEventListener("blur", resetFileDrag);
      fileDragDepthRef.current = 0;
    };
  }, [onAttachFiles, sessionId]);

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
  }, [displayPrompt]);

  useEffect(() => {
    setSlashIndex(0);
    setSlashSelectionQuery(slashQuery);
    setSlashMenuDismissed(false);
  }, [slashQuery]);

  useEffect(() => {
    setFileIndex(0);
    setFileMenuDismissed(false);
  }, [fileMention?.query, fileMention?.start]);

  useEffect(() => {
    if (!fileMention || fileMenuDismissed) {
      setFileItems([]);
      setFileSearchPending(false);
      return;
    }
    let cancelled = false;
    setFileSearchPending(true);
    const timer = window.setTimeout(() => {
      void onSearchFiles(sessionId, fileMention.query).then((files) => {
        if (cancelled) return;
        setFileItems(files);
        setFileSearchPending(false);
      }).catch(() => {
        if (cancelled) return;
        setFileItems([]);
        setFileSearchPending(false);
      });
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMention?.query, fileMention?.start, fileMenuDismissed, onSearchFiles, sessionId]);

  const updateDisplayPrompt = (value: string) => {
    onPromptChange(
      sessionId,
      selectedSkill ? joinSkillPrompt(selectedSkill, value) : selectedCommand ? joinCommandPrompt(selectedCommand, value) : value,
    );
  };

  const attachSkill = (skill: SkillDescriptor, text: string) => {
    onPromptChange(sessionId, joinSkillPrompt(skill, text));
    setCursorPosition(text.length);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(text.length, text.length);
    });
  };

  const clearInvocation = () => {
    onPromptChange(sessionId, displayPrompt);
    setCursorPosition(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(0, 0);
    });
  };

  const chooseSlashItem = (item: SlashItem) => {
    if (item.skill) {
      attachSkill(item.skill, "");
      return;
    }
    const value = `/${item.command} `;
    onPromptChange(sessionId, value);
    setCursorPosition(0);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(0, 0);
    });
  };

  const chooseFile = (item: WorkspaceFile) => {
    if (!fileMention) return;
    const value = `${mentionValue(item.path)} `;
    const next = `${displayPrompt.slice(0, fileMention.start)}${value}${displayPrompt.slice(cursorPosition)}`;
    const nextCursor = fileMention.start + value.length;
    updateDisplayPrompt(next);
    setCursorPosition(nextCursor);
    setFileItems([]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const insertToken = (token: "@" | "/") => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? displayPrompt.length;
    const end = textarea?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(displayPrompt[start - 1] ?? "") ? ` ${token}` : token;
    const next = `${displayPrompt.slice(0, start)}${prefix}${displayPrompt.slice(end)}`;
    const nextCursor = start + prefix.length;
    updateDisplayPrompt(next);
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

  const restoreStash = (stash: PromptStash) => {
    const restored = splitSkillPrompt(stash.text, skills);
    onPromptChange(sessionId, stash.text);
    setCursorPosition(restored.text.length);
    setStashDialogOpen(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(restored.text.length, restored.text.length);
    });
  };

  const deleteStash = (stash: PromptStash) => {
    const next = stashes.filter((candidate) => candidate.id !== stash.id);
    if (!savePromptStashes(next)) {
      toast.error("Could not delete stash", { description: "Browser storage rejected the update." });
      return;
    }
    setStashes(next);
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
    if (
      event.key === "Backspace" &&
      (selectedSkill || selectedCommand) &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault();
      clearInvocation();
      return;
    }
    if (fileMenuOpen) {
      if (event.key === "ArrowDown" && fileItems.length) {
        event.preventDefault();
        setFileIndex((index) => (index + 1) % fileItems.length);
        return;
      }
      if (event.key === "ArrowUp" && fileItems.length) {
        event.preventDefault();
        setFileIndex((index) => (index - 1 + fileItems.length) % fileItems.length);
        return;
      }
      if (event.key === "Home" && fileItems.length) {
        event.preventDefault();
        setFileIndex(0);
        return;
      }
      if (event.key === "End" && fileItems.length) {
        event.preventDefault();
        setFileIndex(fileItems.length - 1);
        return;
      }
      if (event.key === "Enter" && fileItems.length) {
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
    if (slashMenuOpen) {
      if (event.key === "ArrowDown" && slashItems.length) {
        event.preventDefault();
        setSlashSelectionQuery(slashQuery);
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (event.key === "ArrowUp" && slashItems.length) {
        event.preventDefault();
        setSlashSelectionQuery(slashQuery);
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (event.key === "Home" && slashItems.length) {
        event.preventDefault();
        setSlashSelectionQuery(slashQuery);
        setSlashIndex(0);
        return;
      }
      if (event.key === "End" && slashItems.length) {
        event.preventDefault();
        setSlashSelectionQuery(slashQuery);
        setSlashIndex(slashItems.length - 1);
        return;
      }
      if (event.key === "Enter" && slashItems.length) {
        event.preventDefault();
        const item = slashItems[activeSlashIndex];
        if (item) chooseSlashItem(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuDismissed(true);
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

  const composerWrapRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const composerWrap = composerWrapRef.current;
    const conversation = composerWrap?.closest<HTMLElement>(".conversation-surface");
    if (!composerWrap || !conversation) return;

    const updateOverlayHeight = () => {
      conversation.style.setProperty("--composer-overlay-height", `${composerWrap.offsetHeight}px`);
    };
    updateOverlayHeight();

    const observer = new ResizeObserver(updateOverlayHeight);
    observer.observe(composerWrap);
    return () => {
      observer.disconnect();
      conversation.style.removeProperty("--composer-overlay-height");
    };
  }, []);

  return (
    <div ref={composerWrapRef} className="composer-wrap">
      <PromptStashDialog
        open={stashDialogOpen}
        stashes={stashes}
        onOpenChange={setStashDialogOpen}
        onSelect={restoreStash}
        onDelete={deleteStash}
      />
      {aboveWidgets.map((widget) => <Widget key={widget.key} widget={widget} />)}
      {queueCount > 0 && (
        <div className="queue-banner" aria-live="polite">
          {queue.steering.length > 0 && `${queue.steering.length} steering`}
          {queue.steering.length > 0 && queue.followUp.length > 0 && " · "}
          {queue.followUp.length > 0 && `${queue.followUp.length} follow-up`}
          {" queued"}
        </div>
      )}
      <form className={`composer${fileDropActive ? " composer--file-drop-active" : ""}`} onSubmit={submit}>
        <span className="sr-only" aria-live="polite">
          {fileDropActive ? "Drop files anywhere on this page to attach them." : ""}
        </span>
        <div className="composer-file-dropzone" aria-hidden="true">
          <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
          <span><strong>Drop files to attach</strong><small>Release anywhere on this page</small></span>
        </div>
        {fileMenuOpen && (
          <Command
            shouldFilter={false}
            value={fileItems[fileIndex]?.path}
            onValueChange={(value) => {
              const index = fileItems.findIndex((item) => item.path === value);
              if (index >= 0) setFileIndex(index);
            }}
            className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-30 h-auto w-auto rounded-lg shadow-md ring-1 ring-foreground/10"
            aria-label="Workspace files"
          >
            <CommandList id="file-mention-menu" className="max-h-[min(20rem,55vh)]">
              <CommandEmpty className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
                {fileSearchPending && <Spinner className="size-3" aria-hidden="true" />}
                {fileSearchPending ? "Searching workspace…" : `No files match “${fileMention?.query ?? ""}”`}
              </CommandEmpty>
              {fileItems.length > 0 && (
                <CommandGroup heading="Workspace files">
                  {fileItems.map((item, index) => {
                    const parts = workspaceFileParts(item.path);
                    return (
                      <CommandItem
                        id={`file-option-${index}`}
                        key={item.path}
                        value={item.path}
                        className="min-h-9"
                        onPointerDown={(event) => event.preventDefault()}
                        onSelect={() => chooseFile(item)}
                      >
                        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] font-medium">{parts.name}</span>
                        {parts.directory && <span className="hidden min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground sm:block">{parts.directory}</span>}
                        {parts.extension && <CommandShortcut>{parts.extension}</CommandShortcut>}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
        {slashMenuOpen && (
          <Command
            shouldFilter={false}
            value={slashItems[activeSlashIndex]?.key}
            onValueChange={(value) => {
              const index = slashItems.findIndex((item) => item.key === value);
              if (index >= 0) {
                setSlashSelectionQuery(slashQuery);
                setSlashIndex(index);
              }
            }}
            className="absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-30 h-auto w-auto rounded-lg shadow-md ring-1 ring-foreground/10"
            aria-label="Commands and skills"
          >
            <CommandList id="slash-command-menu" className="max-h-[min(20rem,55vh)]">
              <CommandEmpty>No command or skill matches “{slashQuery}”</CommandEmpty>
              {slashCommandItems.length > 0 && (
                <CommandGroup heading="Commands">
                  {slashCommandItems.map((item, index) => (
                    <CommandItem
                      id={`slash-option-${index}`}
                      key={item.key}
                      value={item.key}
                      className="min-h-9"
                      onPointerDown={(event) => event.preventDefault()}
                      onSelect={() => chooseSlashItem(item)}
                    >
                      <HugeiconsIcon icon={CommandIcon} strokeWidth={2} className="text-muted-foreground" />
                      <span className="min-w-0 shrink-0 truncate font-mono text-[0.6875rem] font-medium">/{item.command}</span>
                      {item.description && <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">{item.description}</span>}
                      <CommandShortcut>{item.source}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {slashSkillItems.length > 0 && (
                <CommandGroup heading="Skills">
                  {slashSkillItems.map((item, skillIndex) => {
                    const index = slashCommandItems.length + skillIndex;
                    return (
                      <CommandItem
                        id={`slash-option-${index}`}
                        key={item.key}
                        value={item.key}
                        className="min-h-9"
                        onPointerDown={(event) => event.preventDefault()}
                        onSelect={() => chooseSlashItem(item)}
                      >
                        <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} className="text-[var(--amber)]" />
                        <span className="min-w-0 shrink-0 truncate font-mono text-[0.6875rem] font-medium">{item.label}</span>
                        {item.description && <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">{item.description}</span>}
                        <CommandShortcut className="text-[var(--amber)]">skill</CommandShortcut>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached files" aria-live="polite">
            {attachments.map((attachment) => (
              <span className={`composer-attachment composer-attachment--${attachment.status}`} key={attachment.id} title={attachment.error}>
                <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-3" />
                <span><strong>{attachment.name}</strong><small>{attachment.status === "uploading" ? "Uploading…" : attachment.status === "failed" ? attachment.error ?? "Upload failed" : formatAttachmentSize(attachment.size)}</small></span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment(sessionId, attachment.id)}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" /></button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input-row">
          {selectedSkill && (
            <button type="button" className="composer-invocation composer-invocation--skill" onClick={clearInvocation} aria-label={`Remove ${selectedSkill.name} skill`}>
              {selectedSkill.name}
            </button>
          )}
          {selectedCommand && (
            <button type="button" className="composer-invocation composer-invocation--command" onClick={clearInvocation} aria-label={`Remove ${selectedCommand.name} command`}>
              {selectedCommand.name}
            </button>
          )}
          <Textarea
          ref={textareaRef}
          rows={1}
          value={displayPrompt}
          onChange={(event) => {
            updateDisplayPrompt(event.target.value);
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
          aria-expanded={fileMenuOpen || slashMenuOpen}
          aria-controls={fileMenuOpen ? "file-mention-menu" : slashMenuOpen ? "slash-command-menu" : undefined}
          aria-activedescendant={fileMenuOpen && fileItems.length ? `file-option-${fileIndex}` : slashMenuOpen && slashItems.length ? `slash-option-${activeSlashIndex}` : undefined}
          />
        </div>
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
                <Button type="button" variant="ghost" size="icon-sm" className="composer-icon" aria-label="Tag workspace file" onClick={() => insertToken("@")}>
                  <HugeiconsIcon icon={AtIcon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tag a workspace file</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="composer-icon"
                  aria-label="Open commands and skills"
                  onClick={() => insertToken("/")}
                >
                  <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open commands and skills</TooltipContent>
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
              <ContextProgress percent={contextUsage.percent} />
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
      {(creationError || pending) && (
        <div className={`composer-note${creationError ? " composer-note--error" : ""}`} role={creationError ? "alert" : "status"}>
          {creationError
            ? "Thread creation failed. Your text is preserved here so you can copy it before removing the thread."
            : "Starting thread… You can type while Forge connects."}
        </div>
      )}

    </div>
  );
}
