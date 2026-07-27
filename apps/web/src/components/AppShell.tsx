import {
  resolveProjectResourceReference,
  type ArtifactReference,
  type CapabilityCatalog,
  type ProjectResourceContentBlock,
  type SessionSummary,
  type TimelineEntry,
} from "@anvil/protocol";
import { sortSessionsByActivity } from "@anvil/state";
import {
  Cancel01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Moon02Icon,
  RefreshIcon,
  ServerStack01Icon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useTheme } from "@/components/theme-provider";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { anvilClient, type DeliveryMode } from "../lib/anvilClient";
import { isTerminalInputTarget, isTerminalToggleShortcut } from "../lib/keyboardScope";
import { shouldAutoOpenProjectResource } from "../lib/workspace";
import { equalAppShellSnapshots, selectAppShellSnapshot } from "../lib/appShellSnapshot";
import { subagentActivityForSession } from "../lib/subagentActivity";
import { useExternalStoreSelector } from "../lib/useExternalStoreSelector";
import { Composer, type ComposerAttachment, updateComposerDraft } from "./Composer";
import { InteractionPanel } from "./InteractionDialog";
import { ProjectGitAction } from "./ProjectGitAction";
import { Sidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { ProjectResourceSurface } from "./resource/ProjectResourceSurface";
import { ProjectTerminalSurface } from "./terminal/ProjectTerminalSurface";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout";
import { WorkspaceSurfaceProvider, useWorkspaceSurfaces } from "./workspace/WorkspaceSurfaceState";
import { AddWorkspaceDialog, DeleteThreadDialog, RenameThreadDialog } from "./WorkspaceDialogs";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };

type LiveIndicators = {
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  git?: { additions: number; deletions: number };
  usage?: {
    fiveHour?: { usedPercent: number; resetAt?: number };
    weekly?: { usedPercent: number; resetAt?: number };
  };
};

function TimelineWithResources({ session, entries, loading, onSuggestion }: {
  session: SessionSummary;
  entries: TimelineEntry[];
  loading: boolean;
  onSuggestion: (prompt: string) => void;
}) {
  const { openProjectResource } = useWorkspaceSurfaces();
  return (
    <Timeline
      session={session}
      entries={entries}
      loading={loading}
      onSuggestion={onSuggestion}
      onOpenProjectResource={(block: ProjectResourceContentBlock) => {
        openProjectResource(resolveProjectResourceReference(block, session), "timeline");
      }}
    />
  );
}

function LiveProjectResourceAutoOpen() {
  const { openProjectResource } = useWorkspaceSurfaces();
  const consumed = useRef(new Set<string>());
  useEffect(() => anvilClient.subscribeProjectResourceCompletions((completion) => {
    const snapshot = anvilClient.getSnapshot();
    if (!shouldAutoOpenProjectResource(completion.sessionId, snapshot.workspaceLocation)) return;
    const session = snapshot.sessions.find((candidate) => candidate.id === completion.sessionId);
    if (!session) return;
    for (const block of completion.blocks) {
      const key = `${completion.sessionId}:${completion.toolCallId}:${block.id}`;
      if (consumed.current.has(key)) continue;
      consumed.current.add(key);
      openProjectResource(resolveProjectResourceReference(block, session), "tool");
    }
  }), [openProjectResource]);
  return null;
}

function TerminalSurfaceToggle({ isMobile }: { isMobile: boolean }) {
  const { state, setBottomVisible, setMobileSurface } = useWorkspaceSurfaces();
  const active = isMobile ? state.mobileSurface === "terminal" : state.bottomVisible;
  const toggle = () => {
    if (isMobile) setMobileSurface(active ? "conversation" : "terminal");
    else setBottomVisible(!state.bottomVisible);
  };
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-label={active ? "Hide project terminals" : "Show project terminals"}
      aria-pressed={active}
      title="Project terminal (Ctrl+`)"
      onClick={toggle}
    >
      <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
    </Button>
  );
}

function TerminalShortcut({ isMobile }: { isMobile: boolean }) {
  const { state, setBottomVisible, setMobileSurface } = useWorkspaceSurfaces();

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent) => {
      if (!isTerminalToggleShortcut(event)) return;
      event.preventDefault();
      if (isMobile) setMobileSurface(state.mobileSurface === "terminal" ? "conversation" : "terminal");
      else setBottomVisible(!state.bottomVisible);
    };
    window.addEventListener("keydown", toggleTerminal);
    return () => window.removeEventListener("keydown", toggleTerminal);
  }, [isMobile, setBottomVisible, setMobileSurface, state.bottomVisible, state.mobileSurface]);

  return null;
}

function ProjectWorkspace({
  main,
  bottom,
  right,
  isMobile,
}: {
  main: ReactNode;
  bottom?: ReactNode;
  right?: ReactNode;
  isMobile: boolean;
}) {
  const { state, setMobileSurface } = useWorkspaceSurfaces();
  return (
    <WorkspaceLayout
      isMobile={isMobile}
      main={main}
      bottom={state.bottomVisible ? bottom : undefined}
      right={state.rightVisible ? right : undefined}
      mobileSurface={state.mobileSurface}
      onMobileSurfaceChange={setMobileSurface}
    />
  );
}

export function AppShell() {
  return (
    <SidebarProvider
      defaultOpen
      className="h-full min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "17.625rem" } as CSSProperties}
    >
      <AppShellContent />
    </SidebarProvider>
  );
}

function AppShellContent() {
  const snapshot = useExternalStoreSelector(
    anvilClient.subscribe,
    anvilClient.getSnapshot,
    selectAppShellSnapshot,
    equalAppShellSnapshots,
  );
  const { isMobile, setOpenMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = useState<Record<string, ComposerAttachment[]>>({});
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const [sessionPendingRename, setSessionPendingRename] = useState<{ id: string; title: string } | null>(null);
  const [indicators, setIndicators] = useState<LiveIndicators>({});
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [rebuildState, setRebuildState] = useState<"idle" | "rebuilding">("idle");
  const [rebuildError, setRebuildError] = useState<string>();
  const gitIndicatorsByProject = useRef(new Map<string, LiveIndicators["git"]>());
  const terminalSequences = useRef<Map<string, number> | null>(null);
  const activeSession = snapshot.workspaceLocation?.sessionId
    ? snapshot.sessions.find((session) => session.id === snapshot.workspaceLocation?.sessionId)
    : undefined;
  const activeProject = snapshot.projects.find(
    (project) => project.id === snapshot.workspaceLocation?.projectId,
  );
  const activeSessionPending = activeSession
    ? anvilClient.isSessionPending(activeSession.id)
    : false;
  const activeSessionCreationError = activeSession
    ? anvilClient.getSessionCreationError(activeSession.id)
    : undefined;
  const timeline = activeSession ? snapshot.timelines[activeSession.id] ?? [] : [];
  const subagents = useMemo(() => subagentActivityForSession(timeline), [timeline]);
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
  const openAddWorkspace = useCallback(() => setAddWorkspaceOpen(true), []);
  const requestDeleteSession = useCallback((sessionId: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session) setSessionPendingDeletion({ id: session.id, title: session.title });
  }, [snapshot.sessions]);
  const requestRenameSession = useCallback((sessionId: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session) setSessionPendingRename({ id: session.id, title: session.title });
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
    if (isMobile) setOpenMobile(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message Pi']")?.focus();
    });
  }, [isMobile, setOpenMobile]);
  const markGitActionComplete = useCallback(() => {
    const projectId = activeProject?.id;
    if (!projectId) return;
    const git = { additions: 0, deletions: 0 };
    gitIndicatorsByProject.current.set(projectId, git);
    setIndicators((current) => ({ ...current, git }));
  }, [activeProject?.id]);
  const rebuildWebApp = useCallback(async () => {
    setRebuildState("rebuilding");
    setRebuildError(undefined);
    try {
      await anvilClient.rebuildWebApp();
      setRebuildDialogOpen(false);
      toast.success("Web app rebuilt", { description: "Reloading the updated interface…" });
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      setRebuildError(error instanceof Error ? error.message : String(error));
    } finally {
      setRebuildState("idle");
    }
  }, []);
  const closeRenameDialog = () => {
    const sessionId = sessionPendingRename?.id;
    setSessionPendingRename(null);
    if (!sessionId) return;
    requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>("[data-session-id]"))
        .find((element) => element.dataset.sessionId === sessionId)
        ?.focus();
    });
  };
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

      toast.success("Thread completed", {
        id: `completed-${session.id}`,
        description: session.title,
        duration: 8_000,
        action: {
          label: "View",
          onClick: () => {
            anvilClient.selectSession(session.id);
            anvilClient.markSessionRead(session.id);
          },
        },
      });
    }
  }, [snapshot.sessions]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTerminalInputTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const projectId = activeProject?.id ??
          (snapshot.projects.length === 1 ? snapshot.projects[0]?.id : undefined);
        if (projectId) startSession(projectId);
      }
      const threadShortcut = /^Digit([1-9])$/.exec(event.code);
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && threadShortcut) {
        event.preventDefault();
        const threadIndex = Number(threadShortcut[1]) - 1;
        const target = sortSessionsByActivity(snapshot.sessions).filter(
          (session) => !session.settled,
        )[threadIndex];
        if (target) {
          anvilClient.selectSession(target.id);
          if (isMobile) setOpenMobile(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProject, isMobile, setOpenMobile, snapshot.projects, snapshot.sessions, startSession]);

  if (!snapshot.workspaceLocation && snapshot.connection !== "connected") {
    return (
      <main className="app-loading" role="status" aria-live="polite">
        <span className="forge-spinner" aria-hidden="true" />
        <span className="sr-only">Connecting to Forge</span>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        snapshot={sidebarSnapshot}
        onSelectSession={anvilClient.selectSession}
        onCreateSession={startSession}
        onAddWorkspace={openAddWorkspace}
        usage={indicators.usage}
        onRequestDeleteSession={requestDeleteSession}
        onRequestRenameSession={requestRenameSession}
        onSetSessionSettled={anvilClient.setSessionSettled}
      />

      <SidebarInset className="workspace">
        <WorkspaceSurfaceProvider projectId={activeProject?.id ?? null}>
          <LiveProjectResourceAutoOpen />
          {activeProject && <TerminalShortcut isMobile={isMobile} />}
          <ProjectWorkspace
            isMobile={isMobile}
            bottom={activeProject ? <ProjectTerminalSurface key={activeProject.id} projectId={activeProject.id} isMobile={isMobile} /> : undefined}
            right={activeProject ? <ProjectResourceSurface projectId={activeProject.id} /> : undefined}
            main={<div className="conversation-surface">
        <header className="session-header">
          <div className="header-title-group">
            <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
            <div className="session-heading">
              <h1>
                {activeSession ? (
                  <><span className="session-heading-repo">{activeProject?.name.toLowerCase() ?? "unknown"}</span> / {activeSession.title}</>
                ) : activeProject ? activeProject.name : "No workspace selected"}
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
            {activeProject && (
              <ProjectGitAction
                key={activeProject.id}
                projectId={activeProject.id}
                sessionId={activeSession?.id}
                onComplete={markGitActionComplete}
              />
            )}
            {activeProject && <TerminalSurfaceToggle isMobile={isMobile} />}
            <Button
              ref={settingsTrigger}
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              onClick={openSettings}
            >
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
            </Button>
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
          <div className="reconciliation-banner reconciliation-banner--dismissible" role="alert">
            <span>Forge command failed · {snapshot.clientError}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="reconciliation-banner-dismiss"
              aria-label="Dismiss Forge error"
              onClick={anvilClient.clearClientError}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </div>
        )}

        {activeSession ? (
          <>
            <TimelineWithResources
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
              modelsReady={activeCatalog.modelsReady ?? activeCatalog.models.length > 0}
              commands={activeCatalog.commands}
              skills={activeCatalog.skills}
              queue={snapshot.queues[activeSession.id] ?? { steering: [], followUp: [] }}
              draft={snapshot.composerDrafts[activeSession.id]}
              prompt={composerDrafts[activeSession.id] ?? ""}
              pending={activeSessionPending}
              creationError={activeSessionCreationError}
              widgets={widgets}
              contextUsage={indicators.context}
              workspaceKind={activeProject?.workspaceKind}
              subagents={subagents}
              attachments={composerAttachments[activeSession.id] ?? []}
              onAttachFiles={attachFiles}
              onRemoveAttachment={removeAttachment}
              onSearchFiles={anvilClient.searchFiles}
              onCancel={anvilClient.cancelActiveRun}
              onDraftConsumed={anvilClient.clearComposerDraft}
              onPromptChange={updateDraft}
              onModelChange={(modelId) => anvilClient.setModel(activeSession.id, modelId)}
              onThinkingLevelChange={(level) => anvilClient.setThinkingLevel(activeSession.id, level)}
              onSend={sendComposerPrompt}
            />
          </>
        ) : (
          <div className="app-loading app-loading--workspace">
            <div className="empty-workspace">
              <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} className="size-6" />
              <strong>{activeProject ? "No thread selected" : "No threads yet"}</strong>
              <p>
                {snapshot.projects.length > 0
                  ? activeProject
                    ? `Choose an existing thread, or use the + beside Threads to start one in ${activeProject.name}.`
                    : "Filter the thread list by project, then use the + beside Threads to start a thread."
                  : "Add a workspace with the + in the sidebar."}
              </p>
            </div>
          </div>
        )}
            </div>}
          />
        </WorkspaceSurfaceProvider>
      </SidebarInset>

      {addWorkspaceOpen && (
        <AddWorkspaceDialog
          onClose={() => setAddWorkspaceOpen(false)}
          onCreate={anvilClient.createProject}
        />
      )}
      {sessionPendingRename && (
        <RenameThreadDialog
          title={sessionPendingRename.title}
          onClose={closeRenameDialog}
          onRename={(title) => anvilClient.renameSession(sessionPendingRename.id, title)}
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
