import { Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import type { SubagentActivity } from "@/lib/subagentActivity";

export function SubagentActivityTrigger({ activity }: { activity: SubagentActivity }) {
  const { state, openSubagents, setRightVisible } = useWorkspaceSurfaces();
  const open = state.rightVisible && state.activeRightSurface === "agents";
  const label = activity.items.length
    ? `${open ? "Close" : "Open"} agent activity: ${activity.active} active, ${activity.finished} finished`
    : "No agents used in this thread";

  return (
    <button
      type="button"
      className="composer-status-subagents"
      aria-label={label}
      aria-pressed={open}
      title={label}
      disabled={!activity.items.length}
      onClick={() => open ? setRightVisible(false) : openSubagents()}
    >
      {activity.active > 0 && (
        <>
          <span className="composer-status-metric" title="Active agents">
            <HugeiconsIcon
              icon={Loading03Icon}
              strokeWidth={2}
              className="composer-status-icon composer-status-icon--active composer-status-icon--spinning"
              aria-hidden="true"
            />
            {activity.active}<span className="sr-only"> active</span>
          </span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span className="composer-status-metric" title="Finished agents">
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="composer-status-icon composer-status-icon--finished" aria-hidden="true" />
        {activity.finished}<span className="sr-only"> finished</span>
      </span>
    </button>
  );
}
