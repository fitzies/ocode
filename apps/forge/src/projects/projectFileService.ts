import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  normalizeProjectResourcePath,
  type ProjectFileMetadata,
  type ProjectFileViewer,
} from "@anvil/protocol";

import { secureOpenProjectPath } from "../files/secureProjectPath.ts";
import type { ProjectResolver } from "./projectResolver.ts";

export const MAX_PROJECT_TEXT_BYTES = 1024 * 1024;
export const MAX_PROJECT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".htm", ".html",
  ".ini", ".java", ".js", ".json", ".jsx", ".log", ".lua", ".md", ".markdown", ".mdx", ".mjs", ".py",
  ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

const MEDIA_TYPES: Record<string, string> = {
  ".c": "text/x-c", ".cc": "text/x-c++", ".conf": "text/plain; charset=utf-8", ".cpp": "text/x-c++",
  ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".gif": "image/gif",
  ".go": "text/x-go", ".h": "text/x-c", ".hpp": "text/x-c++", ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".ini": "text/plain; charset=utf-8", ".java": "text/x-java",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jsx": "text/jsx; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".lua": "text/x-lua", ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8", ".mdx": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".png": "image/png", ".py": "text/x-python", ".rb": "text/x-ruby",
  ".rs": "text/x-rust", ".sh": "text/x-shellscript", ".sql": "text/x-sql", ".svg": "image/svg+xml",
  ".toml": "application/toml; charset=utf-8", ".ts": "text/typescript; charset=utf-8", ".tsx": "text/tsx; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8", ".yml": "application/yaml; charset=utf-8",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export class ProjectFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type OpenedTarget = {
  handle: FileHandle;
  root: string;
  path: string;
  canonicalPath: string;
  file: Awaited<ReturnType<FileHandle["stat"]>>;
};

function normalizePath(value: string): string {
  const normalized = normalizeProjectResourcePath(value);
  if (!normalized) throw new ProjectFileError("invalid_path", "Path must be a normalized project-relative path");
  return normalized;
}

function etagFor(file: Awaited<ReturnType<FileHandle["stat"]>>): string {
  return `"${createHash("sha256").update(`${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`).digest("hex").slice(0, 24)}"`;
}

async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  if (offset > limit) throw new ProjectFileError("file_too_large", `File exceeds the ${limit} byte view limit`, 413);
  return buffer.subarray(0, offset);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function viewerFor(path: string, sample: Uint8Array): { viewer: ProjectFileViewer; mediaType: string; textReadable: boolean } {
  const extension = extname(path).toLowerCase();
  const mediaType = MEDIA_TYPES[extension] ?? "application/octet-stream";
  if (IMAGE_EXTENSIONS.has(extension)) return { viewer: "image", mediaType, textReadable: false };
  if ([".md", ".markdown", ".mdx"].includes(extension)) return { viewer: "markdown", mediaType, textReadable: true };
  if ([".html", ".htm"].includes(extension)) return { viewer: "html", mediaType, textReadable: true };
  // SVG remains readable as inert source, but is never selected for direct preview.
  if (extension === ".svg") return { viewer: "unsupported", mediaType, textReadable: true };
  if (TEXT_EXTENSIONS.has(extension) || isUtf8Text(sample)) {
    return { viewer: "source", mediaType: MEDIA_TYPES[extension] ?? "text/plain; charset=utf-8", textReadable: true };
  }
  return { viewer: "unsupported", mediaType, textReadable: false };
}

function validRaster(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"));
  if (mediaType === "image/webp") return bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  return false;
}

export class ProjectFileService {
  private activeRasterReads = 0;

  constructor(private readonly projects: ProjectResolver) {}

  private async projectRoot(projectId: string): Promise<string> {
    if (!projectId || projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(projectId)) {
      throw new ProjectFileError("invalid_project", "Project id is malformed");
    }
    const project = this.projects.resolveProject(projectId);
    if (!project) throw new ProjectFileError("project_not_found", "Project not found", 404);
    let root: string;
    try {
      root = await realpath(project.path);
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ProjectFileError("project_unavailable", "Project root is unavailable", 404);
    }
    return root;
  }

  private async openTarget(projectId: string, value: string): Promise<OpenedTarget> {
    const path = normalizePath(value);
    const root = await this.projectRoot(projectId);
    try {
      const target = await secureOpenProjectPath(root, path);
      return { ...target, root, path };
    } catch (error) {
      if (error instanceof ProjectFileError) throw error;
      if (error instanceof Error && error.message === "path_outside_project") {
        throw new ProjectFileError("path_outside_project", "Path escapes the project root");
      }
      if (error instanceof Error && error.message === "path_changed") {
        throw new ProjectFileError("path_changed", "Path changed while it was being opened", 409);
      }
      if (error instanceof Error && error.message === "secure_open_unsupported") {
        throw new ProjectFileError("unsupported_platform", "Secure project file access requires Linux", 501);
      }
      throw new ProjectFileError("path_not_found", "Project path was not found", 404);
    }
  }

  private async metadataFromTarget(target: OpenedTarget): Promise<ProjectFileMetadata & { textReadable: boolean }> {
    if (!target.file.isFile() && !target.file.isDirectory()) {
      throw new ProjectFileError("unsupported_file_type", "Path is not a regular file or directory", 415);
    }
    if (target.file.size > MAX_PROJECT_FILE_BYTES) {
      throw new ProjectFileError("file_too_large", `File exceeds the ${MAX_PROJECT_FILE_BYTES} byte resource limit`, 413);
    }
    const fileSize = Number(target.file.size);
    let sample = Buffer.alloc(0);
    if (target.file.isFile()) {
      sample = Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024));
      if (sample.length) {
        const { bytesRead } = await target.handle.read(sample, 0, sample.length, 0);
        sample = sample.subarray(0, bytesRead);
      }
    }
    const classified = target.file.isDirectory()
      ? { viewer: "unsupported" as const, mediaType: "application/vnd.anvil.directory", textReadable: false }
      : viewerFor(target.path, sample);
    return {
      path: target.path,
      name: target.path ? basename(target.path) : basename(target.root),
      kind: target.file.isDirectory() ? "directory" : "file",
      size: fileSize,
      modifiedAt: target.file.mtime.toISOString(),
      etag: etagFor(target.file),
      mediaType: classified.mediaType,
      viewer: classified.viewer,
      textReadable: classified.textReadable,
    };
  }

  async metadata(projectId: string, path: string): Promise<ProjectFileMetadata> {
    const target = await this.openTarget(projectId, path);
    try {
      const { textReadable: _textReadable, ...metadata } = await this.metadataFromTarget(target);
      return metadata;
    } finally {
      await target.handle.close();
    }
  }

  async readText(projectId: string, path: string): Promise<{ file: ProjectFileMetadata; text: string }> {
    const target = await this.openTarget(projectId, path);
    try {
      const { textReadable, ...file } = await this.metadataFromTarget(target);
      if (file.kind !== "file") throw new ProjectFileError("not_a_file", "Path is not a regular file", 415);
      if (!textReadable) throw new ProjectFileError("binary_file", "Binary files cannot be decoded as text", 415);
      if (file.size > MAX_PROJECT_TEXT_BYTES) {
        throw new ProjectFileError("file_too_large", `Text file exceeds the ${MAX_PROJECT_TEXT_BYTES} byte view limit`, 413);
      }
      const bytes = await readBounded(target.handle, MAX_PROJECT_TEXT_BYTES);
      try {
        return { file, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        throw new ProjectFileError("invalid_text", "File is not valid UTF-8 text", 415);
      }
    } finally {
      await target.handle.close();
    }
  }

  private async validateRasterTarget(target: OpenedTarget): Promise<ProjectFileMetadata> {
    const { textReadable: _textReadable, ...file } = await this.metadataFromTarget(target);
    if (file.kind !== "file" || file.viewer !== "image" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mediaType)) {
      throw new ProjectFileError("unsupported_media", "Only PNG, JPEG, GIF, and WebP previews are supported", 415);
    }
    if (file.size > MAX_PROJECT_IMAGE_BYTES) {
      throw new ProjectFileError("file_too_large", `Image exceeds the ${MAX_PROJECT_IMAGE_BYTES} byte preview limit`, 413);
    }
    const signature = Buffer.allocUnsafe(Math.min(file.size, 12));
    const { bytesRead } = signature.length
      ? await target.handle.read(signature, 0, signature.length, 0)
      : { bytesRead: 0 };
    if (!validRaster(signature.subarray(0, bytesRead), file.mediaType)) {
      throw new ProjectFileError("invalid_media", "Image signature does not match its allowlisted format", 415);
    }
    return file;
  }

  async rasterMetadata(projectId: string, path: string): Promise<ProjectFileMetadata> {
    const target = await this.openTarget(projectId, path);
    try {
      return await this.validateRasterTarget(target);
    } finally {
      await target.handle.close();
    }
  }

  async acquireRaster(projectId: string, path: string): Promise<{
    file: ProjectFileMetadata;
    body: Buffer;
    release(): void;
  }> {
    if (this.activeRasterReads >= 4) throw new ProjectFileError("media_busy", "Too many image previews are being delivered", 429);
    this.activeRasterReads += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRasterReads -= 1;
    };
    let target: OpenedTarget | undefined;
    try {
      target = await this.openTarget(projectId, path);
      const file = await this.validateRasterTarget(target);
      const body = await readBounded(target.handle, MAX_PROJECT_IMAGE_BYTES);
      const afterRead = await target.handle.stat();
      if (
        afterRead.dev !== target.file.dev ||
        afterRead.ino !== target.file.ino ||
        afterRead.size !== target.file.size ||
        afterRead.mtimeMs !== target.file.mtimeMs ||
        body.length !== file.size
      ) {
        throw new ProjectFileError("file_changed", "Image changed while it was being read", 409);
      }
      return { file, body, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      await target?.handle.close().catch(() => undefined);
    }
  }

  async readRaster(projectId: string, path: string): Promise<{ file: ProjectFileMetadata; body: Buffer }> {
    const lease = await this.acquireRaster(projectId, path);
    try {
      return { file: lease.file, body: lease.body };
    } finally {
      lease.release();
    }
  }

}
