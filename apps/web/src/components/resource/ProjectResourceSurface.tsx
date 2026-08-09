import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { SandboxedHtmlPreview } from "@/components/InlineHtmlArtifact";
import { SubagentActivityPanel } from "@/components/SubagentActivityPanel";
import { Button } from "@/components/ui/button";
import { useWorkspaceSurfaces } from "@/components/workspace/WorkspaceSurfaceState";
import type { SubagentActivity } from "@/lib/subagentActivity";
import type { SubagentCommandReceipt } from "@anvil/protocol";
import type { ProjectResourceTab } from "@/lib/workspace";
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
  sessionId,
  subagents,
  onRefreshSubagents,
  onSteerSubagent,
  onInterruptSubagent,
  onStopSubagent,
  onResumeSubagent,
}: {
  projectId: string;
  sessionId: string | null;
  subagents: SubagentActivity;
  onRefreshSubagents(sessionId: string): Promise<void>;
  onSteerSubagent(sessionId: string, runId: string, message: string): Promise<SubagentCommandReceipt | undefined>;
  onInterruptSubagent(sessionId: string, runId: string): Promise<SubagentCommandReceipt | undefined>;
  onStopSubagent(sessionId: string, runId: string): Promise<SubagentCommandReceipt | undefined>;
  onResumeSubagent(sessionId: string, runId: string, message: string): Promise<SubagentCommandReceipt | undefined>;
}) {
  const {
    state,
    openSubagents,
    selectProjectResource,
    closeProjectResource,
    setRightVisible,
  } = useWorkspaceSurfaces();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const activeResource = state.resourceTabs.find((tab) => tab.id === state.activeResourceId) ?? state.resourceTabs[0];
  const showingAgents = state.activeRightSurface === "agents";
  if (!showingAgents && !activeResource) return null;

  return (
    <section className="project-resource-surface" aria-label={`Workspace panel for ${projectId}`}>
      <header className="project-resource-header">
        <nav className="project-resource-tabs" aria-label="Open workspace panels">
          {(subagents.items.length > 0 || showingAgents) && (
            <div className={showingAgents ? "project-resource-tab project-resource-tab--active project-resource-tab--agents" : "project-resource-tab project-resource-tab--agents"}>
              <button type="button" aria-current={showingAgents ? "page" : undefined} onClick={openSubagents}>
                <span className={subagents.active > 0 ? "project-resource-agent-dot project-resource-agent-dot--active" : "project-resource-agent-dot"} aria-hidden="true" />
                Agents{subagents.items.length > 0 && <small>{subagents.items.length}</small>}
              </button>
            </div>
          )}
          {state.resourceTabs.map((tab) => {
            const selected = !showingAgents && tab.id === activeResource?.id;
            return (
              <div className={selected ? "project-resource-tab project-resource-tab--active" : "project-resource-tab"} key={tab.id}>
                <button type="button" aria-current={selected ? "page" : undefined} title={tab.path} onClick={() => selectProjectResource(tab.id)}>{tab.path.split("/").at(-1)}</button>
                <button type="button" aria-label={`Close ${tab.path}`} onClick={() => closeProjectResource(tab.id)}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </nav>
        {showingAgents && sessionId && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh agents" onClick={() => void onRefreshSubagents(sessionId)}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
        {!showingAgents && activeResource && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Refresh ${activeResource.path}`} onClick={() => setRefreshGeneration((value) => value + 1)}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close workspace panel" onClick={() => setRightVisible(false)}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <main className="project-resource-viewer">
        {showingAgents
          ? <SubagentActivityPanel activity={subagents} controls={{
              onSteer: (runId, message) => sessionId ? onSteerSubagent(sessionId, runId, message) : Promise.resolve(undefined),
              onInterrupt: (runId) => sessionId ? onInterruptSubagent(sessionId, runId) : Promise.resolve(undefined),
              onStop: (runId) => sessionId ? onStopSubagent(sessionId, runId) : Promise.resolve(undefined),
              onResume: (runId, message) => sessionId ? onResumeSubagent(sessionId, runId, message) : Promise.resolve(undefined),
            }} />
          : activeResource && <ProjectResource key={`${activeResource.projectId}:${activeResource.id}:${refreshGeneration}`} tab={activeResource} />}
      </main>
    </section>
  );
}
