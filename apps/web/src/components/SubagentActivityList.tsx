import type { ConnectionState } from "@anvil/protocol";
import { Cancel01Icon, WifiOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useLayoutEffect } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { isActiveSubagentStatus, type SubagentActivity, type SubagentActivityItem } from "../lib/subagentActivity";
import {
  cleanSubagentSummary,
  formatSubagentAge,
  formatSubagentDuration,
  subagentRoleLabel,
  subagentStatusLabel,
} from "../lib/subagentPresentation";

function ActivityNotice({ connection, loading }: { connection: ConnectionState; loading: boolean }) {
  if (connection !== "connected") {
    return (
      <Alert className={`subagent-activity-notice subagent-activity-notice--${connection}`} role="status">
        {connection === "reconnecting"
          ? <Spinner aria-hidden="true" />
          : <HugeiconsIcon icon={WifiOffIcon} strokeWidth={2} aria-hidden="true" />}
        <AlertDescription>
          {connection === "reconnecting"
            ? "Reconnecting to the session — showing last-known activity."
            : "Forge is offline — showing cached activity."}
        </AlertDescription>
      </Alert>
    );
  }
  if (!loading) return null;
  return (
    <Alert className="subagent-activity-notice" role="status">
      <Spinner aria-hidden="true" />
      <AlertDescription>Loading activity…</AlertDescription>
    </Alert>
  );
}

function isLiveItem(item: SubagentActivityItem): boolean {
  return isActiveSubagentStatus(item.status) || item.status === "needs_attention";
}

function ActivityRows({ items, now, onSelect }: {
  items: SubagentActivityItem[];
  now: number;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="subagent-activity-rows">
      {items.map((item) => {
        const duration = formatSubagentDuration(item, now);
        return (
          <li key={item.id}>
            <button
              type="button"
              className="subagent-activity-row"
              data-subagent-id={item.id}
              onClick={() => onSelect(item.id)}
            >
              <span className="subagent-activity-copy">
                <span className="subagent-activity-identity">
                  <strong className="subagent-activity-name">{subagentRoleLabel(item.role)}</strong>
                  <span className={`subagent-activity-status subagent-activity-status--${item.status}`}>{subagentStatusLabel(item.status)}</span>
                </span>
                <span className="subagent-activity-task">{cleanSubagentSummary(item.task)}</span>
              </span>
              <time className="subagent-activity-time">{duration ?? formatSubagentAge(item.updatedAt, now)}</time>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ActivityListSkeleton() {
  return (
    <div className="subagent-list-skeleton" aria-busy="true" aria-label="Loading agent activity">
      {[0, 1, 2, 3].map((index) => (
        <div className="subagent-list-skeleton-row" key={index}>
          <span><Skeleton className="h-2.5 w-20" /><Skeleton className="h-2 w-full" /></span>
        </div>
      ))}
    </div>
  );
}

export function SubagentActivityList({ activity, now, connection, loading, restoreFocusId, restoreScrollTop, scrollAreaRef, onSelect, onClose, embedded = false }: {
  activity: SubagentActivity;
  now: number;
  connection: ConnectionState;
  loading: boolean;
  restoreFocusId?: string;
  restoreScrollTop: number;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  useLayoutEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (viewport) viewport.scrollTop = restoreScrollTop;
    if (!restoreFocusId) return;
    const rows = Array.from(scrollAreaRef.current?.querySelectorAll<HTMLElement>("[data-subagent-id]") ?? []);
    (rows.find((candidate) => candidate.dataset.subagentId === restoreFocusId) ?? rows[0])?.focus();
  }, [restoreFocusId, restoreScrollTop, scrollAreaRef]);

  const activeItems = activity.items.filter(isLiveItem);
  const recentItems = activity.items.filter((item) => !isLiveItem(item));
  const activeCount = activity.active + activity.needsAttention;

  return (
    <>
      {!embedded && (
        <header className="subagent-popover-header">
          <h2 className="subagent-popover-title">Agents</h2>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Agents">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </header>
      )}
      <div className="subagent-list-overview" aria-label={`${activeCount} active, ${activity.items.length} total`}>
        <div>
          <strong>{activeCount} active</strong>
          <span aria-hidden="true">·</span>
          <span>{activity.items.length} total</span>
        </div>
      </div>
      {(activity.items.length > 0 || loading) && <ActivityNotice connection={connection} loading={loading} />}
      <ScrollArea ref={scrollAreaRef} className="subagent-popover-scroll subagent-popover-list-scroll">
        {loading && activity.items.length === 0 ? (
          <ActivityListSkeleton />
        ) : activity.items.length ? (
          <div className="subagent-activity-list">
            <section aria-labelledby="subagent-active-heading">
              <div className="subagent-list-section-heading">
                <h3 id="subagent-active-heading" className="subagent-list-section-title">Active</h3>
                <span>{activeItems.length}</span>
              </div>
              {activeItems.length
                ? <ActivityRows items={activeItems} now={now} onSelect={onSelect} />
                : <p className="subagent-list-section-empty">No agents are currently running.</p>}
            </section>
            {recentItems.length > 0 && (
              <section aria-labelledby="subagent-recent-heading">
                <div className="subagent-list-section-heading">
                  <h3 id="subagent-recent-heading" className="subagent-list-section-title">Recent</h3>
                  <span>{recentItems.length}</span>
                </div>
                <ActivityRows items={recentItems} now={now} onSelect={onSelect} />
              </section>
            )}
          </div>
        ) : (
          <Empty className="h-full min-h-40 rounded-none p-6">
            <EmptyTitle>No Agents</EmptyTitle>
          </Empty>
        )}
      </ScrollArea>
    </>
  );
}
