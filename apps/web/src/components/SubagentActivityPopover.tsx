import type { ConnectionState } from "@anvil/protocol";
import { AlertCircleIcon, Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  canCancelSubagentStatus,
  type SubagentActivity,
  type SubagentActivityItem,
} from "../lib/subagentActivity";
import { SubagentActivityDetail } from "./SubagentActivityDetail";
import { SubagentActivityList } from "./SubagentActivityList";

export { formatSubagentDuration, subagentStatusLabel } from "../lib/subagentPresentation";

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

export interface SubagentActivityPopoverProps {
  activity: SubagentActivity;
  connection: ConnectionState;
  loading?: boolean;
  onCancel: (runId: string) => Promise<void>;
  onOpenChild: (item: SubagentActivityItem) => Promise<void>;
}

export function SubagentActivityPopover({ activity, connection, loading = false, onCancel, onOpenChild }: SubagentActivityPopoverProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [cancellingId, setCancellingId] = useState<string>();
  const [openingChildId, setOpeningChildId] = useState<string>();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const copiedTimer = useRef<number | undefined>(undefined);
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const listScrollAreaRef = useRef<HTMLDivElement | null>(null);
  const listScrollTop = useRef(0);
  const returnFocusId = useRef<string | undefined>(undefined);
  const selected = useMemo(() => activity.items.find((item) => item.id === selectedId), [activity.items, selectedId]);
  const now = useActivityClock(open && (activity.active > 0 || activity.needsAttention > 0));

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(undefined);
    if (cancellingId && selected && !canCancelSubagentStatus(selected.status)) {
      setCancellingId(undefined);
      detailBackRef.current?.focus();
    }
  }, [cancellingId, selected, selectedId]);
  useLayoutEffect(() => { if (selectedId) detailBackRef.current?.focus(); }, [selectedId]);
  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSelectedId(undefined);
      setCopied(false);
      setOpeningChildId(undefined);
      returnFocusId.current = undefined;
      listScrollTop.current = 0;
    }
  };

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

  const openSelectedChild = async () => {
    if (!selected?.childSessionId) return;
    setOpeningChildId(selected.id);
    try {
      await onOpenChild(selected);
      changeOpen(false);
    } catch (error) {
      setOpeningChildId(undefined);
      setActionErrors((current) => ({ ...current, [selected.id]: `Could not open child session · ${error instanceof Error ? error.message : String(error)}` }));
    }
  };

  const label = `Open subagent activity: ${activity.active} active, ${activity.finished} finished, ${activity.failed} failed, ${activity.needsAttention} need attention`;

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="composer-status-subagents" aria-label={label} title={label} aria-busy={loading}>
          {activity.active > 0 && <StatusMetric icon={Loading03Icon} count={activity.active} label="active" tone="active" spinning />}
          <StatusMetric icon={Tick02Icon} count={activity.finished} label="finished" tone="finished" />
          {activity.failed > 0 && <StatusMetric icon={AlertCircleIcon} count={activity.failed} label="failed" tone="failed" />}
          {activity.needsAttention > 0 && <StatusMetric icon={AlertCircleIcon} count={activity.needsAttention} label="need attention" tone="attention" />}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="subagent-popover" aria-label="Subagent activity">
        {selected ? (
          <SubagentActivityDetail
            item={selected}
            now={now}
            copied={copied}
            cancelling={cancellingId === selected.id}
            actionError={actionErrors[selected.id]}
            openingChild={openingChildId === selected.id}
            backButtonRef={detailBackRef}
            onBack={() => { setSelectedId(undefined); setCopied(false); }}
            onClose={() => changeOpen(false)}
            onCopy={() => { void copyResponse(); }}
            onCancel={() => { void cancelSelected(); }}
            onOpenChild={() => { void openSelectedChild(); }}
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
              const viewport = listScrollAreaRef.current?.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
              listScrollTop.current = viewport?.scrollTop ?? 0;
              returnFocusId.current = id;
              setSelectedId(id);
            }}
            onClose={() => changeOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
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
