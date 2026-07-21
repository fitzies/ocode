import type { SessionStatus } from "@anvil/protocol";
import type { AnvilSnapshot } from "../lib/anvilClient";
import {
  ChevronDown,
  Hammer,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Server,
  Settings,
  X,
} from "lucide-react";

interface SidebarProps {
  snapshot: AnvilSnapshot;
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onCreateSession: () => void;
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
  onCreateSession,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside
      className={`sidebar ${open ? "sidebar--open" : ""}`}
      aria-label="Projects and sessions"
      aria-modal={mobile && open ? true : undefined}
      role={mobile ? "dialog" : undefined}
      inert={mobile && !open ? true : undefined}
    >
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">
          <Hammer size={17} strokeWidth={2.2} />
        </div>
        <div>
          <div className="brand-name">Anvil</div>
          <div className="brand-environment">Personal workspace</div>
        </div>
        <button
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="Close sidebar"
          autoFocus={mobile && open}
        >
          <X size={17} />
        </button>
      </div>

      <button className="new-session-button" onClick={onCreateSession}>
        <Plus size={16} />
        New session
        <kbd>⌘N</kbd>
      </button>

      <div className="sidebar-scroll">
        <div className="sidebar-section-label">Workspace</div>
        {snapshot.projects.map((project) => {
          const sessions = snapshot.sessions.filter((session) => session.projectId === project.id);
          return (
            <section className="project-group" key={project.id}>
              <div className="project-heading">
                <ChevronDown size={13} />
                <span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span>
                <span>{project.name}</span>
                <button className="project-menu" aria-label={`More options for ${project.name}`} disabled title="Coming soon">
                  <MoreHorizontal size={15} />
                </button>
              </div>
              <div className="session-list">
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
                    <MessageSquare size={14} className="session-icon" />
                    <span className="session-copy">
                      <span className="session-title">{session.title}</span>
                      <span className="session-meta">
                        <StatusMark status={session.status} />
                        {session.status === "waiting" ? "Needs input" : formatUpdatedAt(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="forge-card">
          <span className="forge-icon"><Server size={15} /></span>
          <span className="forge-copy">
            <strong>Forge</strong>
            <span>
              <i className={`online-dot online-dot--${snapshot.connection}`} />
              {snapshot.connection === "connected"
                ? "Connected via Tailscale"
                : snapshot.connection === "reconnecting"
                  ? "Reconnecting…"
                  : "Offline · showing cached state"}
            </span>
          </span>
          <button className="icon-button" aria-label="Forge settings" disabled title="Coming soon">
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
