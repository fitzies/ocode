import type { CapabilityCatalog } from "@anvil/protocol";
import { Icon } from "@iconify/react";
import branchingPathsIcon from "@iconify-icons/solar/branching-paths-down-linear";
import forgeServerIcon from "@iconify-icons/solar/server-square-cloud-bold-duotone";
import hamburgerMenuIcon from "@iconify-icons/solar/hamburger-menu-linear";
import settingsIcon from "@iconify-icons/solar/settings-minimalistic-linear";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { anvilClient } from "../lib/anvilClient";
import { Composer, updateComposerDraft } from "./Composer";
import { InteractionDialog } from "./InteractionDialog";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { AddWorkspaceDialog, DeleteThreadDialog } from "./WorkspaceDialogs";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

export function AppShell() {
  const snapshot = useSyncExternalStore(anvilClient.subscribe, anvilClient.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeSession =
    snapshot.sessions.find((session) => session.id === snapshot.activeSessionId) ??
    snapshot.sessions[0];

  const activeProject = snapshot.projects.find(
    (project) => project.id === activeSession?.projectId,
  );
  const activeSessionPending = activeSession
    ? anvilClient.isSessionPending(activeSession.id)
    : false;
  const activeSessionCreationError = activeSession
    ? anvilClient.getSessionCreationError(activeSession.id)
    : undefined;
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
  const activeCatalog = activeSession
    ? snapshot.catalogs[activeSession.id] ?? EMPTY_CATALOG
    : EMPTY_CATALOG;
  const selectedProjectId = snapshot.projects.some((project) => project.id === newProjectId)
    ? newProjectId
    : snapshot.projects[0]?.id ?? "";
  const updateDraft = useCallback((sessionId: string, prompt: string) => {
    setComposerDrafts((drafts) => updateComposerDraft(drafts, sessionId, prompt));
  }, []);
  const startSession = useCallback((projectId: string) => {
    anvilClient.createSession(projectId);
    setSidebarOpen(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message Pi']")?.focus();
    });
  }, []);
  const closeDeleteDialog = (deleted = false) => {
    const sessionId = sessionPendingDeletion?.id;
    setSessionPendingDeletion(null);
    if (!sessionId) return;
    requestAnimationFrame(() => {
      const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-session-id]"));
      const target = deleted
        ? triggers.find((element) => element.dataset.sessionId !== sessionId)
        : triggers.find((element) => element.dataset.sessionId === sessionId);
      (target ?? document.querySelector<HTMLButtonElement>("[aria-label='Add workspace']"))?.focus();
    });
  };

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
        if (projectId) startSession(projectId);
      }
      const threadShortcut = /^Digit([1-9])$/.exec(event.code);
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && threadShortcut && activeSession) {
        event.preventDefault();
        const threadIndex = Number(threadShortcut[1]) - 1;
        const target = snapshot.sessions.filter(
          (session) => session.projectId === activeSession.projectId,
        )[threadIndex];
        if (target) {
          anvilClient.selectSession(target.id);
          setSidebarOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSession, sidebarOpen, snapshot.projects, snapshot.sessions, startSession]);

  if (!activeSession && snapshot.connection !== "connected") {
    return (
      <main className="app-loading" role="status" aria-live="polite">
        <span className="forge-spinner" aria-hidden="true" />
        <span className="sr-only">Connecting to Forge</span>
      </main>
    );
  }

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
        onCreateSession={startSession}
        onAddWorkspace={() => setAddWorkspaceOpen(true)}
        onRequestDeleteSession={(sessionId) => {
          const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
          if (session) setSessionPendingDeletion({ id: session.id, title: session.title });
        }}
      />

      <main className="workspace">
        <header className="session-header">
          <div className="header-title-group">
            <button ref={menuButtonRef} className="icon-button menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Icon icon={hamburgerMenuIcon} width={18} />
            </button>
            <div className="session-heading">
              <div className="session-heading-row">
                <h1>{activeSession?.title ?? "No thread selected"}</h1>
                {activeSession && (
                  <span className={`header-run-state header-run-state--${activeSession.status}`}>
                    {activeSessionCreationError ? "Failed" : activeSessionPending ? "Starting" : activeSession.status === "running" ? "Running" : activeSession.status === "waiting" ? "Waiting" : activeSession.status === "failed" ? "Failed" : "Ready"}
                  </span>
                )}
              </div>
              {activeSession && (
                <div className="session-context">
                  <span>{activeProject?.name}</span><span className="context-separator">/</span><Icon icon={branchingPathsIcon} width={12} /><span>{activeSession.branch ?? "main"}</span>
                </div>
              )}
            </div>
          </div>

          <div className="header-actions">
            <button className="icon-button header-settings" aria-label="Settings" disabled title="Settings coming soon">
              <Icon icon={settingsIcon} width={18} />
            </button>
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

        {activeSession ? (
          <>
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
              prompt={composerDrafts[activeSession.id] ?? ""}
              pending={activeSessionPending}
              creationError={activeSessionCreationError}
              widgets={widgets}
              onCancel={anvilClient.cancelActiveRun}
              onDraftConsumed={anvilClient.clearComposerDraft}
              onPromptChange={updateDraft}
              onModelChange={anvilClient.setModel}
              onThinkingLevelChange={anvilClient.setThinkingLevel}
              onSend={anvilClient.sendPrompt}
            />
          </>
        ) : (
          <div className="app-loading app-loading--workspace">
            <div className="empty-workspace">
              <Icon icon={forgeServerIcon} width={24} />
              <strong>No threads yet</strong>
              <p>
                {snapshot.projects.length > 0
                  ? "Choose a workspace and start the first thread."
                  : "Add a workspace with the + in the sidebar."}
              </p>
              {snapshot.projects.length > 0 && (
                <div className="empty-project-picker">
                  <label htmlFor="new-session-project">Workspace</label>
                  <select
                    id="new-session-project"
                    value={selectedProjectId}
                    onChange={(event) => setNewProjectId(event.target.value)}
                  >
                    {snapshot.projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => startSession(selectedProjectId)}>
                    Start thread
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <InteractionDialog requests={pendingInteractions} onRespond={anvilClient.respondToInteraction} />
      {addWorkspaceOpen && (
        <AddWorkspaceDialog
          onClose={() => setAddWorkspaceOpen(false)}
          onCreate={anvilClient.createProject}
        />
      )}
      {sessionPendingDeletion && (
        <DeleteThreadDialog
          title={sessionPendingDeletion.title}
          onClose={closeDeleteDialog}
          onDelete={() => anvilClient.deleteSession(sessionPendingDeletion.id)}
        />
      )}
    </div>
  );
}
