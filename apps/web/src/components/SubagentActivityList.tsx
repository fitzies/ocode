import type { ConnectionState } from "@anvil/protocol";
import { AlertCircleIcon, Cancel01Icon, Clock03Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useLayoutEffect } from "react";

import { Button } from "@/components/ui/button";
import { PopoverTitle } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SubagentActivity } from "../lib/subagentActivity";
import {
  cleanSubagentSummary,
  formatSubagentAge,
  formatSubagentDuration,
  subagentRoleLabel,
  subagentStatusLabel,
} from "../lib/subagentPresentation";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

function ActivityNotice({ connection, loading }: { connection: ConnectionState; loading: boolean }) {
  if (connection !== "connected") {
    return (
      <div className="subagent-activity-notice" role="status">
        <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden="true" />
        {connection === "reconnecting" ? "Reconnecting · showing last known activity" : "Forge is offline · showing cached activity"}
      </div>
    );
  }
  if (!loading) return null;
  return <div className="subagent-activity-notice" role="status"><HugeiconsIcon icon={Loading03Icon} className="subagent-activity-icon-spin" />Loading activity…</div>;
}

export function SubagentActivityList({ activity, now, connection, loading, restoreFocusId, restoreScrollTop, scrollAreaRef, onSelect, onClose }: {
  activity: SubagentActivity;
  now: number;
  connection: ConnectionState;
  loading: boolean;
  restoreFocusId?: string;
  restoreScrollTop: number;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useLayoutEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (viewport) viewport.scrollTop = restoreScrollTop;
    if (!restoreFocusId) return;
    const rows = Array.from(scrollAreaRef.current?.querySelectorAll<HTMLButtonElement>("[data-subagent-id]") ?? []);
    (rows.find((candidate) => candidate.dataset.subagentId === restoreFocusId) ?? rows[0])?.focus();
  }, [restoreFocusId, restoreScrollTop, scrollAreaRef]);

  return (
    <>
      <header className="subagent-popover-header">
        <div>
          <PopoverTitle className="subagent-popover-title">Subagent activity</PopoverTitle>
          <span>{activity.items.length} {activity.items.length === 1 ? "run" : "runs"}</span>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close subagent activity">
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <ActivityNotice connection={connection} loading={loading} />
      <ScrollArea ref={scrollAreaRef} className="subagent-popover-scroll subagent-popover-list-scroll">
        {activity.items.length ? (
          <div className="subagent-activity-list">
            {activity.items.map((item) => {
              const duration = formatSubagentDuration(item, now);
              const preview = item.error ?? item.result;
              return (
                <button key={item.id} type="button" className="subagent-activity-row" data-subagent-id={item.id} onClick={() => onSelect(item.id)}>
                  <SubagentStatusIcon item={item} />
                  <span className="subagent-activity-copy">
                    <span className="subagent-activity-name">
                      <strong>{subagentRoleLabel(item.role)}</strong>
                      {item.source === "legacy" && <span className="subagent-legacy-label">Legacy tool</span>}
                    </span>
                    <span className="subagent-activity-task">{cleanSubagentSummary(item.task)}</span>
                    {preview && <span className={`subagent-activity-preview${item.error ? " subagent-activity-preview--error" : ""}`}>{cleanSubagentSummary(preview)}</span>}
                  </span>
                  <span className="subagent-activity-meta">
                    <span className={`subagent-status-label subagent-status-label--${item.status}`}>{subagentStatusLabel(item.status)}</span>
                    <span>{duration ?? formatSubagentAge(item.updatedAt, now)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="subagent-empty-state">
            <HugeiconsIcon icon={Clock03Icon} strokeWidth={2} aria-hidden="true" />
            <strong>{loading ? "Loading activity" : "No subagent runs"}</strong>
            <span>Async work launched from this thread will appear here.</span>
          </div>
        )}
      </ScrollArea>
    </>
  );
}
