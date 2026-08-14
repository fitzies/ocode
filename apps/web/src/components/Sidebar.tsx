import { isGeneralProject, type ThreadSearchMatch } from "@anvil/protocol";
import { sortSessionsByActivity } from "@anvil/state";
import {
  Archive01Icon,
  ArchiveRestoreIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  FileEditIcon,
  FolderAddIcon,
  FoldersIcon,
  Mail01Icon,
  MailOpen01Icon,
  MessageAdd01Icon,
  Search01Icon,
  DatabaseSettingIcon,
  Settings01Icon,
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
  CommandSeparator,
  CommandShortcut,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UsageLimitProgress } from "./UsageLimitProgress";

function projectDisplayName(project: { name: string }): string {
  return project.name;
}
import {
  Sidebar as SidebarPrimitive,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { AnvilClientSnapshot } from "../lib/anvilClient";
import { isTerminalInputTarget } from "../lib/keyboardScope";
import { matchesShortcut } from "../lib/shortcuts";

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
  onSearchThreads: (query: string) => Promise<ThreadSearchMatch[]>;
  activePage: "workspace" | "settings" | "usage";
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onBack: () => void;
  projectChooserMode: "new" | "change" | null;
  onProjectChooserModeChange: (mode: "new" | "change" | null) => void;
  onChangeProject: (projectId: string) => void;
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

function capitalizeTitle(value: string) {
  if (!value) return value;
  return value[0]!.toLocaleUpperCase() + value.slice(1);
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const index = text.toLocaleLowerCase().indexOf(normalizedQuery);
  if (!normalizedQuery || index < 0) return text;
  return <>{text.slice(0, index)}<mark className="bg-transparent font-semibold text-foreground">{text.slice(index, index + normalizedQuery.length)}</mark>{text.slice(index + normalizedQuery.length)}</>;
}

function formatUpdatedAt(value: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  if (elapsedMinutes < 24 * 60) return `${Math.floor(elapsedMinutes / 60)}h`;
  return `${Math.floor(elapsedMinutes / (24 * 60))}d`;
}

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
  onSearchThreads,
  activePage,
  onOpenSettings,
  onOpenUsage,
  onBack,
  projectChooserMode,
  onProjectChooserModeChange,
  onChangeProject,
  usage,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState(true);
  const [settlementPending, setSettlementPending] = useState<Set<string>>(new Set());
  const [contentMatches, setContentMatches] = useState<ThreadSearchMatch[]>([]);
  const [contentSearchPending, setContentSearchPending] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (isTerminalInputTarget(event.target)) return;
      if (matchesShortcut(event, "search")) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!searchOpen || normalizedQuery.length < 2) {
      setContentMatches([]);
      setContentSearchPending(false);
      return;
    }
    let current = true;
    setContentSearchPending(true);
    const timer = window.setTimeout(() => {
      void onSearchThreads(normalizedQuery).then((matches) => {
        if (current) setContentMatches(matches);
      }).finally(() => {
        if (current) setContentSearchPending(false);
      });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [onSearchThreads, query, searchOpen]);

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const chooseProject = (projectId: string) => {
    if (projectChooserMode === "change") void onChangeProject(projectId);
    else onCreateSession(projectId);
    onProjectChooserModeChange(null);
    setProjectQuery("");
    closeMobile();
  };

  const sortedSessions = sortSessionsByActivity(snapshot.sessions.filter((session) => !session.internal));
  const generalProject = snapshot.projects.find(isGeneralProject);
  const regularProjects = snapshot.projects.filter((project) => !isGeneralProject(project));
  const selectedProject = snapshot.projects.find((project) => project.id === projectFilter);
  const visibleSessions = sortedSessions.filter((session) => !projectFilter || session.projectId === projectFilter);
  const unsettledSessions = visibleSessions.filter((session) => !session.settled);
  const settledSessions = visibleSessions.filter((session) => session.settled);
  const contentMatchBySession = new Map(contentMatches.map((match) => [match.sessionId, match]));

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
    const active = activePage === "workspace" && session.id === snapshot.activeSessionId;
    const settling = settlementPending.has(session.id);
    const displayTitle = capitalizeTitle(session.title);
    const projectName = project ? projectDisplayName(project) : "unknown";
    const branch = session.branch ?? "unknown";
    const projectContext = isGeneralProject(project) ? "General · ~/" : `${projectName}/${branch}`;

    return (
      <ContextMenu key={session.id}>
        <div className={`session-item ${settled ? "session-item--settled" : ""} ${session.status === "running" ? "session-item--running" : ""}`}>
          <ContextMenuTrigger asChild>
            <button
              className={`session-row ${active ? "session-row--active" : ""}`}
              data-session-id={session.id}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                onSelectSession(session.id);
                closeMobile();
              }}
            >
              {project && <ProjectFavicon projectId={project.id} projectName={project.name} workspaceKind={project.workspaceKind} className="session-settled-project-icon" />}
              <span className="session-copy">
                <span className="session-project-line">
                  <span className="session-project-identity">
                    {project && <ProjectFavicon projectId={project.id} projectName={project.name} workspaceKind={project.workspaceKind} />}
                    <span className="session-project">{projectName}</span>
                  </span>
                  {session.status === "running" && <span className="session-spinner" role="status" aria-label="Working" />}
                  {session.status === "waiting" && <span className="session-runtime session-runtime--waiting">Needs you</span>}
                  {session.status === "failed" && <span className="session-runtime session-runtime--failed">Failed</span>}
                </span>
                <span className={`session-title ${unread ? "session-title--unread" : ""}`} title={displayTitle}>{displayTitle}</span>
                <span className="session-meta">
                  <span className="session-context-copy" title={projectContext}>{projectContext}</span>
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
    <SidebarPrimitive variant="sidebar" collapsible="offcanvas" aria-label="Projects and sessions">
      <SidebarHeader className="gap-2 border-b border-sidebar-border p-2.5">
        <div className="flex min-h-8 items-center md:hidden">
          <SidebarTrigger className="sidebar-close" aria-label="Close sidebar" />
        </div>
        <div className="sidebar-controls grid grid-cols-[minmax(0,1fr)_1.75rem] grid-rows-2 gap-1.5">
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
            <Button
              variant="outline"
              size="icon"
              className="border-input bg-muted/20 dark:bg-muted/30"
              aria-label="Create thread"
              onClick={() => onProjectChooserModeChange("new")}
            >
              <HugeiconsIcon icon={MessageAdd01Icon} strokeWidth={2} className="size-3.5" />
            </Button>
          )}
          <Select
            value={projectFilter ?? "__all_projects__"}
            onValueChange={(value) => setProjectFilter(value === "__all_projects__" ? null : value)}
          >
            <SelectTrigger className="w-full min-w-0 border-input bg-muted/20 px-2.5 text-[0.6875rem] shadow-none data-[size=default]:h-7 dark:bg-muted/30 [&>svg:last-child]:hidden" aria-label="Select project">
              <SelectValue>
                {selectedProject ? (
                  <>
                    <ProjectFavicon projectId={selectedProject.id} projectName={selectedProject.name} workspaceKind={selectedProject.workspaceKind} />
                    <span className="truncate">{projectDisplayName(selectedProject)}</span>
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
                {regularProjects.length > 0 && <SelectSeparator />}
                {regularProjects.map((project) => (
                  <SelectItem value={project.id} key={project.id} title={project.path}>
                    <ProjectFavicon projectId={project.id} projectName={project.name} workspaceKind={project.workspaceKind} />
                    <span className="truncate">{projectDisplayName(project)}</span>
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
        open={projectChooserMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            onProjectChooserModeChange(null);
            setProjectQuery("");
          }
        }}
        title={projectChooserMode === "change" ? "Change project" : "New thread"}
        description={projectChooserMode === "change" ? "Choose a project for this new thread" : "Choose where the new thread should run"}
        className="sm:max-w-sm"
      >
        <Command shouldFilter>
          <CommandInput
            autoFocus
            value={projectQuery}
            onValueChange={setProjectQuery}
            placeholder="Choose a workspace…"
            aria-label="Choose a workspace"
          />
          <CommandList>
            <CommandEmpty>{snapshot.projects.length === 0 ? "Create a project first." : "No projects found."}</CommandEmpty>
            {generalProject && projectQuery.length === 0 && (
              <CommandGroup heading="No project">
                <CommandItem
                  value={`No project home ${generalProject.path} ~/ questions`}
                  onSelect={() => chooseProject(generalProject.id)}
                >
                  <ProjectFavicon projectId={generalProject.id} projectName={generalProject.name} workspaceKind={generalProject.workspaceKind} />
                  <span className="font-medium">No project</span>
                </CommandItem>
              </CommandGroup>
            )}
            {generalProject && projectQuery.length === 0 && regularProjects.length > 0 && <CommandSeparator />}
            {regularProjects.length > 0 && (
              <CommandGroup heading="Projects">
                {regularProjects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${projectDisplayName(project)} ${project.path}`}
                    onSelect={() => chooseProject(project.id)}
                  >
                    <ProjectFavicon projectId={project.id} projectName={project.name} workspaceKind={project.workspaceKind} />
                    <span className="min-w-0 flex-1 truncate">{projectDisplayName(project)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>

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
        <Command shouldFilter disablePointerSelection>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search threads…"
            aria-label="Search threads"
          />
          <CommandList>
            <CommandEmpty>{contentSearchPending ? "Searching thread messages…" : "No threads found."}</CommandEmpty>
            <CommandGroup heading="Threads">
              {sortedSessions.map((session) => {
                const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
                const displayTitle = capitalizeTitle(session.title);
                const branch = session.branch ?? "unknown";
                const contentMatch = contentMatchBySession.get(session.id);
                return (
                  <CommandItem
                    key={session.id}
                    value={session.id}
                    keywords={[displayTitle, project?.name ?? "unknown", branch, contentMatch?.snippet ?? ""]}
                    onSelect={() => {
                      onSelectSession(session.id);
                      setSearchOpen(false);
                      setQuery("");
                      closeMobile();
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{displayTitle}</span>
                      {contentMatch && (
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          <span className={contentMatch.role === "user" ? "text-blue-500 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400"}>
                            {contentMatch.role === "user" ? "You:" : "Agent:"}
                          </span>{" "}
                          <HighlightedSnippet text={contentMatch.snippet} query={query} />
                        </span>
                      )}
                      <span className="block truncate text-[0.625rem] text-muted-foreground/75">
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

      <SidebarFooter className="p-2.5 pb-4">
        <SidebarMenu className="flex-row items-center gap-1">
          {activePage !== "workspace" ? (
            <SidebarMenuItem className="min-w-0 flex-1">
              <SidebarMenuButton
                className="h-8"
                onClick={() => {
                  onBack();
                  closeMobile();
                }}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            <>
              <SidebarMenuItem className="shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      aria-label="Settings"
                      className="size-8 w-8 justify-center p-0"
                      onClick={() => {
                        onOpenSettings();
                        closeMobile();
                      }}
                    >
                      <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="top">Settings</TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
              <SidebarMenuItem className="shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      aria-label="Usage"
                      className="size-8 w-8 justify-center p-0"
                      onClick={() => {
                        onOpenUsage();
                        closeMobile();
                      }}
                    >
                      <HugeiconsIcon icon={DatabaseSettingIcon} strokeWidth={2} />
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="top">Usage</TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            </>
          )}
          {(usage?.fiveHour || usage?.weekly) && (
            <SidebarMenuItem className="ml-auto shrink-0">
              <UsageLimitProgress usage={usage} tooltipSide="top" />
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </SidebarPrimitive>
  );
});
