import type { SessionStatus } from "@anvil/protocol";
import type { AnvilSnapshot } from "../lib/anvilClient";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import altArrowDownIcon from "@iconify-icons/solar/alt-arrow-down-linear";
import closeCircleIcon from "@iconify-icons/solar/close-circle-linear";
import searchIcon from "@iconify-icons/solar/magnifer-linear";
import trashIcon from "@iconify-icons/solar/trash-bin-minimalistic-linear";

interface SidebarProps {
  snapshot: AnvilSnapshot;
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (projectId: string) => void;
  onAddWorkspace: () => void;
  onRequestDeleteSession: (sessionId: string) => void;
}

function StatusMark({ status }: { status: SessionStatus }) {
  return <span className={`session-status session-status--${status}`} aria-label={status} />;
}

function formatUpdatedAt(value: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  if (elapsedMinutes < 24 * 60) return `${Math.floor(elapsedMinutes / 60)}h`;
  return `${Math.floor(elapsedMinutes / (24 * 60))}d`;
}

export function Sidebar({
  snapshot,
  open,
  mobile,
  onClose,
  onSelectSession,
  onCreateSession,
  onAddWorkspace,
  onRequestDeleteSession,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const hasSearchResults = snapshot.sessions.some((session) => {
    const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
    return (
      session.title.toLowerCase().includes(normalizedQuery) ||
      project?.name.toLowerCase().includes(normalizedQuery)
    );
  });

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

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
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
        <div className="brand-lockup">
          <span className="brand-name">Anvil</span>
          <span className="brand-divider">/</span>
          <span className="brand-environment">Pi</span>
        </div>
        <button
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="Close sidebar"
          autoFocus={mobile && open}
        >
          <Icon icon={closeCircleIcon} width={18} />
        </button>
      </div>

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

      <div className="sidebar-scroll">
        <div className="sidebar-section-heading">
          <span className="sidebar-section-label">Workspaces</span>
          <button
            type="button"
            className="workspace-add"
            aria-label="Add workspace"
            title="Add workspace"
            onClick={onAddWorkspace}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        {snapshot.projects.length === 0 && !normalizedQuery && (
          <div className="workspace-empty-note">Add a Forge directory to begin.</div>
        )}
        {normalizedQuery && !hasSearchResults && (
          <div className="search-empty">No threads found</div>
        )}
        {snapshot.projects.map((project) => {
          const projectMatches = project.name.toLowerCase().includes(normalizedQuery);
          const sessions = snapshot.sessions.filter(
            (session) =>
              session.projectId === project.id &&
              (!normalizedQuery || projectMatches || session.title.toLowerCase().includes(normalizedQuery)),
          );
          if (normalizedQuery && sessions.length === 0) return null;
          const collapsed = collapsedProjects.has(project.id) && !normalizedQuery;

          return (
            <section className="project-group" key={project.id}>
              <div className="project-heading-row">
                <button
                  className="project-heading"
                  onClick={() => toggleProject(project.id)}
                  aria-expanded={!collapsed}
                >
                  <Icon
                    icon={altArrowDownIcon}
                    width={13}
                    className={`project-chevron ${collapsed ? "project-chevron--collapsed" : ""}`}
                  />
                  <span>{project.name}</span>
                </button>
                <button
                  type="button"
                  className="project-new-session"
                  aria-label={`Start a session in ${project.name}`}
                  title={`New session in ${project.name}`}
                  onClick={() => {
                    onCreateSession(project.id);
                    onClose();
                  }}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
              {!collapsed && <div className="session-list">
                {sessions.map((session) => (
                  <div className="session-item" key={session.id}>
                    <button
                      className={`session-row ${
                        session.id === snapshot.activeSessionId ? "session-row--active" : ""
                      }`}
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
                        <span className="session-title">{session.title}</span>
                        <span className="session-meta">
                          <StatusMark status={session.status} />
                          {session.status === "waiting" ? "Needs input" : formatUpdatedAt(session.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="session-delete"
                      aria-label={`Delete ${session.title}`}
                      title="Delete thread"
                      onClick={() => onRequestDeleteSession(session.id)}
                    >
                      <Icon icon={trashIcon} width={14} />
                    </button>
                  </div>
                ))}
              </div>}
            </section>
          );
        })}
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
        <div className="forge-status">
          <span className="forge-status-name">Forge</span>
          <i className={`online-dot online-dot--${snapshot.connection}`} />
          <span>
            {snapshot.connection === "connected"
              ? "Tailscale"
              : snapshot.connection === "reconnecting"
                ? "Reconnecting"
                : "Offline"}
          </span>
        </div>
      </div>
    </aside>
  );
}
