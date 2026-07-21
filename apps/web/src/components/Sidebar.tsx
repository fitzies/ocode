import type { SessionStatus } from "@anvil/protocol";
import type { AnvilSnapshot } from "../lib/anvilClient";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import altArrowDownIcon from "@iconify-icons/solar/alt-arrow-down-linear";
import closeCircleIcon from "@iconify-icons/solar/close-circle-linear";
import searchIcon from "@iconify-icons/solar/magnifer-linear";

interface SidebarProps {
  snapshot: AnvilSnapshot;
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
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
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
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
        <div className="sidebar-section-label">Workspace</div>
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
                <span className="project-thread-count">{sessions.length}</span>
              </button>
              {!collapsed && <div className="session-list">
                {sessions.map((session) => (
                  <button
                    className={`session-row ${
                      session.id === snapshot.activeSessionId ? "session-row--active" : ""
                    }`}
                    key={session.id}
                    onClick={() => {
                      onSelectSession(session.id);
                      onClose();
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
                ))}
              </div>}
            </section>
          );
        })}
      </div>

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
