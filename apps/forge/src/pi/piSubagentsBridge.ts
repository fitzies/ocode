export const OCODE_SUBAGENT_RPC_COMMAND = "ocode-subagents-rpc";
export const OCODE_SUBAGENT_RPC_REPLY_ENTRY = "ocode.subagents.rpc.reply";

const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_VERSION = 1;
const SUBAGENT_RPC_TIMEOUT_MS = 30_000;
const SUBAGENT_RPC_PING_TIMEOUT_MS = 2_000;
const MAX_SUBAGENT_RPC_ARGUMENT_BYTES = 256 * 1024;
const SUBAGENT_RPC_METHODS = new Set(["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"]);

export interface PiSubagentsBridgeApi {
  registerCommand(name: string, definition: {
    description: string;
    handler(args: string): Promise<void> | void;
  }): void;
  appendEntry(customType: string, data?: unknown): void;
  events: {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
  };
}

interface SubagentRpcRequest {
  version: 1;
  requestId: string;
  method: "ping" | "status" | "spawn" | "steer" | "interrupt" | "stop" | "resume";
  params?: Record<string, unknown>;
}

interface SubagentRpcErrorReply {
  version: 1;
  requestId: string;
  method?: SubagentRpcRequest["method"];
  success: false;
  error: { code: string; message: string };
}

function errorReply(
  requestId: string,
  message: string,
  code = "invalid_request",
  method?: SubagentRpcRequest["method"],
): SubagentRpcErrorReply {
  return {
    version: SUBAGENT_RPC_VERSION,
    requestId,
    ...(method ? { method } : {}),
    success: false,
    error: { code, message },
  };
}

function parseRequest(args: string): SubagentRpcRequest {
  const encoded = args.trim();
  if (!encoded || Buffer.byteLength(encoded) > MAX_SUBAGENT_RPC_ARGUMENT_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Subagent RPC argument must be bounded base64url data");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Subagent RPC argument is not valid encoded JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Subagent RPC request must be an object");
  }
  const request = parsed as Record<string, unknown>;
  if (request.version !== SUBAGENT_RPC_VERSION) throw new Error("Unsupported subagent RPC version");
  if (typeof request.requestId !== "string" || !request.requestId.trim() || /[\r\n]/.test(request.requestId)) {
    throw new Error("Subagent RPC requestId is invalid");
  }
  if (typeof request.method !== "string" || !SUBAGENT_RPC_METHODS.has(request.method)) {
    throw new Error("Unsupported subagent RPC method");
  }
  if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
    throw new Error("Subagent RPC params must be an object");
  }
  return {
    version: SUBAGENT_RPC_VERSION,
    requestId: request.requestId,
    method: request.method as SubagentRpcRequest["method"],
    ...(request.params === undefined ? {} : { params: request.params as Record<string, unknown> }),
  };
}

export function registerPiSubagentsBridge(pi: PiSubagentsBridgeApi): void {
  const pending = new Set<string>();
  pi.registerCommand(OCODE_SUBAGENT_RPC_COMMAND, {
    description: "Internal ocode bridge for pi-subagents",
    handler: async (args) => {
      let request: SubagentRpcRequest;
      try {
        request = parseRequest(args);
      } catch (error) {
        pi.appendEntry(OCODE_SUBAGENT_RPC_REPLY_ENTRY, errorReply(
          "unknown",
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }
      if (pending.has(request.requestId)) {
        pi.appendEntry(OCODE_SUBAGENT_RPC_REPLY_ENTRY, errorReply(
          request.requestId,
          "Subagent RPC requestId is already pending",
          "duplicate_request",
          request.method,
        ));
        return;
      }

      pending.add(request.requestId);
      let unsubscribe: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        const reply = await new Promise<unknown>((resolve) => {
          unsubscribe = pi.events.on(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, resolve) || undefined;
          timer = setTimeout(() => resolve(errorReply(
            request.requestId,
            "pi-subagents RPC timed out",
            "timeout",
            request.method,
          )), request.method === "ping" ? SUBAGENT_RPC_PING_TIMEOUT_MS : SUBAGENT_RPC_TIMEOUT_MS);
          timer.unref?.();
          pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
            ...request,
            source: { extension: "ocode" },
          });
        });
        pi.appendEntry(OCODE_SUBAGENT_RPC_REPLY_ENTRY, reply);
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        pending.delete(request.requestId);
      }
    },
  });
}
