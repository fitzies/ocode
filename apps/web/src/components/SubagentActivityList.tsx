import type { ConnectionState } from "@anvil/protocol";
import { AlertCircleIcon, Cancel01Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useLayoutEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
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

  return (
    <>
      {!embedded && (
        <header className="subagent-popover-header">
          <div>
            <h2 className="subagent-popover-title">Agents</h2>
            <span>{activity.items.length} {activity.items.length === 1 ? "run" : "runs"}</span>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Agents">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </header>
      )}
      {activity.items.length > 0 && <ActivityNotice connection={connection} loading={loading} />}
      <ScrollArea ref={scrollAreaRef} className="subagent-popover-scroll subagent-popover-list-scroll">
        {activity.items.length ? (
          <ItemGroup className="subagent-activity-list gap-0">
            {activity.items.map((item) => {
              const duration = formatSubagentDuration(item, now);
              return (
                <Item key={item.id} asChild size="xs">
                  <a className="subagent-activity-row" data-subagent-id={item.id} href={`#agent-${item.id}`} onClick={(event) => { event.preventDefault(); onSelect(item.id); }}>
                    <ItemMedia><SubagentStatusIcon item={item} /></ItemMedia>
                    <ItemContent className="subagent-activity-copy">
                      <ItemTitle className="subagent-activity-name">
                        <strong>{subagentRoleLabel(item.role)}</strong>
                        {item.source === "legacy" && <span className="subagent-legacy-label">Legacy tool</span>}
                      </ItemTitle>
                      <ItemDescription className="subagent-activity-task">{cleanSubagentSummary(item.task)}</ItemDescription>
                    </ItemContent>
                    <ItemActions className="subagent-activity-meta">
                      <Badge variant="secondary" className={`subagent-status-badge subagent-status-badge--${item.status}`}>{subagentStatusLabel(item.status)}</Badge>
                      <span>{duration ?? formatSubagentAge(item.updatedAt, now)}</span>
                    </ItemActions>
                  </a>
                </Item>
              );
            })}
          </ItemGroup>
        ) : (
          <Empty className="h-full min-h-32 rounded-none p-6">
            <EmptyTitle>No Agents</EmptyTitle>
          </Empty>
        )}
      </ScrollArea>
    </>
  );
}
