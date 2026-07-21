import type { SessionStatus } from "@anvil/protocol";
import { Icon } from "@iconify/react";
import altArrowDownIcon from "@iconify-icons/solar/alt-arrow-down-linear";
import arrowUpIcon from "@iconify-icons/solar/arrow-up-bold";
import mentionIcon from "@iconify-icons/solar/mention-circle-linear";
import paperclipIcon from "@iconify-icons/solar/paperclip-linear";
import stopIcon from "@iconify-icons/solar/stop-bold";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

const models = ["GPT-5.4", "GPT-5.3 Codex", "Claude Opus 4.6"];
const reasoningLevels = ["Low", "Medium", "High"];

interface ComposerProps {
  model: string;
  status: SessionStatus;
  onCancel: () => void;
  onModelChange: (model: string) => void;
  onSend: (prompt: string) => void;
}

export function Composer({ model, status, onCancel, onModelChange, onSend }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [reasoningPickerOpen, setReasoningPickerOpen] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState("High");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const reasoningPickerRef = useRef<HTMLDivElement>(null);
  const running = status === "running";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [prompt]);

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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim() || running) return;
    onSend(prompt);
    setPrompt("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      {status === "waiting" && (
        <div className="attention-banner">
          <span /> Pi is waiting for your input before it can continue.
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? "Pi is working…" : "Message Pi…"}
          aria-label="Message Pi"
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
                type="button"
                className="model-select"
                onClick={() => setModelPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={modelPickerOpen}
              >
                <span>{model}</span>
                <Icon
                  icon={altArrowDownIcon}
                  width={13}
                  className={modelPickerOpen ? "model-chevron--open" : undefined}
                />
              </button>
              {modelPickerOpen && (
                <div className="model-menu" role="listbox" aria-label="Model">
                  <div className="model-menu-label">Model</div>
                  {models.map((option) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={option === model}
                      className={`model-option ${option === model ? "model-option--selected" : ""}`}
                      key={option}
                      onClick={() => {
                        onModelChange(option);
                        setModelPickerOpen(false);
                      }}
                    >
                      <span>{option}</span>
                      {option === model && <i />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="model-picker" ref={reasoningPickerRef}>
              <button
                type="button"
                className="thinking-level"
                onClick={() => setReasoningPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={reasoningPickerOpen}
              >
                <span>{reasoningLevel}</span>
                <Icon
                  icon={altArrowDownIcon}
                  width={13}
                  className={reasoningPickerOpen ? "model-chevron--open" : undefined}
                />
              </button>
              {reasoningPickerOpen && (
                <div className="model-menu reasoning-menu" role="listbox" aria-label="Reasoning level">
                  <div className="model-menu-label">Reasoning</div>
                  {reasoningLevels.map((level) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={level === reasoningLevel}
                      className={`model-option ${level === reasoningLevel ? "model-option--selected" : ""}`}
                      key={level}
                      onClick={() => {
                        setReasoningLevel(level);
                        setReasoningPickerOpen(false);
                      }}
                    >
                      <span>{level}</span>
                      {level === reasoningLevel && <i />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="composer-actions">
            {!running && <span className="send-hint">↵ Send</span>}
            {running ? (
              <button type="button" className="stop-button" onClick={onCancel} aria-label="Stop run">
                <Icon icon={stopIcon} width={14} />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!prompt.trim()}
                aria-label="Send message"
              >
                <Icon icon={arrowUpIcon} width={18} />
              </button>
            )}
          </div>
        </div>
      </form>
      <div className="composer-note">Pi can make mistakes. Review commands and changes before using them.</div>
    </div>
  );
}
