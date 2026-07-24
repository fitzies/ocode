import type { SessionStatus } from "@anvil/protocol";
import type { AnvilClientSnapshot } from "../lib/anvilClient";
import { sortSessionsByActivity } from "@anvil/state";
import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import hamburgerMenuIcon from "@iconify-icons/solar/hamburger-menu-linear";
import searchIcon from "@iconify-icons/solar/magnifer-linear";

export type SidebarSnapshot = Pick<
  AnvilClientSnapshot,
  "projects" | "sessions" | "activeSessionId" | "readThroughSequences" | "connection"
>;

interface SidebarProps {
  snapshot: SidebarSnapshot;
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (projectId: string) => void;
  onAddWorkspace: () => void;
  onRequestDeleteSession: (sessionId: string) => void;
  onSetSessionSettled: (sessionId: string, settled: boolean) => Promise<void>;
  usage?: {
    fiveHour?: { usedPercent: number; resetAt?: number };
    weekly?: { usedPercent: number; resetAt?: number };
  };
}

function StatusMark({ status, completedUnviewed }: { status: SessionStatus; completedUnviewed: boolean }) {
  const label = completedUnviewed ? "completed, unviewed" : status;
  return <span className={`session-status session-status--${completedUnviewed ? "completed-unviewed" : status}`} aria-label={label} />;
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

function formatUpdatedAt(value: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  if (elapsedMinutes < 24 * 60) return `${Math.floor(elapsedMinutes / 60)}h`;
  return `${Math.floor(elapsedMinutes / (24 * 60))}d`;
}

export const Sidebar = memo(function Sidebar({
  snapshot,
  open,
  mobile,
  onClose,
  onSelectSession,
  onCreateSession,
  onAddWorkspace,
  onRequestDeleteSession,
  onSetSessionSettled,
  usage,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState(true);
  const [newThreadMenuOpen, setNewThreadMenuOpen] = useState(false);
  const [settlementPending, setSettlementPending] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const threadCreateRef = useRef<HTMLButtonElement>(null);
  const newThreadMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!newThreadMenuOpen) return;
    requestAnimationFrame(() => newThreadMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && (
        newThreadMenuRef.current?.contains(event.target as Node) ||
        threadCreateRef.current?.contains(event.target as Node)
      )) return;
      setNewThreadMenuOpen(false);
      if (event instanceof KeyboardEvent) requestAnimationFrame(() => threadCreateRef.current?.focus());
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [newThreadMenuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      setContextMenu(null);
      if (event.type === "keydown") requestAnimationFrame(() => contextTriggerRef.current?.focus());
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const openSessionMenu = (sessionId: string, x: number, y: number, trigger: HTMLButtonElement) => {
    contextTriggerRef.current = trigger;
    setContextMenu({
      sessionId,
      x: Math.max(8, Math.min(x, window.innerWidth - 168)),
      y: Math.max(8, Math.min(y, window.innerHeight - 58)),
    });
  };

  const visibleSessions = sortSessionsByActivity(snapshot.sessions.filter((session) => {
    const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
    return (!projectFilter || session.projectId === projectFilter) &&
      (!normalizedQuery || session.title.toLowerCase().includes(normalizedQuery) || project?.name.toLowerCase().includes(normalizedQuery));
  }));
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
    const completedUnviewed = session.lastTerminalOutcome === "completed" &&
      Boolean(session.lastTerminalSequence) &&
      (snapshot.readThroughSequences[session.id] ?? 0) < session.lastTerminalSequence!;
    const active = session.id === snapshot.activeSessionId;
    const settling = settlementPending.has(session.id);
    const displayTitle = capitalizeTitle(session.title);
    const branch = session.branch ?? "unknown";
    return (
      <div className={`session-item ${settled ? "session-item--settled" : ""}`} key={session.id}>
        <button
          className={`session-row ${active ? "session-row--active" : ""}`}
          data-session-id={session.id}
          onClick={() => {
            setContextMenu(null);
            onSelectSession(session.id);
            onClose();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openSessionMenu(session.id, event.clientX, event.clientY, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              openSessionMenu(session.id, bounds.right - 8, bounds.top + 8, event.currentTarget);
            }
          }}
        >
          <span className="session-copy">
            <span className="session-project-line">
              <span className="session-project">{project?.name.toLowerCase() ?? "unknown"}</span>
              <span className={`session-runtime session-runtime--${session.status}`}>
                {session.status === "running" ? "Working" : session.status === "waiting" ? "Needs you" : session.status === "failed" ? "Failed" : "Idle"}
              </span>
            </span>
            <span className="session-title" title={displayTitle}>{displayTitle}</span>
            <span className="session-meta">
              <span className="session-context-copy" title={`${project?.name.toLowerCase() ?? "unknown"}/${branch}`}>{project?.name.toLowerCase() ?? "unknown"}/{branch}</span>
              <span className="session-recency">
                <StatusMark status={session.status} completedUnviewed={completedUnviewed} />
                <span>{completedUnviewed ? "Completed" : formatUpdatedAt(session.updatedAt)}</span>
              </span>
            </span>
          </span>
        </button>
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
      </div>
    );
  };

  return (
    <aside
      className={`sidebar ${open ? "sidebar--open" : ""}`}
      aria-label="Projects and sessions"
      aria-modal={mobile && open ? true : undefined}
      role={mobile ? "dialog" : undefined}
      inert={mobile && !open ? true : undefined}
    >
      <div className="sidebar-brand">
        <button
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="Close sidebar"
          autoFocus={mobile && open}
        >
          <Icon icon={hamburgerMenuIcon} width={18} />
        </button>
        <div className="brand-lockup">
          <span className="brand-name">Anvil</span>
        </div>
      </div>

      <div className="sidebar-search-row">
        <label className="thread-search">
          <Icon icon={searchIcon} width={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads"
            aria-label="Search all threads"
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="thread-queue-actions">
          <button
            type="button"
            ref={threadCreateRef}
            className="thread-create"
            aria-label="Create thread"
            aria-haspopup={projectFilter ? undefined : "dialog"}
            aria-expanded={projectFilter ? undefined : newThreadMenuOpen}
            onClick={() => {
              if (projectFilter) {
                onCreateSession(projectFilter);
                onClose();
              } else {
                setNewThreadMenuOpen((open) => !open);
              }
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
          {newThreadMenuOpen && !projectFilter && (
            <div ref={newThreadMenuRef} className="new-thread-menu" role="dialog" aria-label="Choose a project for the new thread">
              {snapshot.projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  onClick={() => {
                    setNewThreadMenuOpen(false);
                    onCreateSession(project.id);
                    onClose();
                  }}
                >
                  {project.name.toLowerCase()}
                </button>
              ))}
              {snapshot.projects.length === 0 && <span>Add a project first</span>}
            </div>
          )}
        </div>
      </div>

      <div className="project-filter-wrap">
        <div className="project-filters" role="group" aria-label="Filter threads by project">
          <button className={`project-filter ${projectFilter === null ? "project-filter--active" : ""}`} aria-pressed={projectFilter === null} onClick={() => setProjectFilter(null)}>All</button>
          {snapshot.projects.map((project) => (
            <button
              key={project.id}
              className={`project-filter ${projectFilter === project.id ? "project-filter--active" : ""}`}
              aria-pressed={projectFilter === project.id}
              onClick={() => {
                setProjectFilter(project.id);
                setNewThreadMenuOpen(false);
              }}
              title={project.path}
            >
              {project.name.toLowerCase()}
            </button>
          ))}
          <button type="button" className="project-filter-add" onClick={onAddWorkspace} aria-label="Add workspace" title="Add workspace">+</button>
        </div>
      </div>

      <div className="sidebar-scroll">
        {snapshot.projects.length === 0 && !normalizedQuery && <div className="workspace-empty-note">Add a Forge directory to begin.</div>}
        {(normalizedQuery || projectFilter) && visibleSessions.length === 0 && <div className="search-empty">No matching threads</div>}

        <section className="thread-section" aria-label="Unsettled threads">
          <div className="session-list">{unsettledSessions.map((session) => renderSession(session, false))}</div>
          {unsettledSessions.length === 0 && visibleSessions.length > 0 && <div className="thread-empty">Everything here is settled.</div>}
          {unsettledSessions.length === 0 && visibleSessions.length === 0 && !normalizedQuery && !projectFilter && <div className="thread-empty">Nothing needs your attention.</div>}
        </section>

        {settledSessions.length > 0 && (
          <section className="thread-section thread-section--settled" aria-labelledby="settled-heading">
            <button className="thread-section-heading thread-section-toggle" id="settled-heading" onClick={() => setSettledOpen((open) => !open)} aria-expanded={settledOpen}>
              <span>{settledOpen ? "▾" : "▸"} Settled</span><span>{settledSessions.length}</span>
            </button>
            {settledOpen && <div className="session-list session-list--settled">{settledSessions.map((session) => renderSession(session, true))}</div>}
          </section>
        )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="thread-context-menu"
          role="menu"
          aria-label="Thread actions"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="thread-context-delete"
            onClick={() => {
              const sessionId = contextMenu.sessionId;
              setContextMenu(null);
              onRequestDeleteSession(sessionId);
            }}
          >
            Delete thread
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        {usage && (usage.fiveHour || usage.weekly) && (
          <div className="usage-limits" aria-label="Codex usage limits">
            {([['5h', 5, usage.fiveHour], ['Weekly', 7 * 24, usage.weekly]] as const).map(([label, hours, window]) => {
              const tone = usageTone(window, hours);
              return (
                <div className={`usage-limit usage-limit--${tone}`} key={label} title={window?.resetAt ? `Resets ${new Date(window.resetAt * 1000).toLocaleString()}` : undefined}>
                  <div className="usage-limit-label"><span>{label}</span><span>{window ? `${Math.round(window.usedPercent)}%` : "—"}</span></div>
                  <div className="usage-track"><i style={{ width: `${window ? Math.max(0, Math.min(100, window.usedPercent)) : 0}%` }} /></div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
});
