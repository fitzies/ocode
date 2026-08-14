import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type UsageLimitWindow = { usedPercent: number; resetAt?: number };

function formatUsageReset(resetAt: number | undefined) {
  if (!resetAt) return "Reset time unavailable";
  const remainingMinutes = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 60_000));
  if (remainingMinutes < 1) return "Resets shortly";
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `Resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `Resets in ${minutes}m`;
}

function usageAllowance(window: UsageLimitWindow, hours: number) {
  if (!window.resetAt) return 100;
  const duration = hours * 60 * 60;
  const remaining = Math.max(0, window.resetAt - Date.now() / 1000);
  return ((duration - Math.min(duration, remaining)) / duration) * 100;
}

function progressTone(window: UsageLimitWindow, hours: number) {
  if (!window.resetAt) {
    if (window.usedPercent >= 90) return "text-destructive";
    if (window.usedPercent >= 80) return "text-amber-600 dark:text-amber-400";
    return "text-[var(--green)]";
  }
  const expected = usageAllowance(window, hours);
  if (window.usedPercent > expected) return "text-destructive";
  if (expected - window.usedPercent <= (hours <= 5 ? 5 : 3)) {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-[var(--green)]";
}

function LimitProgress({ label, hours, window, tooltipSide }: { label: string; hours: number; window: UsageLimitWindow; tooltipSide: "top" | "right" | "bottom" | "left" }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const rounded = Math.round(used);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex size-8 items-center justify-center rounded-lg outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/30"
          role="progressbar"
          aria-label={`${label} usage: ${rounded}% used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rounded}
          tabIndex={0}
        >
          <svg className="size-6 -rotate-90" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="fill-none stroke-muted" cx="12" cy="12" r={radius} strokeWidth="2.5" />
            <circle
              className={cn("fill-none stroke-current transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none", progressTone(window, hours))}
              cx="12"
              cy="12"
              r={radius}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - used / 100)}
            />
          </svg>
        </div>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>
        <span className="font-medium">{label}</span>
        <span>{rounded}% used</span>
        <span className="opacity-65">· {formatUsageReset(window.resetAt)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function UsageLimitProgress({ usage, className, tooltipSide = "bottom" }: {
  usage?: { fiveHour?: UsageLimitWindow; weekly?: UsageLimitWindow };
  className?: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}) {
  if (!usage?.fiveHour && !usage?.weekly) return <></>;

  return (
    <div className={cn("flex items-center gap-0.5", className)} aria-label="Codex usage limits">
      {usage.fiveHour ? <LimitProgress label="5 hours" hours={5} window={usage.fiveHour} tooltipSide={tooltipSide} /> : <></>}
      {usage.weekly && <LimitProgress label="Weekly" hours={7 * 24} window={usage.weekly} tooltipSide={tooltipSide} />}
    </div>
  );
}
