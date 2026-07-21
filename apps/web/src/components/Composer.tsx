import type { SessionStatus } from "@anvil/protocol";
import { ArrowUp, AtSign, ChevronDown, Paperclip, Square } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

interface ComposerProps {
  model: string;
  status: SessionStatus;
  onCancel: () => void;
  onModelChange: (model: string) => void;
  onSend: (prompt: string) => void;
}

export function Composer({ model, status, onCancel, onModelChange, onSend }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = status === "running";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [prompt]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim() || running) return;
    onSend(prompt);
    setPrompt("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
              <Paperclip size={16} />
            </button>
            <button type="button" className="composer-icon" aria-label="Mention context" disabled title="Coming soon">
              <AtSign size={16} />
            </button>
            <span className="toolbar-divider" />
            <label className="model-select">
              <span className="sr-only">Model</span>
              <select value={model} onChange={(event) => onModelChange(event.target.value)}>
                <option>GPT-5.4</option>
                <option>GPT-5.3 Codex</option>
                <option>Claude Opus 4.6</option>
              </select>
              <ChevronDown size={13} />
            </label>
            <button type="button" className="thinking-level" disabled title="Thinking level selection is coming soon">
              High <ChevronDown size={13} />
            </button>
          </div>
          <div className="composer-actions">
            {!running && <span className="send-hint">⌘ ↵</span>}
            {running ? (
              <button type="button" className="stop-button" onClick={onCancel} aria-label="Stop run">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!prompt.trim()}
                aria-label="Send message"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </form>
      <div className="composer-note">Pi can make mistakes. Review commands and changes before using them.</div>
    </div>
  );
}
