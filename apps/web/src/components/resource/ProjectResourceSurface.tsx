import type { ConnectionState, SessionSummary, TimelineEntry } from "@anvil/protocol";
import { Cancel01Icon, Folder01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { SandboxedHtmlPreview } from "@/components/InlineHtmlArtifact";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import type { ProjectResourceTab } from "@/lib/workspace";
import type { SubagentActivity, SubagentActivityItem } from "@/lib/subagentActivity";
import { SubagentActivityPanel } from "@/components/SubagentActivityPanel";
import { ProjectImageViewer } from "./ProjectImageViewer";
import { isCurrentResourceRequest, revalidateProjectResource, type ResourceReadyState } from "./resourceLoader";
import { SourceViewer } from "./SourceViewer";

type ResourceLoadState =
  | { status: "loading" }
  | ResourceReadyState
  | { status: "error"; message: string };

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function ResourceViewer({ tab, state }: { tab: ProjectResourceTab; state: ResourceReadyState }) {
  const requestedView = tab.view ?? "auto";
  const viewer = requestedView === "source" ? "source" : state.file.viewer;
  if (viewer === "source" && state.text !== undefined) {
    return <SourceViewer path={tab.path} text={state.text} line={tab.line} column={tab.column} />;
  }
  if (viewer === "markdown" && state.text !== undefined) {
    return (
      <article className="resource-markdown markdown-body">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
            img: ({ node: _node, src, alt }) => (
              typeof src === "string" && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)
                ? <img src={src} alt={alt ?? ""} />
                : <span className="resource-markdown-image-blocked">{alt ?? "External image blocked"}</span>
            ),
            table: ({ node: _node, ...props }) => <div className="markdown-table-scroll" tabIndex={0}><table {...props} /></div>,
          }}
        >
          {state.text}
        </Markdown>
      </article>
    );
  }
  if (viewer === "html" && state.text !== undefined) {
    return <SandboxedHtmlPreview html={state.text} title={`Preview of ${state.file.name}`} className="resource-html-preview" />;
  }
  if (viewer === "image") {
    return <ProjectImageViewer projectId={tab.projectId} path={tab.path} alt={state.file.name} />;
  }
  return (
    <div className="resource-unsupported">
      <strong>Preview unavailable</strong>
      <p>{requestedView === "preview" ? "This file type does not have a safe preview." : "ocode will not decode this file as text."}</p>
      <dl>
        <div><dt>Type</dt><dd>{state.file.mediaType}</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(state.file.size)}</dd></div>
        <div><dt>Modified</dt><dd>{new Date(state.file.modifiedAt).toLocaleString()}</dd></div>
      </dl>
    </div>
  );
}

export function ProjectResource({ tab }: { tab: ProjectResourceTab }) {
  const [state, setState] = useState<ResourceLoadState>({ status: "loading" });
  const stateRef = useRef<ResourceLoadState>(state);
  const requestRef = useRef<{ generation: number; controller: AbortController } | undefined>(undefined);
  const generationRef = useRef(0);
  stateRef.current = state;

  const refresh = useCallback(async (mode: "initial" | "manual" | "focus") => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    requestRef.current = { generation, controller };
    const previous = stateRef.current;
    const usable = previous.status === "ready" ? previous : undefined;

    if (usable) {
      setState({ ...usable, refreshing: true, revalidationError: undefined });
    } else {
      setState({ status: "loading" });
    }

    try {
      const result = await revalidateProjectResource(tab, usable, mode, controller.signal);
      if (!isCurrentResourceRequest(controller.signal, generation, generationRef.current)) return;
      setState({ ...result.state, refreshing: false, revalidationError: undefined });
    } catch (error) {
      if (!isCurrentResourceRequest(controller.signal, generation, generationRef.current)) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = stateRef.current;
      if (current.status === "ready" || usable) {
        const preserved = current.status === "ready" ? current : usable!;
        setState({ ...preserved, refreshing: false, revalidationError: message });
      } else {
        setState({ status: "error", message });
      }
    }
  }, [tab]);

  useEffect(() => {
    void refresh("initial");
    const checkForChanges = () => void refresh("focus");
    window.addEventListener("focus", checkForChanges);
    return () => {
      window.removeEventListener("focus", checkForChanges);
      generationRef.current += 1;
      requestRef.current?.controller.abort();
    };
  }, [refresh]);

  if (state.status === "loading") return <div className="resource-loading" role="status">Loading {tab.path}…</div>;
  if (state.status === "error") {
    return <div className="resource-error" role="alert"><strong>Could not open file</strong><span>{state.message}</span><Button size="sm" variant="outline" onClick={() => void refresh("manual")}>Try again</Button></div>;
  }
  return (
    <div className="project-resource-content">
      {state.revalidationError && <strong className="resource-refresh-warning" role="status" title={state.revalidationError}>Refresh check failed</strong>}
      <ResourceViewer tab={tab} state={state} />
    </div>
  );
}

export function ProjectResourceSurface({
  projectId,
  subagents,
  connection,
  subagentsLoading = false,
  childSessions,
  childTimelines,
  hydratingChildSessionIds,
  onCancelSubagent,
  onLoadSubagentChild,
}: {
  projectId: string;
  subagents: SubagentActivity;
  connection: ConnectionState;
  subagentsLoading?: boolean;
  childSessions: SessionSummary[];
  childTimelines: Record<string, TimelineEntry[]>;
  hydratingChildSessionIds: string[];
  onCancelSubagent: (runId: string) => Promise<void>;
  onLoadSubagentChild: (item: SubagentActivityItem) => Promise<string>;
}) {
  const {
    state,
    openSidePage,
    selectProjectResource,
    closeProjectResource,
    closeAgentsTab,
    setRightVisible,
  } = useWorkspaceSurfaces();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const active = state.resourceTabs.find((tab) => tab.id === state.activeResourceId) ?? state.resourceTabs[0];
  const activeFile = state.sidePage === "files" ? active : undefined;
  const hasTabs = state.resourceTabs.length > 0 || state.agentsTabOpen;

  return (
    <section className="project-resource-surface" aria-label={`Open files and Agents for ${projectId}`}>
      <header className="project-resource-header">
        <nav className="project-resource-tabs" aria-label="Open files and Agents">
          {state.resourceTabs.map((tab) => (
            <div className={state.sidePage === "files" && tab.id === active?.id ? "project-resource-tab project-resource-tab--active" : "project-resource-tab"} key={tab.id}>
              <Button variant="ghost" size="sm" className="project-resource-tab-name" aria-current={state.sidePage === "files" && tab.id === active?.id ? "page" : undefined} title={tab.path} onClick={() => selectProjectResource(tab.id)}>{tab.path.split("/").at(-1)}</Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Close ${tab.path}`} onClick={() => closeProjectResource(tab.id)}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          ))}
          {state.agentsTabOpen && (
            <div className={state.sidePage === "agents" ? "project-resource-tab project-resource-tab--active" : "project-resource-tab"}>
              <Button variant="ghost" size="sm" className="project-resource-tab-name" aria-current={state.sidePage === "agents" ? "page" : undefined} onClick={() => openSidePage("agents")}>Agents</Button>
              <Button variant="ghost" size="icon-xs" aria-label="Close Agents" onClick={closeAgentsTab}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          )}
          {!hasTabs && <h2 className="project-resource-title">Files</h2>}
        </nav>
        {activeFile && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Refresh ${activeFile.path}`} onClick={() => setRefreshGeneration((value) => value + 1)}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close side pane" onClick={() => setRightVisible(false)}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <main className="project-resource-viewer">
        {state.sidePage === "agents" ? (
          <SubagentActivityPanel
            embedded
            activity={subagents}
            connection={connection}
            loading={subagentsLoading}
            childSessions={childSessions}
            childTimelines={childTimelines}
            hydratingChildSessionIds={hydratingChildSessionIds}
            onCancel={onCancelSubagent}
            onClose={() => setRightVisible(false)}
            onLoadChild={onLoadSubagentChild}
          />
        ) : activeFile ? (
          <ProjectResource key={`${activeFile.projectId}:${activeFile.id}:${refreshGeneration}`} tab={activeFile} />
        ) : (
          <Empty className="h-full rounded-none p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><HugeiconsIcon icon={Folder01Icon} strokeWidth={2} aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No files open</EmptyTitle>
              <EmptyDescription>Files opened by Pi will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </main>
    </section>
  );
}
