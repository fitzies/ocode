import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type AnvilApiError, type ProjectFileMetadata } from "@anvil/protocol";

import { ProjectFileError, ProjectFileService } from "../projects/projectFileService.ts";

function apiError(code: string, message: string, retryable = false): AnvilApiError {
  return { protocolVersion: ANVIL_PROTOCOL_VERSION, code, message, retryable };
}

function sendJson(response: ServerResponse, status: number, value: unknown, head = false): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(head ? undefined : body);
}

function decodedSegment(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw new ProjectFileError(`invalid_${label}`, `${label[0]!.toUpperCase()}${label.slice(1)} is malformed`);
  }
}

function strictQueryValue(url: URL, key: string, required = false): string {
  const values: string[] = [];
  for (const part of url.search.slice(1).split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const rawName = separator < 0 ? part : part.slice(0, separator);
    let name: string;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " "));
    } catch {
      throw new ProjectFileError("malformed_encoding", "Query encoding is malformed");
    }
    if (name !== key) continue;
    const rawValue = separator < 0 ? "" : part.slice(separator + 1);
    try {
      values.push(decodeURIComponent(rawValue.replace(/\+/g, " ")));
    } catch {
      throw new ProjectFileError("malformed_encoding", `${key} encoding is malformed`);
    }
  }
  if (values.length > 1) throw new ProjectFileError("duplicate_parameter", `${key} may only be provided once`);
  if (!values.length) {
    if (required) throw new ProjectFileError("missing_path", `${key} is required`);
    return "";
  }
  return values[0]!;
}

export class ProjectFileRoutes {
  constructor(private readonly files: ProjectFileService) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/api\/v1\/projects\/([^/]+)\/files\/(metadata|content|media)$/.exec(url.pathname);
    if (!match || (request.method !== "GET" && request.method !== "HEAD")) return false;
    if (request.headers["sec-fetch-site"] === "cross-site") {
      sendJson(response, 403, apiError("cross_site_rejected", "Cross-site project file requests are not allowed"), request.method === "HEAD");
      return true;
    }

    try {
      const projectId = decodedSegment(match[1]!, "project");
      const operation = match[2]!;
      const path = strictQueryValue(url, "path", true);
      if (operation === "metadata") {
        sendJson(response, 200, { file: await this.files.metadata(projectId, path) }, request.method === "HEAD");
        return true;
      }
      if (operation === "content") {
        if (request.method === "HEAD") throw new ProjectFileError("method_not_allowed", "HEAD is not supported for text content", 405);
        sendJson(response, 200, await this.files.readText(projectId, path));
        return true;
      }

      const sendRasterHeaders = (file: ProjectFileMetadata, contentLength = file.size) => {
        const filename = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "project-image";
        response.writeHead(200, {
          "content-type": file.mediaType,
          "content-length": contentLength,
          "content-disposition": `inline; filename="${filename}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cross-origin-resource-policy": "same-origin",
          etag: file.etag,
        });
      };
      if (request.method === "HEAD") {
        sendRasterHeaders(await this.files.rasterMetadata(projectId, path));
        response.end();
        return true;
      }
      const raster = await this.files.acquireRaster(projectId, path);
      response.once("finish", raster.release);
      response.once("close", raster.release);
      sendRasterHeaders(raster.file, raster.body.length);
      response.end(raster.body);
      return true;
    } catch (error) {
      if (error instanceof ProjectFileError) {
        sendJson(response, error.status, apiError(error.code, error.message), request.method === "HEAD");
      } else {
        sendJson(response, 500, apiError("file_service_failed", "Project file request failed", true), request.method === "HEAD");
      }
      return true;
    }
  }
}
