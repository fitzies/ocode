import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type AnvilApiError } from "@anvil/protocol";

import { ProjectGitError, ProjectGitService } from "../projects/projectGitService.ts";
import { sameOrigin } from "./security.ts";

const MAX_GIT_REQUEST_BYTES = 8 * 1024;

function apiError(code: string, message: string, retryable = false): AnvilApiError {
  return { protocolVersion: ANVIL_PROTOCOL_VERSION, code, message, retryable };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_GIT_REQUEST_BYTES) throw new ProjectGitError("request_too_large", "Git request is too large", 413);
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new ProjectGitError("invalid_json", "Git request body is not valid JSON");
  }
}

function decodedProjectId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 200 || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw new ProjectGitError("invalid_project", "Project id is malformed");
  }
}

export class ProjectGitRoutes {
  constructor(
    private readonly git: ProjectGitService,
    private readonly modelForSession?: (projectId: string, sessionId: string) => string | undefined,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/api\/v1\/projects\/([^/]+)\/git\/(status|generate-message|commit-and-push)$/.exec(url.pathname);
    if (!match) return false;
    const operation = match[2]!;
    if ((operation === "status" && request.method !== "GET") || (operation !== "status" && request.method !== "POST")) {
      sendJson(response, 405, apiError("method_not_allowed", "Method not allowed"));
      return true;
    }
    if (request.headers["sec-fetch-site"] === "cross-site" || (request.method === "POST" && !sameOrigin(request))) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return true;
    }

    try {
      const projectId = decodedProjectId(match[1]!);
      if (operation === "status") {
        sendJson(response, 200, await this.git.status(projectId));
        return true;
      }

      const body = await readJson(request);
      if (operation === "generate-message") {
        let modelId: string | undefined;
        if (body.sessionId !== undefined) {
          if (typeof body.sessionId !== "string" || !body.sessionId) {
            throw new ProjectGitError("invalid_session", "Session id is malformed");
          }
          modelId = this.modelForSession?.(projectId, body.sessionId);
          if (!modelId) throw new ProjectGitError("session_not_found", "Session not found for this project", 404);
        }
        sendJson(response, 200, await this.git.generateMessage(projectId, modelId));
        return true;
      }

      if (body.message !== undefined && typeof body.message !== "string") {
        throw new ProjectGitError("invalid_commit_message", "Commit message is malformed");
      }
      if (body.changeFingerprint !== undefined && typeof body.changeFingerprint !== "string") {
        throw new ProjectGitError("invalid_change_fingerprint", "Change fingerprint is malformed");
      }
      sendJson(response, 200, await this.git.commitAndPush(projectId, {
        message: typeof body.message === "string" ? body.message : undefined,
        changeFingerprint: typeof body.changeFingerprint === "string" ? body.changeFingerprint : undefined,
      }));
      return true;
    } catch (error) {
      if (error instanceof ProjectGitError) {
        sendJson(response, error.status, {
          ...apiError(error.code, error.message, error.status >= 500),
          ...error.details,
        });
      } else {
        sendJson(response, 500, apiError("git_service_failed", "Project Git request failed", true));
      }
      return true;
    }
  }
}
