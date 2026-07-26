import type { ProjectFileContentResponse, ProjectFileMetadata } from "@anvil/protocol";

export class ProjectFileRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

function endpoint(projectId: string, operation: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/${operation}?${query}`;
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  const value = await response.json().catch(() => undefined) as { message?: unknown; code?: unknown } | undefined;
  if (!response.ok) {
    throw new ProjectFileRequestError(
      typeof value?.message === "string" ? value.message : `Project file request failed (${response.status})`,
      response.status,
      typeof value?.code === "string" ? value.code : undefined,
    );
  }
  return value as T;
}

export function projectFileMediaUrl(projectId: string, path: string): string {
  return endpoint(projectId, "media", { path });
}

export async function getProjectFileMetadata(projectId: string, path: string, signal?: AbortSignal): Promise<ProjectFileMetadata> {
  const response = await requestJson<{ file: ProjectFileMetadata }>(endpoint(projectId, "metadata", { path }), signal);
  return response.file;
}

export function readProjectFileText(projectId: string, path: string, signal?: AbortSignal): Promise<ProjectFileContentResponse> {
  return requestJson(endpoint(projectId, "content", { path }), signal);
}
