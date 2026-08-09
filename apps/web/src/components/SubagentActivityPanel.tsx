import type { ConnectionState, SessionSummary, TimelineEntry } from "@anvil/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  canCancelSubagentStatus,
  type SubagentActivity,
  type SubagentActivityItem,
} from "../lib/subagentActivity";
import { SubagentActivityDetail } from "./SubagentActivityDetail";
import { SubagentActivityList } from "./SubagentActivityList";
import { SubagentChatView } from "./SubagentChatView";

function useActivityClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [live]);
  return now;
}

export interface SubagentActivityPanelProps {
  activity: SubagentActivity;
  embedded?: boolean;
  connection: ConnectionState;
  loading?: boolean;
  childSessions: SessionSummary[];
  childTimelines: Record<string, TimelineEntry[]>;
  hydratingChildSessionIds: string[];
  onCancel: (runId: string) => Promise<void>;
  onClose: () => void;
  onLoadChild: (item: SubagentActivityItem) => Promise<string>;
}

export function SubagentActivityPanel({
  activity,
  embedded = false,
  connection,
  loading = false,
  childSessions,
  childTimelines,
  hydratingChildSessionIds,
  onCancel,
  onClose,
  onLoadChild,
}: SubagentActivityPanelProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [cancellingId, setCancellingId] = useState<string>();
  const [loadingChildId, setLoadingChildId] = useState<string>();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const copiedTimer = useRef<number | undefined>(undefined);
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const listScrollAreaRef = useRef<HTMLDivElement | null>(null);
  const listScrollTop = useRef(0);
  const returnFocusId = useRef<string | undefined>(undefined);
  const selected = useMemo(() => activity.items.find((item) => item.id === selectedId), [activity.items, selectedId]);
  const selectedSession = selected?.childSessionId
    ? childSessions.find((session) => session.id === selected.childSessionId)
    : undefined;
  const selectedTimeline = selected?.childSessionId ? childTimelines[selected.childSessionId] ?? [] : [];
  const now = useActivityClock(activity.active > 0 || activity.needsAttention > 0);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(undefined);
    if (cancellingId && selected && !canCancelSubagentStatus(selected.status)) {
      setCancellingId(undefined);
      detailBackRef.current?.focus();
    }
  }, [cancellingId, selected, selectedId]);
  useLayoutEffect(() => { if (selectedId) detailBackRef.current?.focus(); }, [selectedId]);
  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  const copyResponse = async () => {
    const response = selected?.error ?? selected?.result;
    if (!response) return;
    try {
      await navigator.clipboard.writeText(response);
      setCopied(true);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const cancelSelected = async () => {
    if (!selected || selected.source !== "durable" || !canCancelSubagentStatus(selected.status)) return;
    setCancellingId(selected.id);
    setActionErrors((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    try {
      await onCancel(selected.id);
    } catch (error) {
      setCancellingId(undefined);
      setActionErrors((current) => ({ ...current, [selected.id]: `Cancel failed · ${error instanceof Error ? error.message : String(error)}` }));
    }
  };

  const selectActivity = async (item: SubagentActivityItem) => {
    const viewport = listScrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
    listScrollTop.current = viewport?.scrollTop ?? 0;
    returnFocusId.current = item.id;
    setSelectedId(item.id);
    if (!item.childSessionId) return;
    setLoadingChildId(item.id);
    setLoadErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    try {
      await onLoadChild(item);
    } catch (error) {
      setLoadErrors((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoadingChildId((current) => current === item.id ? undefined : current);
    }
  };

  return (
    <div className="subagent-panel">
      {selected?.childSessionId ? (
        <SubagentChatView
          item={selected}
          session={selectedSession}
          entries={selectedTimeline}
          now={now}
          loading={loadingChildId === selected.id || hydratingChildSessionIds.includes(selected.childSessionId)}
          loadError={loadErrors[selected.id]}
          cancelling={cancellingId === selected.id}
          actionError={actionErrors[selected.id]}
          onBack={() => setSelectedId(undefined)}
          onCancel={() => { void cancelSelected(); }}
        />
      ) : selected ? (
        <SubagentActivityDetail
          item={selected}
          now={now}
          copied={copied}
          cancelling={cancellingId === selected.id}
          actionError={actionErrors[selected.id]}
          backButtonRef={detailBackRef}
          onBack={() => { setSelectedId(undefined); setCopied(false); }}
          onClose={onClose}
          onCopy={() => { void copyResponse(); }}
          onCancel={() => { void cancelSelected(); }}
          embedded={embedded}
        />
      ) : (
        <SubagentActivityList
          activity={activity}
          now={now}
          connection={connection}
          loading={loading}
          restoreFocusId={returnFocusId.current}
          restoreScrollTop={listScrollTop.current}
          scrollAreaRef={listScrollAreaRef}
          onSelect={(id) => {
            const item = activity.items.find((candidate) => candidate.id === id);
            if (item) void selectActivity(item);
          }}
          onClose={onClose}
          embedded={embedded}
        />
      )}
    </div>
  );
}
