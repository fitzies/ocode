export type ProjectResourceView = "auto" | "source" | "preview";

/** Durable, session-relative reference stored in a Pi timeline. */
export type ProjectResourceContentBlock = {
  id: string;
  type: "projectResource";
  path: string;
  view?: ProjectResourceView;
  line?: number;
  column?: number;
};

/** Client navigation reference after project identity is derived from the owning session. */
export type ProjectResourceReference = {
  projectId: string;
  path: string;
  view?: ProjectResourceView;
  line?: number;
  column?: number;
};

export type ProjectFileViewer = "source" | "markdown" | "html" | "image" | "unsupported";

export type ProjectFileMetadata = {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  etag: string;
  mediaType: string;
  viewer: ProjectFileViewer;
};

export type ProjectFileMetadataResponse = { file: ProjectFileMetadata };
export type ProjectFileContentResponse = { file: ProjectFileMetadata; text: string };

export const PROJECT_RESOURCE_PATH_MAX_LENGTH = 4_096;

export function normalizeProjectResourcePath(value: string): string | undefined {
  if (
    !value ||
    value.length > PROJECT_RESOURCE_PATH_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes("\\")
  ) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

function positiveCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isProjectResourceContentBlock(value: unknown): value is ProjectResourceContentBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  const allowedKeys = new Set(["id", "type", "path", "view", "line", "column"]);
  return Object.keys(block).every((key) => allowedKeys.has(key)) &&
    typeof block.id === "string" && Boolean(block.id) &&
    block.type === "projectResource" &&
    typeof block.path === "string" && normalizeProjectResourcePath(block.path) === block.path &&
    (block.view === undefined || ["auto", "source", "preview"].includes(String(block.view))) &&
    (block.line === undefined || positiveCoordinate(block.line)) &&
    (block.column === undefined || positiveCoordinate(block.column));
}

export function resolveProjectResourceReference(
  block: ProjectResourceContentBlock,
  session: { projectId: string },
): ProjectResourceReference {
  return {
    projectId: session.projectId,
    path: block.path,
    ...(block.view ? { view: block.view } : {}),
    ...(block.line ? { line: block.line } : {}),
    ...(block.column ? { column: block.column } : {}),
  };
}
