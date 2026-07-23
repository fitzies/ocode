import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import {
  ANVIL_PROTOCOL_VERSION,
  isAnvilClientCommand,
  type AnvilApiError,
  type AnvilClientCommand,
  type AnvilCommandResponse,
  type AnvilEvent,
  type AnvilStreamReset,
} from "@anvil/protocol";

import { ForgeEventService } from "../events/eventService.ts";

const MAX_COMMAND_BYTES = 2 * 1024 * 1024;

export interface ForgeHttpServerOptions {
  events: ForgeEventService;
  handleCommand?: (command: AnvilClientCommand) => Promise<AnvilCommandResponse>;
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

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_COMMAND_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

export class ForgeHttpServer {
  private readonly server: Server;
  private readonly streams = new Set<ServerResponse>();

  constructor(private readonly options: ForgeHttpServerOptions) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendJson(response, 500, apiError("internal_error", "Forge could not complete the request", true));
      });
    });
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
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  address(): ReturnType<Server["address"]> {
    return this.server.address();
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/v1/health/live") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/health/ready") {
      sendJson(response, 200, { status: "ready", cursor: this.options.events.currentSnapshot().lastSequence });
      return;
    }
    if (url.pathname.startsWith("/api/") && !this.authorizedOwner(request)) {
      sendJson(response, 403, apiError("owner_rejected", "Tailscale identity is not authorized"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
      sendJson(response, 200, this.options.events.bootstrap());
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

  private authorizedOwner(request: IncomingMessage): boolean {
    if (!this.options.ownerLogin) return true;
    const login = request.headers["tailscale-user-login"];
    return typeof login === "string" && login === this.options.ownerLogin;
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
    const latest = this.options.events.currentSnapshot().lastSequence;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();

    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > latest) {
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
    const writeEvent = (event: AnvilEvent) => {
      if (event.sequence <= delivered) return;
      delivered = event.sequence;
      response.write(`id: ${event.sequence}\nevent: anvil\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const onEvent = (event: AnvilEvent) => writeEvent(event);
    this.options.events.on("event", onEvent);
    while (true) {
      const replay = this.options.events.eventsAfter(delivered, 10_000);
      for (const event of replay) writeEvent(event);
      if (replay.length < 10_000) break;
    }

    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      this.options.events.off("event", onEvent);
      this.streams.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  }
}
