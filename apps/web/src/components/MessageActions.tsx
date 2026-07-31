import { Copy01Icon, Loading03Icon, Speaker01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { markdownToSpeakableText } from "../lib/speechText";
import { useSpeech } from "./SpeechProvider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export function speechTextForMessage(
  enabled: boolean,
  markdown: string,
  serialize: (value: string) => string = markdownToSpeakableText,
): string {
  return enabled ? serialize(markdown) : "";
}

export function MessageActions({
  messageId,
  markdown,
}: {
  messageId: string;
  markdown: string;
}) {
  const { status, playback, speak } = useSpeech();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);
  const disclosureId = useId();
  const speakable = useMemo(
    () => speechTextForMessage(status.enabled, markdown),
    [markdown, status.enabled],
  );
  const active = playback.messageId === messageId && (
    playback.status === "loading" || playback.status === "playing" || playback.status === "paused"
  );
  const speechError = playback.messageId === messageId && playback.status === "error" ? playback.error : undefined;
  const speechLabel = active
    ? playback.status === "loading" ? "Loading response audio (activate to stop)" : "Stop reading response"
    : "Read response aloud";

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (speechError) toast.error("Read aloud failed", { description: speechError });
  }, [speechError]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopyState("idle"), 1_500);
    } catch {
      setCopyState("error");
      toast.error("Could not copy response");
    }
  };

  return (
    <TooltipProvider delayDuration={350}>
      <div className="message-actions">
        {status.enabled && speakable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="message-action"
                aria-label={speechLabel}
                aria-describedby={disclosureId}
                aria-pressed={active}
                onClick={() => speak(messageId, speakable)}
              >
                <HugeiconsIcon icon={playback.messageId === messageId && playback.status === "loading" ? Loading03Icon : Speaker01Icon} strokeWidth={2} className={playback.messageId === messageId && playback.status === "loading" ? "spin" : undefined} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{speechLabel} · AI-generated voice</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="message-action"
              aria-label={copyState === "copied" ? "Response copied" : "Copy response"}
              onClick={() => void copy()}
            >
              <HugeiconsIcon icon={copyState === "copied" ? Tick02Icon : Copy01Icon} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copyState === "copied" ? "Copied" : "Copy response"}</TooltipContent>
        </Tooltip>
        <span id={disclosureId} className="sr-only">Read aloud uses an AI-generated voice.</span>
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied" ? "Response copied to clipboard" : copyState === "error" ? "Response could not be copied" : speechError ?? ""}
        </span>
      </div>
    </TooltipProvider>
  );
}
