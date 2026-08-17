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
  ComputerTerminal01Icon,
  Folder01Icon,
  RefreshIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
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
import { Composer, type ComposerAttachment, updateComposerDraft } from "./Composer";
import { CommandPaletteDialog } from "./CommandPaletteDialog";
import { DesktopUpdateDialog, isOcodeDesktop } from "./DesktopUpdateDialog";
import { InteractionPanel } from "./InteractionDialog";
import { InternalSessionFooter } from "./InternalSessionFooter";
import { FilePickerDialog } from "./FilePickerDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectGitAction } from "./ProjectGitAction";
import { RecentlySettledDialog } from "./RecentlySettledDialog";
import { SettleOrDeleteThreadDialog } from "./SettleOrDeleteThreadDialog";
import { Sidebar } from "./Sidebar";
import {
  type DisplayPreferences,
  type InterfaceFont,
  SettingsPage,
} from "./SettingsPage";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Timeline } from "./Timeline";
import { UsagePage } from "./UsagePage";
import { ProjectResourceSurface } from "./resource/ProjectResourceSurface";
import { ProjectTerminalSurface } from "./terminal/ProjectTerminalSurface";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout";
import { WorkspaceSurfaceProvider, useWorkspaceSurfaces } from "./workspace/WorkspaceSurfaceState";
import { DeleteThreadDialog, ManageProjectsDialog, ProjectsRootDialog, RenameThreadDialog } from "./WorkspaceDialogs";

const EMPTY_CATALOG: CapabilityCatalog = { models: [], commands: [], skills: [] };
const DISPLAY_PREFERENCES_KEY = "ocode.display-preferences";
const LEGACY_DISPLAY_PREFERENCES_KEY = "anvil.display-preferences";

const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  fontFamily: "system",
  fontSize: "default",
  width: "narrow",
};
const INTERFACE_FONT_STACKS: Record<InterfaceFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  inter: '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  geist: '"Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};
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
      fontFamily: stored?.fontFamily && ["system", "inter", "geist"].includes(stored.fontFamily)
        ? stored.fontFamily
        : "system",
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

function TimelineWithResources({ session, projectName, entries, loading, onSuggestion, onRequestProjectChange }: {
  session: SessionSummary;
  projectName: string;
  entries: TimelineEntry[];
  loading: boolean;
  onSuggestion: (prompt: string) => void;
  onRequestProjectChange: () => void;
}) {
  const { openProjectResource } = useWorkspaceSurfaces();
  return (
    <Timeline
      session={session}
      projectName={projectName}
      entries={entries}
      loading={loading}
      onSuggestion={onSuggestion}
      onRequestProjectChange={onRequestProjectChange}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon-sm"
          className="header-outline-control"
          aria-label={active ? "Hide project terminals" : "Show project terminals"}
          aria-pressed={active}
          onClick={toggle}
        >
          <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Project terminal (Ctrl+`)</TooltipContent>
    </Tooltip>
  );
}

function FileSurfaceToggle({ isMobile }: { isMobile: boolean }) {
  const { state, setRightVisible, openSidePage } = useWorkspaceSurfaces();
  const filesActive = isWorkspaceSidePaneVisible(state, isMobile) && state.sidePage === "files";
  const toggle = () => {
    if (filesActive) setRightVisible(false);
    else openSidePage("files");
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={filesActive ? "secondary" : "ghost"}
          size="icon-sm"
          className="header-outline-control"
          aria-label={filesActive ? "Hide files" : "Show files"}
          aria-pressed={filesActive}
          onClick={toggle}
        >
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{filesActive ? "Hide files" : "Files"}</TooltipContent>
    </Tooltip>
  );
}

function SubagentSurfaceAutoOpen({
  sessionId,
  toolCallIds,
  loading,
}: {
  sessionId?: string;
  toolCallIds: readonly string[];
  loading: boolean;
}) {
  const { state, openSidePage } = useWorkspaceSurfaces();
  const seenBySession = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (!sessionId) return;
    const current = new Set(toolCallIds);
    const seen = seenBySession.current.get(sessionId);
    seenBySession.current.set(sessionId, current);
    if (!seen || loading || !toolCallIds.some((id) => !seen.has(id))) return;
    if (!state.agentsTabOpen || !state.rightVisible || state.sidePage !== "agents") {
      openSidePage("agents");
    }
  }, [loading, openSidePage, sessionId, state.agentsTabOpen, state.rightVisible, state.sidePage, toolCallIds]);

  return null;
}

function FileCloseShortcut({ isMobile }: { isMobile: boolean }) {
  const { state, closeAgentsTab, closeGitTab, closeProjectResource } = useWorkspaceSurfaces();

  useEffect(() => {
    const closeActiveSideTab = (event: KeyboardEvent) => {
      if (isTerminalInputTarget(event.target) || !matchesShortcut(event, "closeThread")) return;
      const sidePaneVisible = isMobile ? state.mobileSurface === "resource" : state.rightVisible;
      const agentsActive = sidePaneVisible && state.sidePage === "agents" && state.agentsTabOpen;
      const gitActive = sidePaneVisible && state.sidePage === "git" && state.gitTabOpen;
      const activeFile = agentsActive || gitActive ? undefined : projectResourceForCloseShortcut(state, isMobile);
      if (!agentsActive && !gitActive && !activeFile) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (agentsActive) closeAgentsTab();
      else if (gitActive) closeGitTab();
      else if (activeFile) closeProjectResource(activeFile.id);
    };
    window.addEventListener("keydown", closeActiveSideTab, true);
    return () => window.removeEventListener("keydown", closeActiveSideTab, true);
  }, [closeAgentsTab, closeGitTab, closeProjectResource, isMobile, state]);

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
      mobileResourceTitle={state.sidePage === "agents" ? "Agents" : state.sidePage === "git" ? "GitHub" : "Files"}
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
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activePage = pathname === "/settings" ? "settings" : pathname === "/usage" ? "usage" : "workspace";
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = useState<Record<string, ComposerAttachment[]>>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [manageProjectsDialogOpen, setManageProjectsDialogOpen] = useState(false);
  const [projectsRootDialogOpen, setProjectsRootDialogOpen] = useState(false);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [projectChooserMode, setProjectChooserMode] = useState<"new" | "change" | null>(null);
  const [recentlySettledOpen, setRecentlySettledOpen] = useState(false);
  const [sessionPendingClose, setSessionPendingClose] = useState<{ id: string; title: string } | null>(null);
  const [sessionPendingDeletion, setSessionPendingDeletion] = useState<{ id: string; title: string } | null>(null);
  const [sessionPendingRename, setSessionPendingRename] = useState<{ id: string; title: string } | null>(null);
  const [indicators, setIndicators] = useState<LiveIndicators>({});
  const [gitStatusGeneration, setGitStatusGeneration] = useState(0);
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
    document.documentElement.style.setProperty(
      "--font-sans",
      INTERFACE_FONT_STACKS[displayPreferences.fontFamily],
    );
  }, [displayPreferences]);

  const sendSuggestion = useCallback((prompt: string) => anvilClient.sendPrompt(prompt), []);
  const openNewProject = useCallback(() => setNewProjectOpen(true), []);
  const requestCloseSession = useCallback((sessionId: string) => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (session) setSessionPendingClose({ id: session.id, title: session.title });
  }, [snapshot.sessions]);
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
  const selectSession = useCallback((sessionId: string) => {
    anvilClient.selectSession(sessionId);
    void navigate({ to: "/" });
  }, [navigate]);
  const startSession = useCallback((projectId: string) => {
    anvilClient.createSession(projectId);
    void navigate({ to: "/" });
    if (isMobile) setOpenMobile(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message Pi']")?.focus();
    });
  }, [isMobile, navigate, setOpenMobile]);
  const changeEmptySessionProject = useCallback((projectId: string) => {
    if (!activeSession || projectId === activeProject?.id) return;
    const latestTimeline = anvilClient.getSnapshot().timelines[activeSession.id] ?? [];
    if (latestTimeline.length > 0) {
      toast.error("Project can’t be changed", { description: "This thread is no longer empty." });
      return;
    }

    const previousSessionId = activeSession.id;
    startSession(projectId);
    setComposerDrafts((current) => {
      const { [previousSessionId]: _removed, ...remaining } = current;
      return remaining;
    });
    setComposerAttachments((current) => {
      const { [previousSessionId]: _removed, ...remaining } = current;
      return remaining;
    });
    void anvilClient.deleteSession(previousSessionId).catch((error) => {
      toast.error("Project changed, but the old thread remains", { description: error instanceof Error ? error.message : String(error) });
    });
  }, [activeProject?.id, activeSession, startSession]);
  const markGitActionComplete = useCallback(() => {
    const projectId = activeProject?.id;
    if (!projectId) return;
    const git = { additions: 0, deletions: 0 };
    gitIndicatorsByProject.current.set(projectId, git);
    setIndicators((current) => ({ ...current, git }));
    setGitStatusGeneration((current) => current + 1);
  }, [activeProject?.id]);
  const rebuildWebApp = useCallback(async () => {
    setRebuildState("rebuilding");
    setRebuildError(undefined);
    toast.loading("Rebuilding web app…", {
      id: "web-app-rebuild",
      description: "Running threads will not be interrupted.",
    });
    try {
      await anvilClient.rebuildWebApp();
      setRebuildDialogOpen(false);
      toast.success("Web app rebuilt", {
        id: "web-app-rebuild",
        description: "Reloading the updated interface…",
      });
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRebuildError(message);
      toast.error("Web app rebuild failed", {
        id: "web-app-rebuild",
        description: message,
      });
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
  const closeThreadActionDialog = (result?: "settled" | "deleted") => {
    const sessionId = sessionPendingClose?.id;
    setSessionPendingClose(null);
    if (!sessionId) return;
    requestAnimationFrame(() => {
      const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-session-id]"));
      const target = result === "deleted"
        ? triggers.find((element) => element.dataset.sessionId !== sessionId)
        : triggers.find((element) => element.dataset.sessionId === sessionId);
      (target ?? document.querySelector<HTMLButtonElement>("[aria-label='New project']"))?.focus();
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
    document.title = activePage === "settings"
      ? "Settings · ocode"
      : activePage === "usage"
        ? "Usage · ocode"
        : activeSession?.title
          ? `${activeSession.title} · ocode`
          : "ocode";
  }, [activePage, activeSession?.title]);

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
            selectSession(session.id);
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
            selectSession(session.id);
            anvilClient.markSessionRead(session.id);
          },
        },
      });
    }
  }, [selectSession, snapshot.sessions]);

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
      if (matchesShortcut(event, "openCommand")) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (matchesShortcut(event, "openFile")) {
        event.preventDefault();
        if (activeProject && activeSession) setFilePickerOpen(true);
        else toast.info("Select a thread to browse project files");
        return;
      }
      if (matchesShortcut(event, "recentlySettled")) {
        event.preventDefault();
        setRecentlySettledOpen(true);
        return;
      }
      if (matchesShortcut(event, "rebuild")) {
        event.preventDefault();
        if (rebuildState === "idle") void rebuildWebApp();
        return;
      }
      if (matchesShortcut(event, "settings")) {
        event.preventDefault();
        void navigate({ to: "/settings" });
        return;
      }
      if (isTerminalInputTarget(event.target)) return;
      if (matchesShortcut(event, "newThread")) {
        event.preventDefault();
        setProjectChooserMode("new");
        return;
      }
      if (matchesShortcut(event, "closeThread")) {
        event.preventDefault();
        if (activeSession?.internal && activeSession.parentSessionId) selectSession(activeSession.parentSessionId);
        else if (activeSession) requestCloseSession(activeSession.id);
        return;
      }
      const threadIndex = threadNumberShortcutIndex(event);
      if (threadIndex !== undefined) {
        const target = numberedThreadTarget(sortSessionsByActivity(ordinarySessions), threadIndex);
        if (target) {
          event.preventDefault();
          selectSession(target.id);
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
          selectSession(target.id);
          if (isMobile) setOpenMobile(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProject, activeSession, isMobile, navigate, ordinarySessions, rebuildState, rebuildWebApp, requestCloseSession, selectSession, setOpenMobile, snapshot.activeSessionId]);

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
        onSelectSession={selectSession}
        onCreateSession={startSession}
        onNewProject={openNewProject}
        activePage={activePage}
        onOpenSettings={() => void navigate({ to: "/settings" })}
        onOpenUsage={() => void navigate({ to: "/usage" })}
        onBack={() => void navigate({ to: "/" })}
        projectChooserMode={projectChooserMode}
        onProjectChooserModeChange={setProjectChooserMode}
        onChangeProject={changeEmptySessionProject}
        usage={indicators.usage}
        onRequestDeleteSession={requestDeleteSession}
        onRequestRenameSession={requestRenameSession}
        onSetSessionSettled={anvilClient.setSessionSettled}
        onMarkSessionRead={anvilClient.markSessionRead}
        onMarkSessionUnread={anvilClient.markSessionUnread}
        onSearchThreads={anvilClient.searchThreads}
      />

      <SidebarInset className="workspace">
        {activePage === "settings" ? (
          <SettingsPage
            theme={theme}
            accent={accent}
            displayPreferences={displayPreferences}
            desktopClient={desktopClient}
            rebuildState={rebuildState}
            onThemeChange={setTheme}
            onAccentChange={setAccent}
            onDisplayPreferencesChange={setDisplayPreferences}
            onOpenShortcuts={() => setShortcutsDialogOpen(true)}
            onManageProjects={() => setManageProjectsDialogOpen(true)}
            onProjectsRoot={() => setProjectsRootDialogOpen(true)}
            onDesktopUpdates={() => setDesktopUpdateDialogOpen(true)}
            onRebuild={() => {
              setRebuildError(undefined);
              setRebuildDialogOpen(true);
            }}
          />
        ) : activePage === "usage" ? (
          <UsagePage />
        ) : (
        <WorkspaceSurfaceProvider projectId={activeProject?.id ?? null}>
          <LiveProjectResourceAutoOpen />
          <SubagentSurfaceAutoOpen
            sessionId={activeSession?.id}
            toolCallIds={subagents.items.map((item) => item.parentToolCallId)}
            loading={activeSession ? snapshot.hydratingSessionIds.includes(activeSession.id) : false}
          />
          <CommandPaletteDialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
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
                projectName={activeProject.name}
                sessionId={activeSession?.id}
                subagents={subagents}
                connection={snapshot.connection}
                subagentsLoading={activeSession ? snapshot.hydratingSessionIds.includes(activeSession.id) : false}
                childSessions={activeSession ? snapshot.sessions.filter((session) => session.internal && session.parentSessionId === activeSession.id) : []}
                childTimelines={snapshot.timelines}
                hydratingChildSessionIds={activeSession ? snapshot.hydratingSessionIds.filter((id) => id !== activeSession.id) : []}
                onCancelSubagent={(runId) => activeSession ? anvilClient.cancelSubagent(activeSession.id, runId) : Promise.resolve()}
                onLoadSubagentChild={(item) => activeSession ? anvilClient.loadSubagentSession(activeSession.id, item.id) : Promise.reject(new Error("No active parent session"))}
                onGitActionComplete={markGitActionComplete}
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
                refreshGeneration={gitStatusGeneration}
              />
            )}
            {activeProject && <TerminalSurfaceToggle isMobile={isMobile} />}
            {activeProject && <FileSurfaceToggle isMobile={isMobile} />}
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
              projectName={activeProject?.name ?? "this project"}
              entries={timeline}
              loading={snapshot.hydratingSessionIds.includes(activeSession.id)}
              onSuggestion={sendSuggestion}
              onRequestProjectChange={() => setProjectChooserMode("change")}
            />

            <InteractionPanel requests={pendingInteractions} onRespond={anvilClient.respondToInteraction} />

            {activeSession.internal ? (
              <InternalSessionFooter
                onReturn={activeSession.parentSessionId ? () => selectSession(activeSession.parentSessionId!) : undefined}
              />
            ) : (
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
        )}
      </SidebarInset>

      <ShortcutsDialog open={shortcutsDialogOpen} onOpenChange={setShortcutsDialogOpen} />
      <RecentlySettledDialog
        open={recentlySettledOpen}
        sessions={ordinarySessions}
        projects={snapshot.projects}
        onOpenChange={setRecentlySettledOpen}
        onRestore={async (sessionId) => {
          await anvilClient.setSessionSettled(sessionId, false);
          selectSession(sessionId);
        }}
      />
      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          onCreate={anvilClient.createProject}
          onClone={anvilClient.cloneProject}
          onAddExisting={anvilClient.addExistingProject}
          listGitHubRepositories={anvilClient.listGitHubRepositories}
          listProjectDirectories={anvilClient.listProjectDirectories}
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
      {sessionPendingClose && (
        <SettleOrDeleteThreadDialog
          title={sessionPendingClose.title}
          onClose={closeThreadActionDialog}
          onSettle={() => anvilClient.setSessionSettled(sessionPendingClose.id, true)}
          onDelete={() => anvilClient.deleteSession(sessionPendingClose.id)}
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
      <Outlet />
      <AlertDialog open={rebuildDialogOpen} onOpenChange={(open) => !open && rebuildState !== "rebuilding" && setRebuildDialogOpen(false)}>
        <AlertDialogContent onEscapeKeyDown={(event) => rebuildState === "rebuilding" && event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{rebuildState === "rebuilding" ? "Rebuilding web app…" : "Rebuild the web app?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {rebuildState === "rebuilding"
                ? "Building the latest interface. Running threads will not be interrupted."
                : "This builds the latest React changes and reloads the updated interface. Running threads will not be interrupted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rebuildState === "rebuilding" && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status" aria-live="polite">
              <span className="forge-spinner size-4" aria-hidden="true" />
              Rebuilding…
            </div>
          )}
          {rebuildError && <p className="text-xs text-destructive" role="alert">{rebuildError}</p>}
          {rebuildState !== "rebuilding" && (
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button onClick={() => void rebuildWebApp()}>
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                Rebuild
              </Button>
            </AlertDialogFooter>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
