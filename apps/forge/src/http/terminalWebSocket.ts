import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  ANVIL_TERMINAL_PROTOCOL_VERSION,
  isTerminalClientMessage,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "@anvil/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { TerminalManager, type TerminalAttachment } from "../terminal/terminalManager.ts";
import { authorizedOwner, sameOrigin } from "./security.ts";

const TERMINAL_PATH = "/api/v1/terminals/ws";
const MAX_FRAME_BYTES = 70 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function errorMessage(requestId: string | undefined, error: unknown): TerminalServerMessage {
  const message = error instanceof Error ? error.message : String(error);
  const notFound = /not found|not configured/i.test(message);
  return {
    protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
    type: "terminal.error",
    ...(requestId ? { requestId } : {}),
    code: notFound ? "terminal_not_found" : "terminal_operation_failed",
    message,
    retryable: false,
  };
}

export class TerminalWebSocketChannel {
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly server: Server,
    private readonly terminals: TerminalManager,
    private readonly ownerLogin?: string,
  ) {
    server.on("upgrade", this.onUpgrade);
    this.webSockets.on("connection", this.onConnection);
  }

  async close(): Promise<void> {
    this.server.off("upgrade", this.onUpgrade);
    for (const socket of this.clients) socket.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  private onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    } catch {
      reject(socket, 400, "Bad Request");
      return;
    }
    if (pathname !== TERMINAL_PATH) {
      reject(socket, 404, "Not Found");
      return;
    }
    if (!authorizedOwner(request, this.ownerLogin)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    if (!sameOrigin(request)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSockets.emit("connection", webSocket, request);
    });
  };

  private onConnection = (socket: WebSocket): void => {
    this.clients.add(socket);
    socket.on("error", () => {
      // Protocol and transport errors close the socket; clients reattach from a fresh snapshot.
    });
    const attachments = new Map<string, TerminalAttachment>();
    const watchedProjects = new Set<string>();
    const send = (message: TerminalServerMessage): boolean => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1013, "Terminal client is too slow; reconnect for a fresh snapshot");
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    };
    socket.on("message", (data, binary) => {
      if (binary) {
        send(errorMessage(undefined, new Error("Binary terminal frames are not supported")));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        send(errorMessage(undefined, new Error("Terminal frame is not valid JSON")));
        return;
      }
      if (!isTerminalClientMessage(value)) {
        send(errorMessage(typeof (value as { requestId?: unknown })?.requestId === "string" ? (value as { requestId: string }).requestId : undefined, new Error("Terminal frame does not match the protocol")));
        return;
      }
      void this.handle(value, attachments, watchedProjects, send);
    });
    const onMetadata = (message: Extract<TerminalServerMessage, { type: "terminal.metadata" }>) => {
      if (watchedProjects.has(message.projectId)) send(message);
    };
    this.terminals.on("metadata", onMetadata);
    socket.once("close", () => {
      for (const attachment of attachments.values()) attachment.dispose();
      attachments.clear();
      this.terminals.off("metadata", onMetadata);
      this.clients.delete(socket);
    });
  };

  private async handle(
    message: TerminalClientMessage,
    attachments: Map<string, TerminalAttachment>,
    watchedProjects: Set<string>,
    send: (message: TerminalServerMessage) => boolean,
  ): Promise<void> {
    try {
      switch (message.type) {
        case "terminal.list":
          watchedProjects.add(message.projectId);
          send({
            protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
            type: "terminal.list",
            requestId: message.requestId,
            projectId: message.projectId,
            terminals: this.terminals.list(message.projectId),
          });
          return;
        case "terminal.open": {
          const terminal = this.terminals.open(message.projectId, message.label);
          send({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.open", requestId: message.requestId, terminal });
          return;
        }
        case "terminal.attach": {
          const attachmentKey = `${message.projectId}\0${message.terminalId}`;
          attachments.get(attachmentKey)?.dispose();
          const attachment = this.terminals.attach(message.projectId, message.terminalId, message.requestId, send);
          attachments.set(attachmentKey, attachment);
          if (send(attachment.snapshot)) attachment.start();
          return;
        }
        case "terminal.write":
          this.terminals.write(message.projectId, message.terminalId, message.data);
          return;
        case "terminal.resize":
          this.terminals.resize(message.projectId, message.terminalId, message.cols, message.rows);
          return;
        case "terminal.clear": {
          const terminal = this.terminals.clear(message.projectId, message.terminalId);
          send({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.clear", requestId: message.requestId, terminal });
          return;
        }
        case "terminal.close": {
          attachments.get(`${message.projectId}\0${message.terminalId}`)?.dispose();
          attachments.delete(`${message.projectId}\0${message.terminalId}`);
          const deleted = await this.terminals.close(message.projectId, message.terminalId, message.deleteHistory);
          send({
            protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION,
            type: "terminal.close",
            requestId: message.requestId,
            projectId: message.projectId,
            terminalId: message.terminalId,
            deleted,
          });
          return;
        }
        case "terminal.restart": {
          const terminal = this.terminals.restart(message.projectId, message.terminalId);
          send({ protocolVersion: ANVIL_TERMINAL_PROTOCOL_VERSION, type: "terminal.restart", requestId: message.requestId, terminal });
          return;
        }
      }
    } catch (error) {
      send(errorMessage(message.requestId, error));
    }
  }
}

export const TERMINAL_WEBSOCKET_LIMITS = {
  frameBytes: MAX_FRAME_BYTES,
  bufferedBytes: MAX_BUFFERED_BYTES,
} as const;
