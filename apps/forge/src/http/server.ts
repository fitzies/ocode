import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, resolve, sep } from "node:path";

import {
  ANVIL_PROTOCOL_VERSION,
  isAnvilClientCommand,
  type AnvilApiError,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type AnvilStreamReset,
} from "@anvil/protocol";

import { ArtifactStore } from "../artifacts/artifactStore.ts";
import { ForgeEventService } from "../events/eventService.ts";
import { ProjectFileService } from "../projects/projectFileService.ts";
import { ProjectGitService } from "../projects/projectGitService.ts";
import { ProjectsRootValidationError } from "../projects/projectsRoot.ts";
import { LiveIndicatorsService } from "../runtime/indicators.ts";
import { TerminalManager } from "../terminal/terminalManager.ts";
import { resolveProjectFavicon } from "./projectFavicon.ts";
import { ProjectFileRoutes } from "./projectFileRoutes.ts";
import { ProjectGitRoutes } from "./projectGitRoutes.ts";
import { authorizedOwner, sameOrigin } from "./security.ts";
import { TerminalWebSocketChannel } from "./terminalWebSocket.ts";

const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_SSE_QUEUE_EVENTS = 1_000;
const MAX_SSE_QUEUE_BYTES = 8 * 1024 * 1024;

export interface ForgeHttpServerOptions {
  events: ForgeEventService;
  artifacts?: ArtifactStore;
  handleCommand?: (command: AnvilClientCommand) => Promise<AnvilCommandResponse>;
  indicators?: LiveIndicatorsService;
  projectFiles?: ProjectFileService;
  projectGit?: ProjectGitService;
  searchFiles?: (sessionId: string, query: string, limit: number) => Promise<string[] | undefined>;
  getProjectsRoot?: () => string;
  setProjectsRoot?: (path: string) => string;
  requestRebuild?: () => Promise<void>;
  terminals?: TerminalManager;
  instanceId?: string;
  ownerLogin?: string;
  webRoot?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function apiError(code: string, message: string, retryable = false): AnvilApiError {
  return { protocolVersion: ANVIL_PROTOCOL_VERSION, code, message, retryable };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBytes(request, MAX_COMMAND_BYTES)).toString("utf8"));
}

export class ForgeHttpServer {
  private readonly server: Server;
  private readonly streams = new Set<ServerResponse>();
  private readonly instanceId: string;
  private readonly projectFileRoutes?: ProjectFileRoutes;
  private readonly projectGitRoutes?: ProjectGitRoutes;
  private readonly terminalChannel?: TerminalWebSocketChannel;

  constructor(private readonly options: ForgeHttpServerOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendJson(response, 500, apiError("internal_error", "Forge could not complete the request", true));
      });
    });
    if (options.projectFiles) this.projectFileRoutes = new ProjectFileRoutes(options.projectFiles);
    if (options.projectGit) {
      this.projectGitRoutes = new ProjectGitRoutes(options.projectGit, (projectId, sessionId) => {
        const session = options.events.sessionSummary(sessionId);
        return session?.projectId === projectId ? session.modelId : undefined;
      });
    }
    if (options.terminals) {
      this.terminalChannel = new TerminalWebSocketChannel(this.server, options.terminals, options.ownerLogin);
    }
  }

  async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await this.terminalChannel?.close();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await new Promise<void>((resolve, reject) => {
      const forceClose = setTimeout(() => this.server.closeAllConnections(), 5_000);
      forceClose.unref();
      this.server.close((error) => {
        clearTimeout(forceClose);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  address(): ReturnType<Server["address"]> {
    return this.server.address();
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/v1/health/live") {
      sendJson(response, 200, { status: "ok", instanceId: this.instanceId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health/ready") {
      sendJson(response, 200, {
        status: "ready",
        cursor: this.options.events.latestSequence(),
        instanceId: this.instanceId,
      });
      return;
    }
    if (url.pathname.startsWith("/api/") && !authorizedOwner(request, this.options.ownerLogin)) {
      sendJson(response, 403, apiError("owner_rejected", "Tailscale identity is not authorized"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/settings/projects-root") {
      this.projectsRoot(response);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/v1/settings/projects-root") {
      await this.updateProjectsRoot(request, response);
      return;
    }
    if (this.projectFileRoutes && await this.projectFileRoutes.handle(request, response, url)) return;
    if (this.projectGitRoutes && await this.projectGitRoutes.handle(request, response, url)) return;
    if (request.method === "POST" && url.pathname === "/api/v1/admin/rebuild") {
      await this.rebuild(request, response);
      return;
    }
    const attachmentDeleteMatch = /^\/api\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && attachmentDeleteMatch) {
      this.deleteAttachment(request, response, attachmentDeleteMatch[1]!, attachmentDeleteMatch[2]!);
      return;
    }
    const attachmentMatch = /^\/api\/v1\/sessions\/([^/]+)\/attachments$/.exec(url.pathname);
    if (request.method === "POST" && attachmentMatch) {
      await this.uploadAttachment(request, response, attachmentMatch[1]!);
      return;
    }
    const fileSearchMatch = /^\/api\/v1\/sessions\/([^/]+)\/files$/.exec(url.pathname);
    if (request.method === "GET" && fileSearchMatch) {
      await this.searchFiles(response, url, fileSearchMatch[1]!);
      return;
    }
    const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && artifactMatch) {
      await this.artifact(request, response, artifactMatch[1]!);
      return;
    }
    const projectFaviconMatch = /^\/api\/v1\/projects\/([^/]+)\/favicon$/.exec(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && projectFaviconMatch) {
      await this.projectFavicon(request, response, projectFaviconMatch[1]!);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
      const acceptsSummary = request.headers.accept?.includes("application/vnd.anvil.summary+json");
      sendJson(response, 200, acceptsSummary
        ? this.options.events.summaryBootstrap()
        : this.options.events.bootstrap());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/bootstrap/summary") {
      sendJson(response, 200, this.options.events.summaryBootstrap());
      return;
    }
    const detailMatch = /^\/api\/v1\/sessions\/([^/]+)\/detail$/.exec(url.pathname);
    if (request.method === "GET" && detailMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(detailMatch[1]!);
      } catch {
        sendJson(response, 400, apiError("invalid_session", "Session id is malformed"));
        return;
      }
      const rawAfter = url.searchParams.get("after");
      const after = rawAfter === null ? undefined : Number(rawAfter);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
        sendJson(response, 400, apiError("invalid_cursor", "Detail cursor is invalid"));
        return;
      }
      const detail = this.options.events.sessionDetailSync(sessionId, after);
      if (!detail) {
        sendJson(response, 404, apiError("session_not_found", "Session not found"));
        return;
      }
      sendJson(response, 200, detail);
      return;
    }
    const indicatorsMatch = /^\/api\/v1\/sessions\/([^/]+)\/indicators$/.exec(url.pathname);
    if (request.method === "GET" && indicatorsMatch) {
      if (!this.options.indicators) {
        sendJson(response, 503, apiError("runtime_unavailable", "Live indicators are unavailable", true));
        return;
      }
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(indicatorsMatch[1]!);
      } catch {
        sendJson(response, 400, apiError("invalid_session", "Session id is malformed"));
        return;
      }
      const indicators = await this.options.indicators.get(sessionId);
      if (!indicators) {
        sendJson(response, 404, apiError("session_not_found", "Session not found"));
        return;
      }
      sendJson(response, 200, indicators);
      return;
    }
    const commandMatch = /^\/api\/v1\/commands\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && commandMatch) {
      const commandId = decodeURIComponent(commandMatch[1]!);
      const outcome = this.options.events.commandOutcome(commandId);
      if (outcome === undefined) {
        sendJson(response, 404, apiError("command_not_found", "Command was not seen by Forge"));
      } else if (typeof outcome === "string") {
        sendJson(response, 200, { protocolVersion: ANVIL_PROTOCOL_VERSION, commandId, status: outcome });
      } else {
        sendJson(response, 200, outcome);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/events") {
      this.streamEvents(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/commands") {
      await this.command(request, response);
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && this.options.webRoot) {
      if (await this.staticFile(request, response, url.pathname)) return;
    }
    sendJson(response, 404, apiError("not_found", "Route not found"));
  }

  private projectsRoot(response: ServerResponse): void {
    if (!this.options.getProjectsRoot) {
      sendJson(response, 503, apiError("projects_root_unavailable", "Projects root settings are unavailable"));
      return;
    }
    sendJson(response, 200, { path: this.options.getProjectsRoot() });
  }

  private async updateProjectsRoot(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    if (!this.options.setProjectsRoot) {
      sendJson(response, 503, apiError("projects_root_unavailable", "Projects root settings are unavailable"));
      return;
    }

    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      sendJson(response, 400, apiError("invalid_projects_root", "Request body must be valid JSON with a path"));
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { path?: unknown }).path !== "string") {
      sendJson(response, 400, apiError("invalid_projects_root", "Projects root path must be a string"));
      return;
    }

    try {
      const path = this.options.setProjectsRoot((body as { path: string }).path);
      sendJson(response, 200, { path });
    } catch (error) {
      if (error instanceof ProjectsRootValidationError) {
        sendJson(response, 400, apiError("invalid_projects_root", error.message));
        return;
      }
      sendJson(response, 500, apiError("projects_root_failed", "Forge could not save the projects root", true));
    }
  }

  private async rebuild(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    if (!this.options.requestRebuild) {
      sendJson(response, 503, apiError("rebuild_unavailable", "Web app rebuild is unavailable"));
      return;
    }
    try {
      await this.options.requestRebuild();
      sendJson(response, 200, { status: "rebuilt" });
    } catch (error) {
      sendJson(response, 500, apiError(
        "rebuild_failed",
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  private deleteAttachment(
    request: IncomingMessage,
    response: ServerResponse,
    encodedSessionId: string,
    encodedArtifactId: string,
  ): void {
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    let sessionId: string;
    let artifactId: string;
    try {
      sessionId = decodeURIComponent(encodedSessionId);
      artifactId = decodeURIComponent(encodedArtifactId);
    } catch {
      sendJson(response, 400, apiError("invalid_attachment", "Attachment reference is malformed"));
      return;
    }
    if (!this.options.events.deleteAttachment(sessionId, artifactId)) {
      sendJson(response, 404, apiError("attachment_not_found", "Pending attachment not found"));
      return;
    }
    sendJson(response, 200, { deleted: true });
  }

  private async uploadAttachment(
    request: IncomingMessage,
    response: ServerResponse,
    encodedSessionId: string,
  ): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    if (!this.options.artifacts) {
      sendJson(response, 503, apiError("artifacts_unavailable", "Attachment storage is unavailable", true));
      return;
    }
    let sessionId: string;
    let name: string;
    try {
      sessionId = decodeURIComponent(encodedSessionId);
      const encodedName = request.headers["x-anvil-file-name"];
      if (typeof encodedName !== "string") throw new Error("missing filename");
      name = basename(decodeURIComponent(encodedName).replace(/\\/g, "/"));
    } catch {
      sendJson(response, 400, apiError("invalid_attachment", "Attachment filename or session is malformed"));
      return;
    }
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      sendJson(response, 400, apiError("invalid_attachment", "Attachment filename is invalid"));
      return;
    }
    const rawMediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim() || "application/octet-stream";
    const mediaType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawMediaType)
      ? rawMediaType.toLowerCase()
      : "application/octet-stream";
    let bytes: Buffer;
    try {
      bytes = await readBytes(request, MAX_ATTACHMENT_BYTES);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "request_too_large";
      sendJson(response, tooLarge ? 413 : 400, apiError(tooLarge ? "attachment_too_large" : "invalid_attachment", tooLarge ? "Attachment exceeds 20 MB" : "Attachment could not be read"));
      return;
    }
    if (bytes.length === 0) {
      sendJson(response, 400, apiError("invalid_attachment", "Attachment is empty"));
      return;
    }
    try {
      sendJson(response, 201, this.options.events.ingestAttachment(sessionId, bytes, mediaType, name));
    } catch (error) {
      const missing = error instanceof Error && error.message === "Session not found";
      sendJson(response, missing ? 404 : 500, apiError(missing ? "session_not_found" : "attachment_failed", missing ? "Session not found" : "Attachment could not be stored", !missing));
    }
  }

  private async searchFiles(
    response: ServerResponse,
    url: URL,
    encodedSessionId: string,
  ): Promise<void> {
    if (!this.options.searchFiles) {
      sendJson(response, 503, apiError("file_search_unavailable", "Workspace file search is unavailable", true));
      return;
    }
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(encodedSessionId);
    } catch {
      sendJson(response, 400, apiError("invalid_session", "Session id is malformed"));
      return;
    }
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > 200) {
      sendJson(response, 400, apiError("invalid_query", "File search query is too long"));
      return;
    }
    const paths = await this.options.searchFiles(sessionId, query, 50);
    if (!paths) {
      sendJson(response, 404, apiError("session_not_found", "Session not found"));
      return;
    }
    sendJson(response, 200, { files: paths.map((path) => ({ path })) });
  }

  private async projectFavicon(
    request: IncomingMessage,
    response: ServerResponse,
    encodedProjectId: string,
  ): Promise<void> {
    let projectId: string;
    try {
      projectId = decodeURIComponent(encodedProjectId);
    } catch {
      sendJson(response, 400, apiError("invalid_project", "Project id is malformed"));
      return;
    }
    const project = this.options.events.projectSummary(projectId);
    const favicon = project ? await resolveProjectFavicon(project.path) : null;
    if (!favicon) {
      sendJson(response, 404, apiError("project_favicon_not_found", "Project favicon not found"));
      return;
    }

    response.writeHead(200, {
      "content-type": favicon.mediaType,
      "content-length": favicon.body.length,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    response.end(request.method === "HEAD" ? undefined : favicon.body);
  }

  private async artifact(
    request: IncomingMessage,
    response: ServerResponse,
    encodedId: string,
  ): Promise<void> {
    if (!this.options.artifacts) {
      sendJson(response, 503, apiError("artifacts_unavailable", "Artifact storage is unavailable", true));
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      sendJson(response, 400, apiError("invalid_artifact", "Artifact id is malformed"));
      return;
    }
    const metadata = this.options.events.artifact(id);
    const path = this.options.artifacts.pathFor(id);
    if (!metadata || !path) {
      sendJson(response, 404, apiError("artifact_not_found", "Artifact not found"));
      return;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const file = await handle.stat();
      if (!file.isFile() || file.size !== metadata.byteLength) throw new Error("Artifact file is invalid");
    } catch {
      await handle?.close().catch(() => undefined);
      sendJson(response, 404, apiError("artifact_not_found", "Artifact not found"));
      return;
    }
    if (!handle) {
      sendJson(response, 404, apiError("artifact_not_found", "Artifact not found"));
      return;
    }
    const filename = (metadata.name ?? `artifact-${metadata.id}`)
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 120) || `artifact-${metadata.id}`;
    const inline = /^(image\/(png|jpeg|gif|webp)|text\/plain(?:; charset=utf-8)?)$/i.test(metadata.mediaType);
    response.writeHead(200, {
      "content-type": metadata.mediaType,
      "content-length": metadata.byteLength,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
    if (request.method === "HEAD") {
      await handle.close();
      response.end();
      return;
    }
    const stream = handle.createReadStream();
    stream.on("error", (error) => response.destroy(error));
    response.once("close", () => stream.destroy());
    stream.pipe(response);
  }

  private async staticFile(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    const root = resolve(this.options.webRoot!);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let path = resolve(root, requested);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return false;
    try {
      if (!(await stat(path)).isFile()) return false;
    } catch {
      if (extname(requested)) return false;
      path = resolve(root, "index.html");
      try {
        if (!(await stat(path)).isFile()) return false;
      } catch {
        return false;
      }
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  }

  private async command(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    let value: unknown;
    try {
      value = await readJson(request);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "request_too_large";
      sendJson(response, tooLarge ? 413 : 400, apiError(tooLarge ? "request_too_large" : "invalid_json", tooLarge ? "Command body is too large" : "Command body is not valid JSON"));
      return;
    }
    if (!isAnvilClientCommand(value)) {
      sendJson(response, 400, apiError("invalid_command", "Command does not match the Anvil protocol"));
      return;
    }
    if (!this.options.handleCommand) {
      sendJson(response, 503, apiError("runtime_unavailable", "The Pi runtime is not configured", true));
      return;
    }
    sendJson(response, 200, await this.options.handleCommand(value));
  }

  private streamEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const rawCursor = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
    const cursor = Number(rawCursor);
    const latest = this.options.events.latestSequence();
    const compactedThrough = this.options.events.compactedThrough();
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();

    if (
      !Number.isSafeInteger(cursor) ||
      cursor < compactedThrough ||
      cursor > latest
    ) {
      const reset: AnvilStreamReset = {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        reason: "cursor_invalid",
        cursor: latest,
      };
      response.write(`event: reset\ndata: ${JSON.stringify(reset)}\n\n`);
      response.end();
      return;
    }

    this.streams.add(response);
    let delivered = cursor;
    let blocked = false;
    let closed = false;
    let queuedBytes = 0;
    const queue: string[] = [];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.options.events.off("event", onEvent);
      response.off("drain", flush);
      this.streams.delete(response);
    };
    const overflow = () => {
      cleanup();
      response.end();
    };
    const writeChunk = (chunk: string) => {
      if (closed) return;
      if (blocked) {
        queue.push(chunk);
        queuedBytes += Buffer.byteLength(chunk);
        if (queue.length > MAX_SSE_QUEUE_EVENTS || queuedBytes > MAX_SSE_QUEUE_BYTES) overflow();
        return;
      }
      blocked = !response.write(chunk);
    };
    function flush() {
      if (closed) return;
      blocked = false;
      while (queue.length > 0 && !blocked) {
        const chunk = queue.shift()!;
        queuedBytes -= Buffer.byteLength(chunk);
        blocked = !response.write(chunk);
      }
    }
    const writeEvent = (event: AnvilEvent) => {
      if (closed || event.sequence <= delivered) return;
      delivered = event.sequence;
      writeChunk(`id: ${event.sequence}\nevent: anvil\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const onEvent = (event: AnvilEvent) => writeEvent(event);
    const heartbeat = setInterval(() => writeChunk(": heartbeat\n\n"), 15_000);
    response.on("drain", flush);
    this.options.events.on("event", onEvent);

    while (!closed) {
      const replay = this.options.events.eventsAfter(delivered, 10_000);
      for (const event of replay) writeEvent(event);
      if (replay.length < 10_000) break;
    }

    request.once("close", cleanup);
    response.once("close", cleanup);
  }
}
