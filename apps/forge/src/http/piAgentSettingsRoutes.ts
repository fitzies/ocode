import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type AnvilApiError } from "@anvil/protocol";

import { PiResourceError } from "../pi/piCatalogService.ts";
import { sameOrigin } from "./security.ts";

const MAX_BODY_BYTES = 128 * 1024;

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

import { PiAgentSettingsService } from "../pi/piAgentSettingsService.ts";

export class PiAgentSettingsRoutes {
  constructor(private readonly settings: PiAgentSettingsService) {}
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/v1/pi/agent-settings")) return false;
    if (request.headers["sec-fetch-site"] === "cross-site" || (request.method !== "GET" && !sameOrigin(request))) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return true;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/v1/pi/agent-settings") {
        sendJson(response, 200, await this.settings.settings());
      } else if (request.method === "GET" && url.pathname === "/api/v1/pi/agent-settings/models") {
        sendJson(response, 200, await this.settings.models());
      } else if (request.method === "PUT" && url.pathname === "/api/v1/pi/agent-settings/agent") {
        sendJson(response, 200, await this.settings.saveAgent(await body(request)));
      } else if (request.method === "PUT" && url.pathname === "/api/v1/pi/agent-settings/models") {
        sendJson(response, 200, await this.settings.saveModels(await body(request)));
      } else sendJson(response, 405, apiError("method_not_allowed", "Method is not allowed"));
    } catch (error) {
      if (error instanceof PiResourceError) sendJson(response, error.status, apiError(error.code, error.message));
      else if ((error as NodeJS.ErrnoException)?.code === "ENOENT") sendJson(response, 404, apiError("agent_settings_not_found", "Pi settings were not found"));
      else sendJson(response, 500, apiError("agent_settings_failed", "Forge could not access Pi settings", true));
    }
    return true;
  }
}
