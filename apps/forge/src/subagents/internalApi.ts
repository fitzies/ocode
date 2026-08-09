import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type SubagentRole } from "@anvil/protocol";

import type { RuntimeSessionRecord } from "../store/database.ts";
import { SubagentCoordinator } from "./subagentCoordinator.ts";

const INTERNAL_PATH = "/api/internal/v1/subagents";
const MAX_INTERNAL_REQUEST_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_INTERNAL_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}

export class SubagentInternalApi {
  private readonly secret = randomBytes(32);

  constructor(
    private readonly coordinator: SubagentCoordinator,
    private readonly endpoint: string,
  ) {}

  environment(session: RuntimeSessionRecord): NodeJS.ProcessEnv {
    if (session.session.internal) {
      const environment = { ...process.env };
      delete environment.OCODE_SUBAGENT_ENDPOINT;
      delete environment.OCODE_SUBAGENT_TOKEN;
      delete environment.OCODE_PARENT_SESSION_ID;
      return { ...environment, OCODE_SUBAGENT_DISABLED: "1" };
    }
    const environment = { ...process.env };
    delete environment.OCODE_SUBAGENT_DISABLED;
    return {
      ...environment,
      OCODE_SUBAGENT_ENDPOINT: this.endpoint,
      OCODE_SUBAGENT_TOKEN: this.capability(session.session.id),
      OCODE_PARENT_SESSION_ID: session.session.id,
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname !== INTERNAL_PATH) return false;
    if (request.method !== "POST") {
      sendJson(response, 405, { protocolVersion: ANVIL_PROTOCOL_VERSION, error: "method_not_allowed" });
      return true;
    }
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { protocolVersion: ANVIL_PROTOCOL_VERSION, error: "capability_rejected" });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === "request_too_large" ? 413 : 400, {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        error: "invalid_request",
      });
      return true;
    }
    const parentSessionId = typeof body.parentSessionId === "string" ? body.parentSessionId : "";
    if (!parentSessionId) {
      sendJson(response, 400, { protocolVersion: ANVIL_PROTOCOL_VERSION, error: "parent_session_required" });
      return true;
    }
    if (!this.authorized(request.headers.authorization, parentSessionId)) {
      sendJson(response, 403, { protocolVersion: ANVIL_PROTOCOL_VERSION, error: "capability_rejected" });
      return true;
    }
    try {
      if (body.action === "spawn") {
        if (typeof body.parentToolCallId !== "string" || typeof body.task !== "string") {
          throw new Error("A tool call id and task are required");
        }
        const role = body.role ?? "scout";
        if (!["builder", "scout", "researcher", "reviewer"].includes(String(role))) {
          throw new Error("Unsupported subagent role");
        }
        const run = this.coordinator.launch({
          parentSessionId,
          parentToolCallId: body.parentToolCallId,
          role: role as SubagentRole,
          task: body.task,
        });
        sendJson(response, 202, { runId: run.id, childSessionId: run.childSessionId, status: run.status });
        return true;
      }
      if (body.action === "status") {
        if (typeof body.runId !== "string") throw new Error("A run id is required");
        const run = this.coordinator.status(parentSessionId, body.runId);
        if (!run) {
          sendJson(response, 404, { protocolVersion: ANVIL_PROTOCOL_VERSION, error: "run_not_found" });
        } else {
          sendJson(response, 200, { run });
        }
        return true;
      }
      if (body.action === "cancel") {
        if (typeof body.runId !== "string") throw new Error("A run id is required");
        const run = await this.coordinator.cancel(parentSessionId, body.runId);
        sendJson(response, 200, { run });
        return true;
      }
      throw new Error("Unsupported subagent action");
    } catch (error) {
      sendJson(response, 400, {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private capability(parentSessionId: string): string {
    return createHmac("sha256", this.secret).update(parentSessionId).digest("base64url");
  }

  private authorized(value: string | undefined, parentSessionId: string): boolean {
    if (!value?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(value.slice(7));
    const expected = Buffer.from(this.capability(parentSessionId));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

export function subagentEndpoint(host: "127.0.0.1" | "::1", port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}${INTERNAL_PATH}`;
}
