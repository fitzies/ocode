import { randomUUID } from "node:crypto";

import { OCODE_SUBAGENT_RPC_COMMAND, OCODE_SUBAGENT_RPC_REPLY_ENTRY } from "../pi/piSubagentsBridge.ts";
import type { RpcRecord } from "../rpc/subprocess.ts";

export { OCODE_SUBAGENT_RPC_COMMAND, OCODE_SUBAGENT_RPC_REPLY_ENTRY };

export type PiSubagentRpcMethod = "ping" | "status" | "spawn" | "steer" | "interrupt" | "stop" | "resume";

export type PiSubagentRpcReply =
  | {
      version: 1;
      requestId: string;
      method?: PiSubagentRpcMethod;
      success: true;
      data: unknown;
    }
  | {
      version: 1;
      requestId: string;
      method?: PiSubagentRpcMethod;
      success: false;
      error: { code: string; message: string };
    };

interface RpcTransport {
  sendRequest(record: RpcRecord): Promise<RpcRecord>;
}

interface PendingRequest {
  resolve(reply: PiSubagentRpcReply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseReply(value: unknown): PiSubagentRpcReply | undefined {
  const reply = recordOf(value);
  if (!reply || reply.version !== 1 || typeof reply.requestId !== "string" || typeof reply.success !== "boolean") {
    return undefined;
  }
  const method = typeof reply.method === "string" ? reply.method as PiSubagentRpcMethod : undefined;
  if (reply.success) {
    return { version: 1, requestId: reply.requestId, ...(method ? { method } : {}), success: true, data: reply.data };
  }
  const error = recordOf(reply.error);
  if (!error || typeof error.code !== "string" || typeof error.message !== "string") return undefined;
  return {
    version: 1,
    requestId: reply.requestId,
    ...(method ? { method } : {}),
    success: false,
    error: { code: error.code, message: error.message },
  };
}

function bridgeReply(record: RpcRecord): PiSubagentRpcReply | undefined {
  if (record.type !== "entry_appended") return undefined;
  const entry = recordOf(record.entry);
  if (entry?.type !== "custom" || entry.customType !== OCODE_SUBAGENT_RPC_REPLY_ENTRY) return undefined;
  return parseReply(entry.data);
}

export class PiSubagentsClient {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly rpc: RpcTransport,
    private readonly timeoutMs = 35_000,
  ) {}

  handleRecord(record: RpcRecord): boolean {
    if (record.type !== "entry_appended") return false;
    const entry = recordOf(record.entry);
    if (entry?.type !== "custom" || entry.customType !== OCODE_SUBAGENT_RPC_REPLY_ENTRY) return false;

    const reply = bridgeReply(record);
    if (!reply) return true;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(reply.requestId);
    pending.resolve(reply);
    return true;
  }

  async stopWorkflow(runId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Workflow id is invalid");
    const response = await this.rpc.sendRequest({ type: "prompt", message: `/subagents-stop ${runId}` });
    if (response.type !== "response" || response.success !== true) {
      throw new Error(typeof response.error === "string" ? response.error : "Pi rejected the subagent stop command");
    }
  }

  async request(method: PiSubagentRpcMethod, params: Record<string, unknown> = {}): Promise<PiSubagentRpcReply> {
    const requestId = randomUUID();
    const reply = new Promise<PiSubagentRpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`pi-subagents bridge timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    const envelope = { version: 1, requestId, method, params };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64url");

    try {
      const command = this.rpc.sendRequest({ type: "prompt", message: `/${OCODE_SUBAGENT_RPC_COMMAND} ${encoded}` });
      const first = await Promise.race([
        command.then((response) => ({ response })),
        reply.then((result) => ({ result })),
      ]);
      if ("response" in first) {
        if (first.response.type !== "response" || first.response.success !== true) {
          throw new Error(typeof first.response.error === "string" ? first.response.error : "Pi rejected the subagent bridge command");
        }
        return await reply;
      }
      const response = await command;
      if (response.type !== "response" || response.success !== true) {
        throw new Error(typeof response.error === "string" ? response.error : "Pi rejected the subagent bridge command");
      }
      return first.result;
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
      throw error;
    }
  }

  close(reason = "Pi session closed"): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
