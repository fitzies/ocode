import { cn } from "@/lib/utils";

/**
 * Adapted from Beautiful UI's MIT-licensed Loading State primitive.
 * The product variant intentionally has no visible novelty copy.
 * https://www.beautifului.dev/#loading-state
 */
export function AgentLoadingState({
  label,
  text,
  className,
}: {
  label: string;
  text?: string;
  className?: string;
}) {
  return (
    <span className={cn("agent-loading-state", className)} role="status" aria-label={label}>
      <span className="agent-loading-pixels" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </span>
      {text && <span className="agent-loading-copy" aria-hidden="true">{text}</span>}
    </span>
  );
}
