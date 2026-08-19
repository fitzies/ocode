import { AlertCircleIcon, CheckmarkCircle02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { AgentLoadingState } from "@/components/AgentLoadingState";
import { Card, CardContent } from "@/components/ui/card";

export type CompactionStatus = "running" | "completed" | "cancelled" | "failed";

function formatTokens(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value).toLocaleString();
}

export function CompactionCard({
  status,
  tokensBefore,
  tokensAfter,
  details,
  entering = false,
}: {
  status: CompactionStatus;
  tokensBefore?: number;
  tokensAfter?: number;
  details?: ReactNode;
  entering?: boolean;
}) {
  const before = formatTokens(tokensBefore);
  const after = formatTokens(tokensAfter);
  const title = status === "running"
    ? "Compacting context"
    : status === "completed"
      ? "Context compacted"
      : status === "cancelled"
        ? "Context compaction cancelled"
        : "Context compaction failed";

  return (
    <Card size="sm" className={`compaction-card compaction-card--${status} gap-0 py-0${entering ? " timeline-entry--entering" : ""}`} data-presentation="compaction-card">
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
        <span className="compaction-card-icon">
          {status === "running"
            ? <AgentLoadingState label="Compacting context" />
            : <HugeiconsIcon
                icon={status === "completed" ? CheckmarkCircle02Icon : status === "cancelled" ? Clock01Icon : AlertCircleIcon}
                strokeWidth={2}
                className="size-4"
                aria-hidden="true"
              />}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <strong className="text-xs font-medium">{title}</strong>
          {before && after && <span className="text-[0.6875rem] text-muted-foreground tabular-nums">{before} → {after} tokens</span>}
        </span>
        {details}
      </CardContent>
    </Card>
  );
}
