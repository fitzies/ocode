import type { ArtifactReference, CapabilityCatalog } from "@anvil/protocol";
import { Icon } from "@iconify/react";
import forgeServerIcon from "@iconify-icons/solar/server-square-cloud-bold-duotone";
import hamburgerMenuIcon from "@iconify-icons/solar/hamburger-menu-linear";
import settingsIcon from "@iconify-icons/solar/settings-minimalistic-linear";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { anvilClient, type DeliveryMode } from "../lib/anvilClient";
import { Composer, type ComposerAttachment, updateComposerDraft } from "./Composer";
import { InteractionPanel } from "./InteractionDialog";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { AddWorkspaceDialog, DeleteThreadDialog } from "./WorkspaceDialogs";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

type CompletionToast = {
  id: string;
  sessionId: string;
  title: string;
};

type LiveIndicators = {
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  git?: { additions: number; deletions: number };
  usage?: {
    fiveHour?: { usedPercent: number; resetAt?: number };
    weekly?: { usedPercent: number; resetAt?: number };
  };
};

export function AppShell() {
  const snapshot = useSyncExternalStore(anvilClient.subscribe, anvilClient.getSnapshot);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = useState<Record<string, ComposerAttachment[]>>({});
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const [indicators, setIndicators] = useState<LiveIndicators>({});
  const [completionToasts, setCompletionToasts] = useState<CompletionToast[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartState, setRestartState] = useState<"idle" | "restarting">("idle");
  const [restartError, setRestartError] = useState<string>();
  const gitIndicatorsByProject = useRef(new Map<string, LiveIndicators["git"]>());
  const terminalSequences = useRef<Map<string, number> | null>(null);
  const toastTimers = useRef(new Map<string, number>());
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const settingsControlRef = useRef<HTMLDivElement>(null);
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
  const sidebarSnapshot = useMemo(() => ({
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    activeSessionId: snapshot.activeSessionId,
    readThroughSequences: snapshot.readThroughSequences,
    connection: snapshot.connection,
  }), [
    snapshot.projects,
    snapshot.sessions,
    snapshot.activeSessionId,
    snapshot.readThroughSequences,
    snapshot.connection,
  ]);
  const sendSuggestion = useCallback((prompt: string) => anvilClient.sendPrompt(prompt), []);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    menuButtonRef.current?.focus();
  }, []);
  const openAddWorkspace = useCallback(() => setAddWorkspaceOpen(true), []);
  const requestDeleteSession = useCallback((sessionId: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session) setSessionPendingDeletion({ id: session.id, title: session.title });
  }, [snapshot.sessions]);
  const updateDraft = useCallback((sessionId: string, prompt: string) => {
    setComposerDrafts((drafts) => updateComposerDraft(drafts, sessionId, prompt));
  }, []);
  const attachFiles = useCallback((sessionId: string, files: File[]) => {
    const pending = files.map((file) => ({
      item: {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "uploading" as const,
      },
      file,
    }));
    setComposerAttachments((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), ...pending.map(({ item }) => item)],
    }));
    for (const { item, file } of pending) {
      void anvilClient.uploadAttachment(sessionId, file).then((reference) => {
        setComposerAttachments((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? []).map((candidate) => (
            candidate.id === item.id ? { ...candidate, status: "ready", reference } : candidate
          )),
        }));
      }).catch((error) => {
        setComposerAttachments((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? []).map((candidate) => (
            candidate.id === item.id
              ? { ...candidate, status: "failed", error: error instanceof Error ? error.message : String(error) }
              : candidate
          )),
        }));
      });
    }
  }, []);
  const removeAttachment = useCallback((sessionId: string, attachmentId: string) => {
    const attachment = composerAttachments[sessionId]?.find((candidate) => candidate.id === attachmentId);
    setComposerAttachments((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).filter((candidate) => candidate.id !== attachmentId),
    }));
    if (attachment?.reference) {
      void anvilClient.deleteAttachment(sessionId, attachment.reference.artifactId);
    }
  }, [composerAttachments]);
  const sendComposerPrompt = useCallback(async (
    prompt: string,
    mode: DeliveryMode,
    attachments: ArtifactReference[],
  ) => {
    const sessionId = anvilClient.getSnapshot().activeSessionId;
    const accepted = await anvilClient.sendPrompt(prompt, mode, attachments);
    if (accepted && sessionId) {
      setComposerAttachments((current) => ({ ...current, [sessionId]: [] }));
    }
  }, []);
  const startSession = useCallback((projectId: string) => {
    anvilClient.createSession(projectId);
    setSidebarOpen(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message Pi']")?.focus();
    });
  }, []);
  const restartForge = useCallback(async () => {
    const running = snapshot.sessions.filter(
      (session) => session.status === "running" || session.status === "waiting",
    ).length;
    const warning = running > 0
      ? `Restart Forge now? ${running} active ${running === 1 ? "thread" : "threads"} will be interrupted.`
      : "Restart the Forge backend now? Anvil will reconnect automatically.";
    if (!window.confirm(warning)) return;
    setRestartState("restarting");
    setRestartError(undefined);
    try {
      await anvilClient.restartForge();
      setSettingsOpen(false);
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestartState("idle");
    }
  }, [snapshot.sessions]);
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
    // Account limits are global and Git changes belong to the project, while
    // context is session-scoped. Keep the project's last Git value visible when
    // switching threads so it does not flicker during the refresh.
    const projectId = activeSession?.projectId;
    setIndicators((current) => ({
      usage: current.usage,
      git: projectId ? gitIndicatorsByProject.current.get(projectId) : undefined,
    }));
    if (!activeSession?.id || !projectId) return;
    const sessionId = activeSession.id;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/indicators`, {
          signal: controller.signal,
        });
        const next = response.ok ? await response.json() as LiveIndicators : {};
        if (!controller.signal.aborted) {
          if (next.git) gitIndicatorsByProject.current.set(projectId, next.git);
          setIndicators((current) => ({ ...next, usage: next.usage ?? current.usage }));
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setIndicators((current) => ({
            usage: current.usage,
            git: gitIndicatorsByProject.current.get(projectId),
          }));
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = window.setTimeout(load, activeSession.status === "running" ? 8_000 : 30_000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeSession?.id, activeSession?.status]);

  useEffect(() => {
    document.title = activeSession?.title ? `${activeSession.title} · Anvil` : "Anvil";
  }, [activeSession?.title]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!settingsControlRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [settingsOpen]);

  useEffect(() => {
    const current = new Map(snapshot.sessions.map((session) => [
      session.id,
      session.lastTerminalSequence ?? 0,
    ]));
    const previous = terminalSequences.current;
    terminalSequences.current = current;
    if (!previous) return;

    for (const session of snapshot.sessions) {
      const sequence = session.lastTerminalSequence ?? 0;
      if (
        session.lastTerminalOutcome !== "completed" ||
        sequence <= (previous.get(session.id) ?? sequence)
      ) continue;

      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        if ("Notification" in window && Notification.permission === "granted") {
          const notification = new Notification("Thread completed", {
            body: session.title,
            icon: "/favicon.svg",
            tag: `anvil-completed-${session.id}`,
          });
          notification.onclick = () => {
            window.focus();
            anvilClient.selectSession(session.id);
            anvilClient.markSessionRead(session.id);
            notification.close();
          };
        }
        continue;
      }

      const toastId = `${session.id}-${sequence}`;
      setCompletionToasts((currentToasts) => [
        ...currentToasts.filter((toast) => toast.sessionId !== session.id),
        { id: toastId, sessionId: session.id, title: session.title },
      ]);
      const existingTimer = toastTimers.current.get(session.id);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      toastTimers.current.set(session.id, window.setTimeout(() => {
        setCompletionToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== toastId));
        toastTimers.current.delete(session.id);
      }, 8_000));
    }
  }, [snapshot.sessions]);

  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const markVisibleCompletionRead = () => {
      if (
        activeSession?.lastTerminalSequence &&
        !snapshot.hydratingSessionIds.includes(activeSession.id) &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        anvilClient.markSessionRead(activeSession.id);
      }
    };
    markVisibleCompletionRead();
    document.addEventListener("visibilitychange", markVisibleCompletionRead);
    window.addEventListener("focus", markVisibleCompletionRead);
    return () => {
      document.removeEventListener("visibilitychange", markVisibleCompletionRead);
      window.removeEventListener("focus", markVisibleCompletionRead);
    };
  }, [activeSession?.id, activeSession?.lastTerminalSequence, snapshot.hydratingSessionIds]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
        settingsControlRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup='menu']")?.focus();
      } else if (event.key === "Escape" && sidebarOpen) {
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
  }, [activeSession, settingsOpen, sidebarOpen, snapshot.projects, snapshot.sessions, startSession]);

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
        snapshot={sidebarSnapshot}
        open={sidebarOpen}
        mobile={mobile}
        onClose={closeSidebar}
        onSelectSession={anvilClient.selectSession}
        onCreateSession={startSession}
        onAddWorkspace={openAddWorkspace}
        usage={indicators.usage}
        onRequestDeleteSession={requestDeleteSession}
        onSetSessionSettled={anvilClient.setSessionSettled}
      />

      <main className="workspace">
        <header className="session-header">
          <div className="header-title-group">
            <button ref={menuButtonRef} className="icon-button menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Icon icon={hamburgerMenuIcon} width={18} />
            </button>
            <div className="session-heading">
              <h1>
                {activeSession ? (
                  <><span className="session-heading-repo">{activeProject?.name.toLowerCase() ?? "unknown"}</span> / {activeSession.title}</>
                ) : "No thread selected"}
              </h1>
            </div>
          </div>

          <div className="header-actions">
            {indicators.git && (
              <span className="git-diff-stat" aria-label={`${indicators.git.additions} lines added, ${indicators.git.deletions} lines deleted`}>
                <span className="git-additions">+{indicators.git.additions}</span>
                <span className="git-deletions">−{indicators.git.deletions}</span>
              </span>
            )}
            <div className="settings-control" ref={settingsControlRef}>
              <button
                className="icon-button header-settings"
                aria-label="Forge settings"
                aria-haspopup="menu"
                aria-expanded={settingsOpen}
                onClick={() => {
                  setSettingsOpen((open) => !open);
                  setRestartError(undefined);
                }}
              >
                <Icon icon={settingsIcon} width={18} />
              </button>
              {settingsOpen && (
                <div className="settings-popover" role="menu" aria-label="Forge settings">
                  <div className="settings-popover-heading">
                    <strong>Forge runtime</strong>
                    <span>{snapshot.connection === "connected" ? "Connected" : "Reconnecting"}</span>
                  </div>
                  <button
                    type="button"
                    className="settings-restart"
                    role="menuitem"
                    disabled={restartState === "restarting"}
                    onClick={() => void restartForge()}
                  >
                    <span>{restartState === "restarting" ? "Restarting Forge…" : "Restart Forge"}</span>
                    <small>Stops the backend, then reconnects through systemd.</small>
                  </button>
                  {restartError && <p className="settings-error" role="alert">{restartError}</p>}
                </div>
              )}
            </div>
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
            <Timeline
              key={activeSession.id}
              session={activeSession}
              entries={timeline}
              loading={snapshot.hydratingSessionIds.includes(activeSession.id)}
              onSuggestion={sendSuggestion}
            />

            <InteractionPanel requests={pendingInteractions} onRespond={anvilClient.respondToInteraction} />

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
              contextUsage={indicators.context}
              attachments={composerAttachments[activeSession.id] ?? []}
              onAttachFiles={attachFiles}
              onRemoveAttachment={removeAttachment}
              onSearchFiles={anvilClient.searchFiles}
              onCancel={anvilClient.cancelActiveRun}
              onDraftConsumed={anvilClient.clearComposerDraft}
              onPromptChange={updateDraft}
              onModelChange={anvilClient.setModel}
              onThinkingLevelChange={anvilClient.setThinkingLevel}
              onSend={sendComposerPrompt}
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

      <div className="completion-toasts" aria-live="polite" aria-atomic="false">
        {completionToasts.map((toast) => (
          <div className="completion-toast" role="status" key={toast.id}>
            <span className="completion-toast-mark" aria-hidden="true" />
            <button
              type="button"
              className="completion-toast-copy"
              onClick={() => {
                anvilClient.selectSession(toast.sessionId);
                anvilClient.markSessionRead(toast.sessionId);
                setCompletionToasts((current) => current.filter((candidate) => candidate.id !== toast.id));
              }}
            >
              <strong>Thread completed</strong>
              <span>{toast.title}</span>
            </button>
            <button
              type="button"
              className="completion-toast-dismiss"
              aria-label={`Dismiss completion notification for ${toast.title}`}
              onClick={() => setCompletionToasts((current) => current.filter((candidate) => candidate.id !== toast.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

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
