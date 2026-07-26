import type { ProjectFileMetadata } from "@anvil/protocol";

import { getProjectFileMetadata, readProjectFileText } from "@/lib/projectFiles";
import type { ProjectResourceTab } from "@/lib/workspace";

export type ResourceReadyState = {
  status: "ready";
  file: ProjectFileMetadata;
  text?: string;
  refreshing?: boolean;
  revalidationError?: string;
};

type ResourceApi = {
  metadata(projectId: string, path: string, signal: AbortSignal): Promise<ProjectFileMetadata>;
  text(projectId: string, path: string, signal: AbortSignal): ReturnType<typeof readProjectFileText>;
};

const defaultApi: ResourceApi = {
  metadata: getProjectFileMetadata,
  text: readProjectFileText,
};

function needsText(tab: ProjectResourceTab, file: ProjectFileMetadata): boolean {
  return tab.view === "source" || ["source", "markdown", "html"].includes(file.viewer);
}

async function loadResource(
  tab: ProjectResourceTab,
  file: ProjectFileMetadata,
  signal: AbortSignal,
  api: ResourceApi,
): Promise<ResourceReadyState> {
  if (file.kind !== "file") throw new Error("Resource path is not a regular file");
  const content = needsText(tab, file)
    ? await api.text(tab.projectId, tab.path, signal)
    : undefined;
  return {
    status: "ready",
    file: content?.file ?? file,
    ...(content ? { text: content.text } : {}),
  };
}

export async function revalidateProjectResource(
  tab: ProjectResourceTab,
  previous: ResourceReadyState | undefined,
  mode: "initial" | "manual" | "focus",
  signal: AbortSignal,
  api: ResourceApi = defaultApi,
): Promise<{ kind: "unchanged"; state: ResourceReadyState } | { kind: "changed"; state: ResourceReadyState }> {
  const file = await api.metadata(tab.projectId, tab.path, signal);
  if (mode === "focus" && previous?.file.etag === file.etag) return { kind: "unchanged", state: previous };
  return { kind: "changed", state: await loadResource(tab, file, signal, api) };
}

export function isCurrentResourceRequest(signal: AbortSignal, generation: number, currentGeneration: number): boolean {
  return !signal.aborted && generation === currentGeneration;
}
