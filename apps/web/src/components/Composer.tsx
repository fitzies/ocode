import type {
  CommandDescriptor,
  ExtensionWidget,
  ModelDescriptor,
  SessionQueue,
  SessionStatus,
  SkillDescriptor,
  ThinkingLevel,
} from "@anvil/protocol";
import { Icon } from "@iconify/react";
import altArrowDownIcon from "@iconify-icons/solar/alt-arrow-down-linear";
import arrowUpIcon from "@iconify-icons/solar/arrow-up-bold";
import commandIcon from "@iconify-icons/solar/command-bold-duotone";
import mentionIcon from "@iconify-icons/solar/mention-circle-linear";
import paperclipIcon from "@iconify-icons/solar/paperclip-linear";
import stopIcon from "@iconify-icons/solar/stop-bold";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DeliveryMode } from "../lib/anvilClient";

interface ComposerProps {
  sessionId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  status: SessionStatus;
  models: ModelDescriptor[];
  commands: CommandDescriptor[];
  skills: SkillDescriptor[];
  queue: SessionQueue;
  draft?: string;
  widgets: ExtensionWidget[];
  onCancel: () => void;
  onDraftConsumed: () => void;
  onModelChange: (modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (prompt: string, mode: DeliveryMode) => void;
}

type SlashItem = {
  key: string;
  command: string;
  label: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
};

function handleListboxKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onClose: () => void,
) {
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='option']:not(:disabled)"),
  );
  if (!options.length) return;
  const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % options.length;
  if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = options.length - 1;
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
    return;
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    options[nextIndex]?.focus();
  }
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
  commands,
  skills,
  queue,
  draft,
  widgets,
  onCancel,
  onDraftConsumed,
  onModelChange,
  onThinkingLevelChange,
  onSend,
}: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [reasoningPickerOpen, setReasoningPickerOpen] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<Exclude<DeliveryMode, "prompt">>("steer");
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const reasoningPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const reasoningButtonRef = useRef<HTMLButtonElement>(null);
  const running = status === "running";
  const model = models.find((candidate) => candidate.id === modelId) ?? models[0];
  const queueCount = queue.steering.length + queue.followUp.length;
  const aboveWidgets = widgets.filter((widget) => widget.placement === "aboveEditor");
  const belowWidgets = widgets.filter((widget) => widget.placement === "belowEditor");

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
    setPrompt("");
    setSlashIndex(0);
  }, [sessionId]);

  useEffect(() => {
    if (!draft) return;
    setPrompt(draft);
    onDraftConsumed();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draft, onDraftConsumed]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [prompt]);

  useEffect(() => setSlashIndex(0), [slashQuery]);

  useEffect(() => {
    const picker = modelPickerOpen ? modelPickerRef.current : reasoningPickerOpen ? reasoningPickerRef.current : null;
    if (!picker) return;
    requestAnimationFrame(() =>
      (picker.querySelector("[role='option'][aria-selected='true']") as HTMLElement | null)?.focus(),
    );
  }, [modelPickerOpen, reasoningPickerOpen]);

  useEffect(() => {
    if (!modelPickerOpen && !reasoningPickerOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!modelPickerRef.current?.contains(target)) setModelPickerOpen(false);
      if (!reasoningPickerRef.current?.contains(target)) setReasoningPickerOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelPickerOpen(false);
        setReasoningPickerOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelPickerOpen, reasoningPickerOpen]);

  const chooseSlashItem = (item: SlashItem) => {
    setPrompt(`/${item.command} `);
    setSlashIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim()) return;
    onSend(prompt, running ? deliveryMode : "prompt");
    setPrompt("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
        setPrompt("");
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
                <Icon icon={commandIcon} width={15} />
                <span className="slash-option-copy">
                  <strong>/{item.command}</strong>
                  {item.description && <small>{item.description}</small>}
                </span>
                <span className={`slash-source slash-source--${item.source}`}>{item.source}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? "Steer Pi or queue a follow-up…" : "Message Pi…"}
          aria-label="Message Pi"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={slashItems.length > 0}
          aria-controls={slashItems.length ? "slash-command-menu" : undefined}
          aria-activedescendant={slashItems.length ? `slash-option-${slashIndex}` : undefined}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button type="button" className="composer-icon" aria-label="Attach file" disabled title="Coming soon">
              <Icon icon={paperclipIcon} width={17} />
            </button>
            <button type="button" className="composer-icon" aria-label="Mention context" disabled title="Coming soon">
              <Icon icon={mentionIcon} width={17} />
            </button>
            <span className="toolbar-divider" />
            <div className="model-picker" ref={modelPickerRef}>
              <button
                ref={modelButtonRef}
                type="button"
                className="model-select"
                onClick={() => setModelPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={modelPickerOpen}
              >
                <span>{model?.name ?? modelId}</span>
                <Icon icon={altArrowDownIcon} width={13} className={modelPickerOpen ? "model-chevron--open" : undefined} />
              </button>
              {modelPickerOpen && (
                <div className="model-menu" role="listbox" aria-label="Model" onKeyDown={(event) => handleListboxKeyDown(event, () => { setModelPickerOpen(false); modelButtonRef.current?.focus(); })}>
                  <div className="model-menu-label">Model</div>
                  {models.map((option) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.id === modelId}
                      tabIndex={option.id === modelId ? 0 : -1}
                      className={`model-option ${option.id === modelId ? "model-option--selected" : ""}`}
                      key={option.id}
                      onClick={() => {
                        onModelChange(option.id);
                        setModelPickerOpen(false);
                        requestAnimationFrame(() => modelButtonRef.current?.focus());
                      }}
                    >
                      <span>{option.name}<small>{option.provider}</small></span>
                      {option.id === modelId && <i />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="model-picker" ref={reasoningPickerRef}>
              <button
                ref={reasoningButtonRef}
                type="button"
                className="thinking-level"
                onClick={() => setReasoningPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={reasoningPickerOpen}
                disabled={!model?.reasoning}
              >
                <span>{thinkingLevel}</span>
                <Icon icon={altArrowDownIcon} width={13} className={reasoningPickerOpen ? "model-chevron--open" : undefined} />
              </button>
              {reasoningPickerOpen && model && (
                <div className="model-menu reasoning-menu" role="listbox" aria-label="Reasoning level" onKeyDown={(event) => handleListboxKeyDown(event, () => { setReasoningPickerOpen(false); reasoningButtonRef.current?.focus(); })}>
                  <div className="model-menu-label">Reasoning</div>
                  {model.supportedThinkingLevels.map((level) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={level === thinkingLevel}
                      tabIndex={level === thinkingLevel ? 0 : -1}
                      className={`model-option ${level === thinkingLevel ? "model-option--selected" : ""}`}
                      key={level}
                      onClick={() => {
                        onThinkingLevelChange(level);
                        setReasoningPickerOpen(false);
                        requestAnimationFrame(() => reasoningButtonRef.current?.focus());
                      }}
                    >
                      <span>{level}</span>
                      {level === thinkingLevel && <i />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="composer-actions">
            {running ? (
              <select
                className="delivery-select"
                aria-label="Message delivery"
                value={deliveryMode}
                onChange={(event) => setDeliveryMode(event.target.value as typeof deliveryMode)}
              >
                <option value="steer">Steer</option>
                <option value="followUp">Follow up</option>
              </select>
            ) : (
              <span className="send-hint">↵ Send</span>
            )}
            {running && (
              <button type="button" className="stop-button" onClick={onCancel} aria-label="Stop run">
                <Icon icon={stopIcon} width={14} />
              </button>
            )}
            <button type="submit" className="send-button" disabled={!prompt.trim()} aria-label={running ? `Queue ${deliveryMode === "steer" ? "steering message" : "follow-up"}` : "Send message"}>
              <Icon icon={arrowUpIcon} width={18} />
            </button>
          </div>
        </div>
      </form>
      {belowWidgets.map((widget) => <Widget key={widget.key} widget={widget} />)}
      <div className="composer-note">Pi has full Forge access. Review consequential changes before using them.</div>
    </div>
  );
}
