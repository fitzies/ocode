import { sortSessionsByActivity } from "@anvil/state";
import {
  Archive01Icon,
  ArchiveRestoreIcon,
  ArrowDown01Icon,
  Delete02Icon,
  FileEditIcon,
  FolderAddIcon,
  FoldersIcon,
  Mail01Icon,
  MailOpen01Icon,
  MessageAdd01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProjectFavicon } from "@/components/ProjectFavicon";
import {
  Sidebar as SidebarPrimitive,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInput,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { AnvilClientSnapshot } from "../lib/anvilClient";
import { isTerminalInputTarget } from "../lib/keyboardScope";

export type SidebarSnapshot = Pick<
  AnvilClientSnapshot,
  "projects" | "sessions" | "activeSessionId" | "connection"
>;

interface SidebarProps {
  snapshot: SidebarSnapshot;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (projectId: string) => void;
  onNewProject: () => void;
  onRequestDeleteSession: (sessionId: string) => void;
  onRequestRenameSession: (sessionId: string) => void;
  onSetSessionSettled: (sessionId: string, settled: boolean) => Promise<void>;
  onMarkSessionRead: (sessionId: string) => void;
  onMarkSessionUnread: (sessionId: string) => void;
  usage?: {
    fiveHour?: { usedPercent: number; resetAt?: number };
    weekly?: { usedPercent: number; resetAt?: number };
  };
}

function RunningElapsed({ since }: { since: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const sinceMs = Date.parse(since);
  const seconds = Number.isFinite(sinceMs)
    ? Math.max(0, Math.floor((Date.now() - sinceMs) / 1_000))
    : 0;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return <span>{minutes > 0 ? `${minutes}m ${remainder}s` : `${seconds}s`}</span>;
}

function usageTone(window: { usedPercent: number; resetAt?: number } | undefined, hours: number) {
  if (!window) return "muted";
  if (!window.resetAt) return window.usedPercent >= 90 ? "danger" : window.usedPercent >= 80 ? "warning" : "success";
  const duration = hours * 60 * 60;
  const remaining = Math.max(0, window.resetAt - Date.now() / 1000);
  const expected = ((duration - Math.min(duration, remaining)) / duration) * 100;
  const grace = hours <= 5 ? 5 : 3;
  if (window.usedPercent <= expected + grace) return "success";
  if (window.usedPercent <= expected + grace + 10) return "warning";
  return "danger";
}

function capitalizeTitle(value: string) {
  if (!value) return value;
  return value[0]!.toLocaleUpperCase() + value.slice(1);
}

function formatUsageReset(resetAt: number | undefined) {
  if (!resetAt) return "Reset time unavailable";
  const remainingMinutes = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 60_000));
  if (remainingMinutes < 1) return "Resets shortly";
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `Resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `Resets in ${minutes}m`;
}

function formatUpdatedAt(value: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  if (elapsedMinutes < 24 * 60) return `${Math.floor(elapsedMinutes / 60)}h`;
  return `${Math.floor(elapsedMinutes / (24 * 60))}d`;
}

const usageIndicatorClass = {
  success: "[&_[data-slot=progress-indicator]]:bg-[var(--green)]",
  warning: "[&_[data-slot=progress-indicator]]:bg-amber-600 dark:[&_[data-slot=progress-indicator]]:bg-amber-400",
  danger: "[&_[data-slot=progress-indicator]]:bg-destructive",
  muted: "[&_[data-slot=progress-indicator]]:bg-muted-foreground/25",
} as const;

export const Sidebar = memo(function Sidebar({
  snapshot,
  onSelectSession,
  onCreateSession,
  onNewProject,
  onRequestDeleteSession,
  onRequestRenameSession,
  onSetSessionSettled,
  onMarkSessionRead,
  onMarkSessionUnread,
  usage,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState(true);
  const [settlementPending, setSettlementPending] = useState<Set<string>>(new Set());
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (isTerminalInputTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const sortedSessions = sortSessionsByActivity(snapshot.sessions);
  const selectedProject = snapshot.projects.find((project) => project.id === projectFilter);
  const visibleSessions = sortedSessions.filter((session) => !projectFilter || session.projectId === projectFilter);
  const unsettledSessions = visibleSessions.filter((session) => !session.settled);
  const settledSessions = visibleSessions.filter((session) => session.settled);

  const toggleSettled = async (sessionId: string, settled: boolean) => {
    setSettlementPending((current) => new Set(current).add(sessionId));
    try {
      await onSetSessionSettled(sessionId, settled);
    } catch {
      // The client exposes command failures through its existing global error state.
    } finally {
      setSettlementPending((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const renderSession = (session: (typeof snapshot.sessions)[number], settled: boolean) => {
    const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
    const unread = Boolean(session.lastTerminalSequence) &&
      session.lastTerminalSequence! > (session.readThroughSequence ?? 0);
    const completedUnviewed = session.lastTerminalOutcome === "completed" && unread;
    const active = session.id === snapshot.activeSessionId;
    const settling = settlementPending.has(session.id);
    const displayTitle = capitalizeTitle(session.title);
    const branch = session.branch ?? "unknown";

    return (
      <ContextMenu key={session.id}>
        <div className={`session-item ${settled ? "session-item--settled" : ""} ${session.status === "running" ? "session-item--running" : ""}`}>
          <ContextMenuTrigger asChild>
            <button
              className={`session-row ${active ? "session-row--active" : ""}`}
              data-session-id={session.id}
              onClick={() => {
                onSelectSession(session.id);
                closeMobile();
              }}
            >
              <span className="session-copy">
                <span className="session-project-line">
                  <span className="session-project">{project?.name.toLowerCase() ?? "unknown"}</span>
                  {session.status === "running" && <span className="session-spinner" role="status" aria-label="Working" />}
                  {session.status === "waiting" && <span className="session-runtime session-runtime--waiting">Needs you</span>}
                  {session.status === "failed" && <span className="session-runtime session-runtime--failed">Failed</span>}
                </span>
                <span className={`session-title ${unread ? "session-title--unread" : ""}`} title={displayTitle}>{displayTitle}</span>
                <span className="session-meta">
                  <span className="session-context-copy" title={`${project?.name.toLowerCase() ?? "unknown"}/${branch}`}>{project?.name.toLowerCase() ?? "unknown"}/{branch}</span>
                  <span className={`session-recency ${completedUnviewed ? "session-recency--completed" : ""}`}>
                    {session.status === "running"
                      ? session.lastUserMessageAt
                        ? <RunningElapsed since={session.lastUserMessageAt} />
                        : <span>Running</span>
                      : <span>{completedUnviewed ? "Completed" : formatUpdatedAt(session.updatedAt)}</span>}
                  </span>
                </span>
              </span>
            </button>
          </ContextMenuTrigger>
          {(settled || session.status !== "running") && (
            <button
              type="button"
              className="session-settle"
              aria-label={`${settled ? "Unsettle" : "Settle"} ${displayTitle}`}
              aria-busy={settling || undefined}
              disabled={settling}
              onClick={() => void toggleSettled(session.id, !settled)}
            >
              {settling ? "Saving" : settled ? "Unsettle" : "Settle"}
            </button>
          )}
        </div>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onSelect={() => onRequestRenameSession(session.id)}>
            <HugeiconsIcon icon={FileEditIcon} strokeWidth={2} />
            Rename thread
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => unread ? onMarkSessionRead(session.id) : onMarkSessionUnread(session.id)}>
            <HugeiconsIcon icon={unread ? MailOpen01Icon : Mail01Icon} strokeWidth={2} />
            {unread ? "Mark read" : "Mark unread"}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={settling}
            onSelect={() => void toggleSettled(session.id, !settled)}
          >
            <HugeiconsIcon icon={settled ? ArchiveRestoreIcon : Archive01Icon} strokeWidth={2} />
            {settled ? "Unsettle thread" : "Settle thread"}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => onRequestDeleteSession(session.id)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Delete thread
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <SidebarPrimitive variant="inset" collapsible="offcanvas" aria-label="Projects and sessions">
      <SidebarHeader className="gap-2 border-b border-sidebar-border p-2.5">
        <div className="flex min-h-8 items-center gap-1">
          <SidebarTrigger className="sidebar-close" aria-label="Close sidebar" />
          <span className="px-1 text-xs font-medium tracking-tight text-sidebar-foreground">Anvil</span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_1.75rem] grid-rows-2 gap-1.5">
          <div className="relative min-w-0">
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <SidebarInput
              className="h-7 cursor-pointer border-input bg-muted/20 pr-9 pl-8 text-[0.65625rem] font-normal shadow-none dark:bg-muted/30"
              readOnly
              value=""
              placeholder="Search threads"
              aria-label="Open thread search"
              aria-haspopup="dialog"
              onClick={() => setSearchOpen(true)}
              onFocus={() => setSearchOpen(true)}
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[0.5625rem] text-muted-foreground">⌘K</kbd>
          </div>
          {projectFilter ? (
            <Button
              variant="outline"
              size="icon"
              className="border-input bg-muted/20 dark:bg-muted/30"
              aria-label={`Create thread in ${snapshot.projects.find((project) => project.id === projectFilter)?.name ?? "selected project"}`}
              onClick={() => {
                onCreateSession(projectFilter);
                closeMobile();
              }}
            >
              <HugeiconsIcon icon={MessageAdd01Icon} strokeWidth={2} className="size-3.5" />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="border-input bg-muted/20 dark:bg-muted/30" aria-label="Create thread">
                  <HugeiconsIcon icon={MessageAdd01Icon} strokeWidth={2} className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>New thread in</DropdownMenuLabel>
                {snapshot.projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => {
                      onCreateSession(project.id);
                      closeMobile();
                    }}
                  >
                    {project.name.toLowerCase()}
                  </DropdownMenuItem>
                ))}
                {snapshot.projects.length === 0 && <DropdownMenuItem disabled>Create a project first</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Select
            value={projectFilter ?? "__all_projects__"}
            onValueChange={(value) => setProjectFilter(value === "__all_projects__" ? null : value)}
          >
            <SelectTrigger className="w-full min-w-0 border-input bg-muted/20 px-2.5 text-[0.6875rem] shadow-none data-[size=default]:h-7 dark:bg-muted/30" aria-label="Select project">
              <SelectValue>
                {selectedProject ? (
                  <>
                    <ProjectFavicon projectId={selectedProject.id} />
                    <span className="truncate">{selectedProject.name.toLowerCase()}</span>
                  </>
                ) : (
                  <>
                    <HugeiconsIcon icon={FoldersIcon} strokeWidth={2} className="size-3.5 text-muted-foreground" />
                    <span>All projects</span>
                  </>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectGroup>
                <SelectLabel>Projects</SelectLabel>
                <SelectItem value="__all_projects__">
                  <HugeiconsIcon icon={FoldersIcon} strokeWidth={2} className="size-3.5 text-muted-foreground" />
                  All projects
                </SelectItem>
                {snapshot.projects.length > 0 && <SelectSeparator />}
                {snapshot.projects.map((project) => (
                  <SelectItem value={project.id} key={project.id} title={project.path}>
                    <ProjectFavicon projectId={project.id} />
                    <span className="truncate">{project.name.toLowerCase()}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="border-input bg-muted/20 dark:bg-muted/30"
            onClick={() => {
              onNewProject();
              closeMobile();
            }}
            aria-label="New project"
            title="New project"
          >
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} className="size-3.5" />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent className="overflow-x-hidden px-2 py-2">
        {snapshot.projects.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">Create a Forge project to begin.</div>}
        {projectFilter && visibleSessions.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No matching threads</div>}

        <section className="thread-section" aria-label="Unsettled threads">
          <div className="session-list">{unsettledSessions.map((session) => renderSession(session, false))}</div>
          {unsettledSessions.length === 0 && visibleSessions.length > 0 && <div className="thread-empty">Everything here is settled.</div>}
          {unsettledSessions.length === 0 && visibleSessions.length === 0 && !projectFilter && <div className="thread-empty">Nothing needs your attention.</div>}
        </section>

        {settledSessions.length > 0 && (
          <Collapsible open={settledOpen} onOpenChange={setSettledOpen} className="thread-section thread-section--settled min-w-0 w-full">
            <CollapsibleTrigger asChild>
              <button className="thread-section-heading thread-section-toggle" id="settled-heading">
                <span className="flex items-center gap-1">
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className={`size-3 transition-transform ${settledOpen ? "" : "-rotate-90"}`} />
                  Settled
                </span>
                <span>{settledSessions.length}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="session-list session-list--settled">{settledSessions.map((session) => renderSession(session, true))}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </SidebarContent>

      <CommandDialog
        open={searchOpen}
        onOpenChange={(open) => {
          setSearchOpen(open);
          if (!open) setQuery("");
        }}
        title="Search threads"
        description="Search and open a thread"
        className="sm:max-w-lg"
      >
        <Command shouldFilter>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search threads…"
            aria-label="Search threads"
          />
          <CommandList>
            <CommandEmpty>No threads found.</CommandEmpty>
            <CommandGroup heading="Threads">
              {sortedSessions.map((session) => {
                const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
                const displayTitle = capitalizeTitle(session.title);
                const branch = session.branch ?? "unknown";
                return (
                  <CommandItem
                    key={session.id}
                    value={`${displayTitle} ${project?.name ?? "unknown"} ${branch}`}
                    onSelect={() => {
                      onSelectSession(session.id);
                      setSearchOpen(false);
                      setQuery("");
                      closeMobile();
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{displayTitle}</span>
                      <span className="block truncate text-[0.625rem] text-muted-foreground">
                        {project?.name.toLowerCase() ?? "unknown"}/{branch}
                      </span>
                    </span>
                    {session.settled && <span className="ml-auto text-[0.625rem] text-muted-foreground">Settled</span>}
                    {!session.settled && session.status === "running" && <span className="session-spinner ml-auto" role="status" aria-label="Working" />}
                    {!session.settled && session.status === "waiting" && <span className="ml-auto text-[0.625rem] text-amber-600 dark:text-amber-400">Needs you</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>

      <SidebarFooter className="border-t border-sidebar-border p-3 pb-5">
        {usage && (usage.fiveHour || usage.weekly) && (
          <div className="grid gap-3.5" aria-label="Codex usage limits">
            {([["5 hours", 5, usage.fiveHour], ["Weekly", 7 * 24, usage.weekly]] as const).map(([label, hours, window]) => {
              const tone = usageTone(window, hours);
              return (
                <div className="grid gap-1.5" key={label} title={window?.resetAt ? `Resets ${new Date(window.resetAt * 1000).toLocaleString()}` : undefined}>
                  <div className="flex items-center justify-between text-[0.6875rem] leading-none">
                    <span className="text-foreground/75">{label}</span>
                    <span className="tabular-nums text-muted-foreground">{window ? `${Math.round(window.usedPercent)}% used` : "Unavailable"}</span>
                  </div>
                  <Progress className={`h-1 w-full bg-foreground/8 ${usageIndicatorClass[tone]}`} value={window ? Math.max(0, Math.min(100, window.usedPercent)) : 0} />
                  <span className="font-mono text-[0.5625rem] leading-none text-muted-foreground/70">
                    {formatUsageReset(window?.resetAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </SidebarFooter>
    </SidebarPrimitive>
  );
});
