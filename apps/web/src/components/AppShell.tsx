import { Icon } from "@iconify/react";
import branchingPathsIcon from "@iconify-icons/solar/branching-paths-down-linear";
import hamburgerMenuIcon from "@iconify-icons/solar/hamburger-menu-linear";
import menuDotsIcon from "@iconify-icons/solar/menu-dots-linear";
import shieldCheckIcon from "@iconify-icons/solar/shield-check-bold-duotone";
import forgeServerIcon from "@iconify-icons/solar/server-square-cloud-bold-duotone";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { anvilClient } from "../lib/anvilClient";
import { Composer } from "./Composer";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";

export function AppShell() {
  const snapshot = useSyncExternalStore(anvilClient.subscribe, anvilClient.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeSession =
    snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) ??
    snapshot.sessions[0]!;

  const activeProject = snapshot.projects.find(
    (project) => project.id === activeSession.projectId,
  );
  const timeline = snapshot.timelines[activeSession.id] ?? [];

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sidebarOpen) {
        setSidebarOpen(false);
        menuButtonRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        anvilClient.createSession();
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  const connectionLabel =
    snapshot.connection === "connected"
      ? "Forge"
      : snapshot.connection === "reconnecting"
        ? "Reconnecting"
        : "Offline";

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        snapshot={snapshot}
        open={sidebarOpen}
        mobile={mobile}
        onClose={() => {
          setSidebarOpen(false);
          menuButtonRef.current?.focus();
        }}
        onSelectSession={(sessionId) => anvilClient.selectSession(sessionId)}
      />

      <main className="workspace">
        <header className="session-header">
          <div className="header-title-group">
            <button
              ref={menuButtonRef}
              className="icon-button menu-trigger"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
            >
              <Icon icon={hamburgerMenuIcon} width={18} />
            </button>
            <div className="session-heading">
              <div className="session-heading-row">
                <h1>{activeSession.title}</h1>
                <span className={`header-run-state header-run-state--${activeSession.status}`}>
                  {activeSession.status === "running"
                    ? "Running"
                    : activeSession.status === "waiting"
                      ? "Waiting"
                      : activeSession.status === "failed"
                        ? "Failed"
                        : "Ready"}
                </span>
              </div>
              <div className="session-context">
                <span>{activeProject?.name}</span>
                <span className="context-separator">/</span>
                <Icon icon={branchingPathsIcon} width={12} />
                <span>main</span>
              </div>
            </div>
          </div>

          <div className="header-actions">
            <button
              className={`connection-chip connection-chip--${snapshot.connection}`}
              title="Cycle mock connection state"
              onClick={() => anvilClient.cycleConnectionState()}
            >
              <Icon icon={forgeServerIcon} width={15} />
              <span>{connectionLabel}</span>
            </button>
            <div className="trust-chip" title="Pi runtime access level">
              <Icon icon={shieldCheckIcon} width={15} />
              Full access
            </div>
            <button className="icon-button" aria-label="Session options" disabled title="Coming soon">
              <Icon icon={menuDotsIcon} width={18} />
            </button>
          </div>
        </header>

        <Timeline
          session={activeSession}
          entries={timeline}
          onSuggestion={(prompt) => anvilClient.sendPrompt(prompt)}
        />

        <Composer
          model={activeSession.model}
          status={activeSession.status}
          onCancel={() => anvilClient.cancelActiveRun()}
          onModelChange={(model) => anvilClient.setModel(model)}
          onSend={(prompt) => anvilClient.sendPrompt(prompt)}
        />
      </main>
    </div>
  );
}
