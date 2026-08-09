import { AlertCircleIcon, Cancel01Icon, Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { isActiveSubagentStatus, type SubagentActivityItem } from "../lib/subagentActivity";

function iconForStatus(item: SubagentActivityItem) {
  if (isActiveSubagentStatus(item.status)) return Loading03Icon;
  if (item.status === "completed") return Tick02Icon;
  if (item.status === "cancelled") return Cancel01Icon;
  return AlertCircleIcon;
}

export function SubagentStatusIcon({ item }: { item: SubagentActivityItem }) {
  const live = isActiveSubagentStatus(item.status);
  return (
    <span className={`subagent-activity-icon subagent-activity-icon--${item.status}`} aria-hidden="true">
      <HugeiconsIcon icon={iconForStatus(item)} strokeWidth={2} className={live ? "subagent-activity-icon-spin" : undefined} />
    </span>
  );
}
