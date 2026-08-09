import { AlertCircleIcon, Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import type { SubagentActivity } from "../lib/subagentActivity";

export { formatSubagentDuration, subagentStatusLabel } from "../lib/subagentPresentation";

export interface SubagentActivityPopoverProps {
  activity: SubagentActivity;
  loading?: boolean;
  onOpen: () => void;
}

export function SubagentActivityPopover({ activity, loading = false, onOpen }: SubagentActivityPopoverProps) {
  const label = `Open Agents: ${activity.active} active, ${activity.finished} finished, ${activity.failed} failed, ${activity.needsAttention} need attention`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="composer-status-subagents"
      aria-label={label}
      title={label}
      aria-busy={loading}
      onClick={onOpen}
    >
      <span className="composer-status-subagent-label">Agents</span>
      {activity.active > 0 && <StatusMetric icon={Loading03Icon} count={activity.active} label="active" tone="active" spinning />}
      <StatusMetric icon={Tick02Icon} count={activity.finished} label="finished" tone="finished" />
      {activity.failed > 0 && <StatusMetric icon={AlertCircleIcon} count={activity.failed} label="failed" tone="failed" />}
      {activity.needsAttention > 0 && <StatusMetric icon={AlertCircleIcon} count={activity.needsAttention} label="need attention" tone="attention" />}
    </Button>
  );
}

function StatusMetric({ icon, count, label, tone, spinning = false }: {
  icon: typeof Loading03Icon;
  count: number;
  label: string;
  tone: "active" | "finished" | "failed" | "attention";
  spinning?: boolean;
}) {
  return (
    <span className="composer-status-metric">
      <HugeiconsIcon icon={icon} strokeWidth={2} className={`composer-status-icon composer-status-icon--${tone}${spinning ? " composer-status-icon--spinning" : ""}`} aria-hidden="true" />
      {count}<span className="sr-only"> {label}</span>
    </span>
  );
}
