import {
  AlertCircleIcon,
  BanIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  HourglassIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Badge } from "@/components/ui/badge";
import type { SubagentActivityItem } from "../lib/subagentActivity";
import { subagentStatusLabel } from "../lib/subagentPresentation";

function iconForStatus(item: SubagentActivityItem) {
  switch (item.status) {
    case "queued": return HourglassIcon;
    case "starting": return Loading03Icon;
    case "running": return CircleDotIcon;
    case "needs_attention": return AlertCircleIcon;
    case "completed": return CircleCheckIcon;
    case "cancelled": return BanIcon;
    case "failed":
    case "interrupted": return CircleXIcon;
  }
}

export function SubagentStatusIcon({ item }: { item: SubagentActivityItem }) {
  return (
    <span className={`subagent-activity-icon subagent-activity-icon--${item.status}`} aria-hidden="true">
      {item.status === "running" && <i className="subagent-activity-icon-pulse" />}
      <HugeiconsIcon
        icon={iconForStatus(item)}
        strokeWidth={2}
        className={item.status === "starting" ? "subagent-activity-icon-spin" : undefined}
      />
    </span>
  );
}

export function SubagentStatusBadge({ item }: { item: SubagentActivityItem }) {
  return (
    <Badge variant="secondary" className={`subagent-status-badge subagent-status-badge--${item.status}`}>
      <SubagentStatusIcon item={item} />
      {subagentStatusLabel(item.status)}
    </Badge>
  );
}
