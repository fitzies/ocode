import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type AnvilApiError, type PiCatalogItemKind } from "@anvil/protocol";

import { PiCatalogService, PiResourceError } from "../pi/piCatalogService.ts";
import { sameOrigin } from "./security.ts";

const MAX_BODY_BYTES = 600 * 1024;

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

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new PiResourceError("request_too_large", "Request body is too large", 413);
    chunks.push(value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new PiResourceError("invalid_json", "Request body is not valid JSON");
  }
}

function kind(value: unknown): PiCatalogItemKind {
  if (value !== "skill" && value !== "extension") throw new PiResourceError("invalid_resource_kind", "Resource kind is invalid");
  return value;
}

export class PiCatalogRoutes {
  constructor(private readonly catalog: PiCatalogService) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const resourceRoute = url.pathname.startsWith("/api/v1/pi/resources");
    const skillRoute = url.pathname.startsWith("/api/v1/pi/skills");
    if (!resourceRoute && !skillRoute) return false;
    if (request.headers["sec-fetch-site"] === "cross-site" || (request.method !== "GET" && !sameOrigin(request))) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return true;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/v1/pi/resources/content") {
        sendJson(response, 200, await this.catalog.read(kind(url.searchParams.get("kind")), url.searchParams.get("id") ?? ""));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/pi/skills") {
        const value = await body(request);
        sendJson(response, 201, await this.catalog.createSkill(value.name));
        return true;
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/pi/skills/content") {
        const value = await body(request);
        sendJson(response, 200, await this.catalog.saveSkill(String(value.id ?? ""), value.text, value.etag));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/pi/skills/duplicate") {
        const value = await body(request);
        sendJson(response, 201, await this.catalog.duplicateSkill(String(value.id ?? ""), value.name));
        return true;
      }
      if (request.method === "PATCH" && url.pathname === "/api/v1/pi/skills") {
        const value = await body(request);
        sendJson(response, 200, await this.catalog.renameSkill(String(value.id ?? ""), value.name, value.etag));
        return true;
      }
      if (request.method === "DELETE" && url.pathname === "/api/v1/pi/skills") {
        const value = await body(request);
        await this.catalog.deleteSkill(String(value.id ?? ""), value.etag);
        sendJson(response, 200, { deleted: true });
        return true;
      }
      sendJson(response, 405, apiError("method_not_allowed", "Method is not allowed"));
      return true;
    } catch (error) {
      if (error instanceof PiResourceError) sendJson(response, error.status, apiError(error.code, error.message));
      else if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") sendJson(response, 409, apiError("resource_exists", "A skill with this name already exists"));
      else sendJson(response, 500, apiError("pi_resource_failed", "Forge could not update the Pi skill", true));
      return true;
    }
  }
}
