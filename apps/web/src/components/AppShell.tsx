import {
  isGeneralProject,
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
  DatabaseSettingIcon,
  Folder01Icon,
  Moon02Icon,
  RefreshIcon,
  ServerStack01Icon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { type Accent, useTheme } from "@/components/theme-provider";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { anvilClient, type DeliveryMode } from "../lib/anvilClient";
import {
  isTerminalInputTarget,
  isTerminalToggleShortcut,
  threadCycleShortcut,
  threadNumberShortcutIndex,
} from "../lib/keyboardScope";
import { cycledThreadTarget, numberedThreadTarget } from "../lib/threadNavigation";
import { isWorkspaceSidePaneVisible, projectResourceForCloseShortcut, shouldAutoOpenProjectResource } from "../lib/workspace";
import { equalAppShellSnapshots, selectAppShellSnapshot } from "../lib/appShellSnapshot";
import { subagentActivityForSession } from "../lib/subagentActivity";
import { matchesShortcut } from "../lib/shortcuts";
import { useExternalStoreSelector } from "../lib/useExternalStoreSelector";
import { Composer, type ComposerAttachment, type ComposerProps, updateComposerDraft } from "./Composer";
import { DesktopUpdateDialog, isOcodeDesktop } from "./DesktopUpdateDialog";
import { InteractionPanel } from "./InteractionDialog";
import { InternalSessionFooter } from "./InternalSessionFooter";
import { FilePickerDialog } from "./FilePickerDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectGitAction } from "./ProjectGitAction";
import { Sidebar } from "./Sidebar";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Timeline } from "./Timeline";
import { UsageDialog } from "./UsageDialog";
import { ProjectResourceSurface } from "./resource/ProjectResourceSurface";
import { ProjectTerminalSurface } from "./terminal/ProjectTerminalSurface";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout";
import { WorkspaceSurfaceProvider, useWorkspaceSurfaces } from "./workspace/WorkspaceSurfaceState";
import { DeleteThreadDialog, ManageProjectsDialog, ProjectsRootDialog, RenameThreadDialog } from "./WorkspaceDialogs";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };
const DISPLAY_PREFERENCES_KEY = "ocode.display-preferences";
const LEGACY_DISPLAY_PREFERENCES_KEY = "anvil.display-preferences";

type MessageFontSize = "small" | "default" | "large" | "extra-large";
type MessageWidth = "narrow" | "full";

type DisplayPreferences = {
  fontSize: MessageFontSize;
  width: MessageWidth;
};

const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = { fontSize: "default", width: "narrow" };
const ACCENT_OPTIONS: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: "neutral", label: "Neutral", swatch: "bg-neutral-300 dark:bg-neutral-200" },
  { value: "blue", label: "Blue", swatch: "bg-blue-400" },
  { value: "cyan", label: "Cyan", swatch: "bg-cyan-400" },
  { value: "emerald", label: "Emerald", swatch: "bg-emerald-400" },
  { value: "amber", label: "Amber", swatch: "bg-amber-400" },
  { value: "rose", label: "Rose", swatch: "bg-rose-400" },
  { value: "pink", label: "Pink", swatch: "bg-pink-400" },
  { value: "purple", label: "Purple", swatch: "bg-purple-400" },
];

function loadDisplayPreferences(): DisplayPreferences {
  try {
    const canonical = localStorage.getItem(DISPLAY_PREFERENCES_KEY);
    const legacy = canonical === null ? localStorage.getItem(LEGACY_DISPLAY_PREFERENCES_KEY) : null;
    if (legacy !== null) {
      try {
        localStorage.setItem(DISPLAY_PREFERENCES_KEY, legacy);
      } catch {
        // Continue using the legacy preferences when migration storage is unavailable.
      }
    }
    const stored = JSON.parse(canonical ?? legacy ?? "null") as Partial<DisplayPreferences> | null;
    return {
      fontSize: stored?.fontSize && ["small", "default", "large", "extra-large"].includes(stored.fontSize) ? stored.fontSize : "default",
      width: stored?.width && ["narrow", "full"].includes(stored.width) ? stored.width : "narrow",
    };
  } catch {
    return DEFAULT_DISPLAY_PREFERENCES;
  }
}

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
      className="header-outline-control"
      aria-label={active ? "Hide project terminals" : "Show project terminals"}
      aria-pressed={active}
      title="Project terminal (Ctrl+`)"
      onClick={toggle}
    >
      <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
    </Button>
  );
}

function FileSurfaceToggle({ isMobile }: { isMobile: boolean }) {
  const { state, setRightVisible, openSidePage } = useWorkspaceSurfaces();
  const active = isWorkspaceSidePaneVisible(state, isMobile);
  const toggle = () => {
    if (active) setRightVisible(false);
    else openSidePage("files");
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          className="header-outline-control"
          aria-label={active ? "Close side pane" : "Show files"}
          aria-pressed={active}
          onClick={toggle}
        >
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{active ? "Close side pane" : "Files"}</TooltipContent>
    </Tooltip>
  );
}

function WorkspaceComposer(props: Omit<ComposerProps, "onOpenSubagents">) {
  const { openSidePage } = useWorkspaceSurfaces();
  return <Composer {...props} onOpenSubagents={() => openSidePage("agents")} />;
}

function FileCloseShortcut({ isMobile }: { isMobile: boolean }) {
  const { state, closeProjectResource } = useWorkspaceSurfaces();

  useEffect(() => {
    const closeActiveFile = (event: KeyboardEvent) => {
      if (isTerminalInputTarget(event.target) || !matchesShortcut(event, "closeThread")) return;
      const activeFile = projectResourceForCloseShortcut(state, isMobile);
      if (!activeFile) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeProjectResource(activeFile.id);
    };
    window.addEventListener("keydown", closeActiveFile, true);
    return () => window.removeEventListener("keydown", closeActiveFile, true);
  }, [closeProjectResource, isMobile, state]);

  return null;
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
      mobileResourceTitle={state.sidePage === "agents" ? "Agents" : "Files"}
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
  const { theme, setTheme, accent, setAccent } = useTheme();
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = useState<Record<string, ComposerAttachment[]>>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [manageProjectsDialogOpen, setManageProjectsDialogOpen] = useState(false);
  const [projectsRootDialogOpen, setProjectsRootDialogOpen] = useState(false);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [usageDialogOpen, setUsageDialogOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const [sessionPendingRename, setSessionPendingRename] = useState<{ id: string; title: string } | null>(null);
  const [indicators, setIndicators] = useState<LiveIndicators>({});
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [desktopUpdateDialogOpen, setDesktopUpdateDialogOpen] = useState(false);
  const [rebuildState, setRebuildState] = useState<"idle" | "rebuilding">("idle");
  const [rebuildError, setRebuildError] = useState<string>();
  const [displayPreferences, setDisplayPreferences] = useState(loadDisplayPreferences);
  const gitIndicatorsByProject = useRef(new Map<string, LiveIndicators["git"]>());
  const terminalSequences = useRef<Map<string, number> | null>(null);
  const completionSound = useRef<HTMLAudioElement | null>(null);
  const activeSession = snapshot.workspaceLocation?.sessionId
    ? snapshot.sessions.find((session) => session.id === snapshot.workspaceLocation?.sessionId)
    : undefined;
  const activeProject = snapshot.projects.find(
    (project) => project.id === snapshot.workspaceLocation?.projectId,
  );
  const activeProjectIsGeneral = isGeneralProject(activeProject);
  const desktopClient = isOcodeDesktop();
  const activeSessionPending = activeSession
    ? anvilClient.isSessionPending(activeSession.id)
    : false;
  const activeSessionCreationError = activeSession
    ? anvilClient.getSessionCreationError(activeSession.id)
    : undefined;
  const ordinarySessions = useMemo(() => snapshot.sessions.filter((session) => !session.internal), [snapshot.sessions]);
  const timeline = activeSession ? snapshot.timelines[activeSession.id] ?? [] : [];
  const durableSubagentRuns = activeSession ? snapshot.subagentRuns[activeSession.id] ?? [] : [];
  const subagents = useMemo(
    () => subagentActivityForSession(durableSubagentRuns, timeline),
    [durableSubagentRuns, timeline],
  );
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
    sessions: ordinarySessions,
    activeSessionId: activeSession?.internal ? null : snapshot.activeSessionId,
    connection: snapshot.connection,
  }), [
    snapshot.projects,
    ordinarySessions,
    activeSession?.internal,
    snapshot.activeSessionId,
    snapshot.connection,
  ]);
  useEffect(() => {
    localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(displayPreferences));
  }, [displayPreferences]);

  const sendSuggestion = useCallback((prompt: string) => anvilClient.sendPrompt(prompt), []);
  const openNewProject = useCallback(() => setNewProjectOpen(true), []);
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
      (target ?? document.querySelector<HTMLButtonElement>("[aria-label='New project']"))?.focus();
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
    document.title = activeSession?.title ? `${activeSession.title} · ocode` : "ocode";
  }, [activeSession?.title]);

  useEffect(() => setFilePickerOpen(false), [activeProject?.id, activeSession?.id]);

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

      try {
        const audio = completionSound.current ?? new Audio("/sounds/thread-complete.mp3");
        completionSound.current = audio;
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      } catch {
        // Audio can be unavailable or blocked until the user interacts with the page.
      }

      if (document.visibilityState !== "visible" || !document.hasFocus()) {
        if ("Notification" in window && Notification.permission === "granted") {
          const notification = new Notification("Thread completed", {
            body: session.title,
            icon: "/favicon.svg",
            tag: `ocode-completed-${session.id}`,
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
      if (matchesShortcut(event, "openFile")) {
        event.preventDefault();
        if (activeProject && activeSession) setFilePickerOpen(true);
        else toast.info("Select a thread to browse project files");
        return;
      }
      if (matchesShortcut(event, "settings")) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (isTerminalInputTarget(event.target)) return;
      if (matchesShortcut(event, "newThread")) {
        event.preventDefault();
        window.dispatchEvent(new Event("ocode:new-thread"));
        return;
      }
      if (matchesShortcut(event, "closeThread")) {
        event.preventDefault();
        if (activeSession?.internal && activeSession.parentSessionId) anvilClient.selectSession(activeSession.parentSessionId);
        else if (activeSession) requestDeleteSession(activeSession.id);
        return;
      }
      const threadIndex = threadNumberShortcutIndex(event);
      if (threadIndex !== undefined) {
        const target = numberedThreadTarget(sortSessionsByActivity(ordinarySessions), threadIndex);
        if (target) {
          event.preventDefault();
          anvilClient.selectSession(target.id);
          if (isMobile) setOpenMobile(false);
        }
        return;
      }

      const cycleDirection = threadCycleShortcut(event);
      if (cycleDirection) {
        const target = cycledThreadTarget(
          sortSessionsByActivity(ordinarySessions),
          activeProject?.id,
          snapshot.activeSessionId,
          cycleDirection,
        );
        if (target) {
          event.preventDefault();
          anvilClient.selectSession(target.id);
          if (isMobile) setOpenMobile(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProject, activeSession, isMobile, ordinarySessions, requestDeleteSession, setOpenMobile, snapshot.activeSessionId]);

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
        onNewProject={openNewProject}
        usage={indicators.usage}
        onRequestDeleteSession={requestDeleteSession}
        onRequestRenameSession={requestRenameSession}
        onSetSessionSettled={anvilClient.setSessionSettled}
        onMarkSessionRead={anvilClient.markSessionRead}
        onMarkSessionUnread={anvilClient.markSessionUnread}
      />

      <SidebarInset className="workspace">
        <WorkspaceSurfaceProvider projectId={activeProject?.id ?? null}>
          <LiveProjectResourceAutoOpen />
          {activeProject && activeSession && (
            <FilePickerDialog
              open={filePickerOpen}
              projectId={activeProject.id}
              sessionId={activeSession.id}
              onOpenChange={setFilePickerOpen}
              onSearchFiles={anvilClient.searchFiles}
            />
          )}
          {activeProject && <FileCloseShortcut isMobile={isMobile} />}
          {activeProject && <TerminalShortcut isMobile={isMobile} />}
          <ProjectWorkspace
            isMobile={isMobile}
            bottom={activeProject ? <ProjectTerminalSurface key={activeProject.id} projectId={activeProject.id} isMobile={isMobile} /> : undefined}
            right={activeProject ? (
              <ProjectResourceSurface
                projectId={activeProject.id}
                subagents={subagents}
                connection={snapshot.connection}
                subagentsLoading={activeSession ? snapshot.hydratingSessionIds.includes(activeSession.id) : false}
                childSessions={activeSession ? snapshot.sessions.filter((session) => session.internal && session.parentSessionId === activeSession.id) : []}
                childTimelines={snapshot.timelines}
                hydratingChildSessionIds={activeSession ? snapshot.hydratingSessionIds.filter((id) => id !== activeSession.id) : []}
                onCancelSubagent={(runId) => activeSession ? anvilClient.cancelSubagent(activeSession.id, runId) : Promise.resolve()}
                onLoadSubagentChild={(item) => activeSession ? anvilClient.loadSubagentSession(activeSession.id, item.id) : Promise.reject(new Error("No active parent session"))}
              />
            ) : undefined}
            main={<div
              className="conversation-surface"
              data-message-font-size={displayPreferences.fontSize}
              data-message-width={displayPreferences.width}
            >
        <header className="session-header" data-tauri-drag-region="deep">
          <div className="header-title-group">
            <SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar" />
            <div className="session-heading">
              <h1>
                {activeSession ? (
                  <><span className="session-heading-repo">{activeProjectIsGeneral ? "General · ~/" : activeProject?.name.toLowerCase() ?? "unknown"}</span> / {activeSession.title}</>
                ) : activeProject ? activeProjectIsGeneral ? "General · ~/" : activeProject.name : "No project selected"}
              </h1>
            </div>
          </div>

          <div className="header-actions">
            {activeProject && !activeProjectIsGeneral && (
              <ProjectGitAction
                key={activeProject.id}
                projectId={activeProject.id}
                projectName={activeProject.name}
                sessionId={activeSession?.id}
                onComplete={markGitActionComplete}
              />
            )}
            {activeProject && <TerminalSurfaceToggle isMobile={isMobile} />}
            {activeProject && <FileSurfaceToggle isMobile={isMobile} />}
            <DropdownMenu
              open={settingsOpen}
              onOpenChange={(open) => {
                setSettingsOpen(open);
                if (open) setRebuildError(undefined);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="header-outline-control" aria-label="Forge settings">
                  <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Forge runtime</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {theme === "dark" ? <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} /> : theme === "light" ? <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} /> : <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />}
                    Display
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuLabel>Theme</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as "system" | "light" | "dark")}>
                      <DropdownMenuRadioItem value="system"><HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />System</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="light"><HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />Light</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark"><HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />Dark</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Accent</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={accent} onValueChange={(value) => setAccent(value as Accent)}>
                      {ACCENT_OPTIONS.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value}>
                          <span className={`size-2.5 rounded-full ring-1 ring-black/10 ${option.swatch}`} aria-hidden="true" />
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Text size</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={displayPreferences.fontSize}
                      onValueChange={(fontSize) => setDisplayPreferences((current) => ({ ...current, fontSize: fontSize as MessageFontSize }))}
                    >
                      <DropdownMenuRadioItem value="small">Small</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="large">Large</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="extra-large">Extra large</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Message width</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={displayPreferences.width}
                      onValueChange={(width) => setDisplayPreferences((current) => ({ ...current, width: width as MessageWidth }))}
                    >
                      <DropdownMenuRadioItem value="narrow">Normal</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="full">Full</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShortcutsDialogOpen(true)}>
                  <span className="text-base leading-none" aria-hidden="true">⌨</span>
                  Keyboard shortcuts
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setUsageDialogOpen(true)}>
                  <HugeiconsIcon icon={DatabaseSettingIcon} strokeWidth={2} />
                  Usage
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
                    Projects
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onSelect={() => setManageProjectsDialogOpen(true)}>Manage projects</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setProjectsRootDialogOpen(true)}>Projects root</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                    Maintenance
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {desktopClient && (
                      <DropdownMenuItem onSelect={() => setDesktopUpdateDialogOpen(true)}>
                        <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
                        Desktop updates
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={rebuildState === "rebuilding"}
                      onSelect={() => setRebuildDialogOpen(true)}
                    >
                      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                      Rebuild web app
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
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

            {activeSession.internal ? (
              <InternalSessionFooter
                onReturn={activeSession.parentSessionId ? () => anvilClient.selectSession(activeSession.parentSessionId!) : undefined}
              />
            ) : (
            <WorkspaceComposer
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
              subagentsLoading={snapshot.hydratingSessionIds.includes(activeSession.id)}
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
            )}
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
                  : "Create a project with the + in the sidebar."}
              </p>
            </div>
          </div>
        )}
            </div>}
          />
        </WorkspaceSurfaceProvider>
      </SidebarInset>

      <ShortcutsDialog open={shortcutsDialogOpen} onOpenChange={setShortcutsDialogOpen} />
      <UsageDialog open={usageDialogOpen} onOpenChange={setUsageDialogOpen} />
      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          onCreate={anvilClient.createProject}
          onClone={anvilClient.cloneProject}
          onAddExisting={anvilClient.addExistingProject}
          listGitHubRepositories={anvilClient.listGitHubRepositories}
          getProjectsRoot={anvilClient.getProjectsRoot}
        />
      )}
      {manageProjectsDialogOpen && (
        <ManageProjectsDialog
          projects={snapshot.projects}
          sessions={snapshot.sessions}
          onClose={() => setManageProjectsDialogOpen(false)}
          onRemove={async (projectId) => {
            const project = anvilClient.getSnapshot().projects.find((candidate) => candidate.id === projectId);
            await anvilClient.deleteProject(projectId);
            toast.success("Project removed from ocode", {
              description: project ? `${project.name} · Workspace files remain on disk.` : "Workspace files remain on disk.",
            });
          }}
        />
      )}
      {projectsRootDialogOpen && (
        <ProjectsRootDialog
          onClose={() => setProjectsRootDialogOpen(false)}
          onGet={anvilClient.getProjectsRoot}
          onSave={async (path) => {
            const saved = await anvilClient.setProjectsRoot(path);
            toast.success("Projects root updated", { description: saved });
            return saved;
          }}
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
      {desktopClient && (
        <DesktopUpdateDialog open={desktopUpdateDialogOpen} onOpenChange={setDesktopUpdateDialogOpen} />
      )}
      <AlertDialog open={rebuildDialogOpen} onOpenChange={(open) => !open && rebuildState !== "rebuilding" && setRebuildDialogOpen(false)}>
        <AlertDialogContent onEscapeKeyDown={(event) => rebuildState === "rebuilding" && event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild the web app?</AlertDialogTitle>
            <AlertDialogDescription>
              This builds the latest React changes and reloads the updated interface. Running threads will not be interrupted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rebuildError && <p className="text-xs text-destructive" role="alert">{rebuildError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebuildState === "rebuilding"}>Cancel</AlertDialogCancel>
            <Button disabled={rebuildState === "rebuilding"} onClick={() => void rebuildWebApp()}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
              {rebuildState === "rebuilding" ? "Rebuilding…" : "Rebuild"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
