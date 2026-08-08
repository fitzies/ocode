import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export function MessageActions({ markdown }: { markdown: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);

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
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied" ? "Response copied to clipboard" : copyState === "error" ? "Response could not be copied" : ""}
        </span>
      </div>
    </TooltipProvider>
  );
}
