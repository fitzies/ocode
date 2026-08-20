import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";

function RunningCount({ count }: { count: number }) {
  return (
    <span className="subagent-task-count" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <circle className="subagent-task-count-track" cx="12" cy="12" r="10" />
        <circle className="subagent-task-count-progress" cx="12" cy="12" r="10" pathLength="100" />
      </svg>
      <span>{count > 99 ? "99+" : count}</span>
    </span>
  );
}

export function SubagentTaskRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count < 1) return null;
  const label = `${count} ${count === 1 ? "agent" : "agents"} running`;

  return (
    <Button
      type="button"
      variant="ghost"
      className="composer-task-row"
      aria-label={`${label}. Open Agents.`}
      onClick={onOpen}
    >
      <RunningCount count={count} />
      <span className="composer-task-row-label">{label}</span>
      <span className="composer-task-row-action">View</span>
      <HugeiconsIcon className="composer-task-row-chevron" icon={ArrowRight01Icon} strokeWidth={2.2} aria-hidden="true" />
    </Button>
  );
}
