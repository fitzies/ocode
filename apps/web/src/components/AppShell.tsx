import type { CapabilityCatalog } from "@anvil/protocol";
import { Icon } from "@iconify/react";
import branchingPathsIcon from "@iconify-icons/solar/branching-paths-down-linear";
import forgeServerIcon from "@iconify-icons/solar/server-square-cloud-bold-duotone";
import hamburgerMenuIcon from "@iconify-icons/solar/hamburger-menu-linear";
import menuDotsIcon from "@iconify-icons/solar/menu-dots-linear";
import shieldCheckIcon from "@iconify-icons/solar/shield-check-bold-duotone";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { anvilClient } from "../lib/anvilClient";
import { Composer } from "./Composer";
import { InteractionDialog } from "./InteractionDialog";
import { ReplayControls } from "./ReplayControls";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

export function AppShell() {
  const snapshot = useSyncExternalStore(anvilClient.subscribe, anvilClient.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeSession =
    snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) ??
    snapshot.sessions[0];

  const activeProject = snapshot.projects.find(
    (project) => project.id === activeSession?.projectId,
  );
  const timeline = activeSession ? snapshot.timelines[activeSession.id] ?? [] : [];
  const pendingInteractions = activeSession
    ? snapshot.pendingInteractions.filter((request) => request.sessionId === activeSession.id)
    : [];
  const statuses = activeSession
    ? snapshot.extensionStatuses.filter((status) => status.sessionId === activeSession.id)
    : [];
  const widgets = activeSession
    ? snapshot.widgets.filter((widget) => widget.sessionId === activeSession.id)
    : [];
  const sequenceGap = snapshot.sequenceGap;
  const fixtureMode = snapshot.replay.fixtureId !== "live";
  const activeCatalog = activeSession
    ? snapshot.catalogs[activeSession.id] ?? EMPTY_CATALOG
    : EMPTY_CATALOG;
  const selectedProjectId = snapshot.projects.some((project) => project.id === newProjectId)
    ? newProjectId
    : snapshot.projects[0]?.id ?? "";

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
        const projectId = activeSession?.projectId ??
          (snapshot.projects.length === 1 ? snapshot.projects[0]?.id : undefined);
        if (projectId) {
          anvilClient.createSession(projectId);
          setSidebarOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSession?.projectId, sidebarOpen, snapshot.projects]);

  if (!activeSession) {
    const connecting = snapshot.connection !== "connected" && snapshot.projects.length === 0;
    return (
      <main className="app-loading">
        <div className="empty-workspace">
          <Icon icon={forgeServerIcon} width={24} />
          <strong>{connecting ? "Connecting to Forge" : "No sessions yet"}</strong>
          <p>
            {connecting
              ? "Restoring projects and conversations…"
              : snapshot.projects.length > 0
                ? "Choose where Pi should start the conversation."
                : "No Forge projects are configured."}
          </p>
          {!connecting && snapshot.projects.length > 0 && (
            <div className="empty-project-picker">
              <label htmlFor="new-session-project">Project</label>
              <select
                id="new-session-project"
                value={selectedProjectId}
                onChange={(event) => setNewProjectId(event.target.value)}
              >
                {snapshot.projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <button type="button" onClick={() => anvilClient.createSession(selectedProjectId)}>
                Start session
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  const connectionLabel =
    snapshot.connection === "connected"
      ? "Forge"
      : snapshot.connection === "reconnecting"
        ? "Reconnecting"
        : "Offline";

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        snapshot={snapshot}
        open={sidebarOpen}
        mobile={mobile}
        onClose={() => {
          setSidebarOpen(false);
          menuButtonRef.current?.focus();
        }}
        onSelectSession={anvilClient.selectSession}
        onCreateSession={anvilClient.createSession}
      />

      <main className="workspace">
        <header className="session-header">
          <div className="header-title-group">
            <button ref={menuButtonRef} className="icon-button menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Icon icon={hamburgerMenuIcon} width={18} />
            </button>
            <div className="session-heading">
              <div className="session-heading-row">
                <h1>{activeSession.title}</h1>
                <span className={`header-run-state header-run-state--${activeSession.status}`}>
                  {activeSession.status === "running" ? "Running" : activeSession.status === "waiting" ? "Waiting" : activeSession.status === "failed" ? "Failed" : "Ready"}
                </span>
              </div>
              <div className="session-context">
                <span>{activeProject?.name}</span><span className="context-separator">/</span><Icon icon={branchingPathsIcon} width={12} /><span>{activeSession.branch ?? "main"}</span>
              </div>
            </div>
          </div>

          <div className="header-actions">
            {import.meta.env.DEV && fixtureMode && (
              <ReplayControls
                replay={snapshot.replay}
                onFixtureChange={anvilClient.selectReplayFixture}
                onInstant={anvilClient.instantReplay}
                onRestart={anvilClient.restartReplay}
                onSpeedChange={anvilClient.setReplaySpeed}
                onToggle={anvilClient.toggleReplay}
              />
            )}
            <button
              className={`connection-chip connection-chip--${snapshot.connection}`}
              title={fixtureMode ? "Cycle fixture connection state" : "Forge connection state"}
              onClick={fixtureMode ? anvilClient.cycleConnectionState : undefined}
              disabled={!fixtureMode}
            >
              <Icon icon={forgeServerIcon} width={15} /><span>{connectionLabel}</span>
            </button>
            <div className="trust-chip" title="Pi runtime access level"><Icon icon={shieldCheckIcon} width={15} />Full access</div>
            <button className="icon-button" aria-label="Session options" disabled title="Coming soon"><Icon icon={menuDotsIcon} width={18} /></button>
          </div>
        </header>

        {statuses.length > 0 && (
          <div className="extension-status-bar" aria-live="polite">
            {statuses.map((status) => <span key={status.key}><i />{status.text}<small>{status.key}</small></span>)}
          </div>
        )}
        {sequenceGap && (
          <div className="reconciliation-banner" role="status">
            Reconnecting event stream · waiting for sequence {sequenceGap.expected} before {sequenceGap.received}
          </div>
        )}
        {snapshot.clientError && (
          <div className="reconciliation-banner" role="alert">
            Forge command failed · {snapshot.clientError}
          </div>
        )}

        <Timeline session={activeSession} entries={timeline} onSuggestion={(prompt) => anvilClient.sendPrompt(prompt)} />

        <Composer
          sessionId={activeSession.id}
          modelId={activeSession.modelId}
          thinkingLevel={activeSession.thinkingLevel}
          status={activeSession.status}
          models={activeCatalog.models}
          commands={activeCatalog.commands}
          skills={activeCatalog.skills}
          queue={snapshot.queues[activeSession.id] ?? { steering: [], followUp: [] }}
          draft={snapshot.composerDrafts[activeSession.id]}
          widgets={widgets}
          onCancel={anvilClient.cancelActiveRun}
          onDraftConsumed={anvilClient.clearComposerDraft}
          onModelChange={anvilClient.setModel}
          onThinkingLevelChange={anvilClient.setThinkingLevel}
          onSend={anvilClient.sendPrompt}
        />
      </main>

      <InteractionDialog requests={pendingInteractions} onRespond={anvilClient.respondToInteraction} />
    </div>
  );
}
