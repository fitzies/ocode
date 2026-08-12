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
      <span className="composer-status-subagent-label">agents</span>
    </Button>
  );
}
