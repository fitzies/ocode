export const ANVIL_TERMINAL_PROTOCOL_VERSION = 1 as const;
export type TerminalProtocolVersion = typeof ANVIL_TERMINAL_PROTOCOL_VERSION;

export type ShellTerminalStatus = "running" | "exited" | "interrupted";

export interface ShellTerminalMetadata {
  projectId: string;
  terminalId: string;
  label: string;
  status: ShellTerminalStatus;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  rows: number;
  cols: number;
  pid?: number;
  exitCode?: number;
  exitSignal?: number;
}

interface TerminalClientMessageBase<T extends string> {
  protocolVersion: TerminalProtocolVersion;
  type: T;
  requestId: string;
}

export type TerminalClientMessage =
  | (TerminalClientMessageBase<"terminal.list"> & { projectId: string })
  | (TerminalClientMessageBase<"terminal.open"> & { projectId: string; label?: string })
  | (TerminalClientMessageBase<"terminal.attach"> & { projectId: string; terminalId: string })
  | (TerminalClientMessageBase<"terminal.write"> & { projectId: string; terminalId: string; data: string })
  | (TerminalClientMessageBase<"terminal.resize"> & { projectId: string; terminalId: string; rows: number; cols: number })
  | (TerminalClientMessageBase<"terminal.clear"> & { projectId: string; terminalId: string })
  | (TerminalClientMessageBase<"terminal.close"> & { projectId: string; terminalId: string; deleteHistory?: boolean })
  | (TerminalClientMessageBase<"terminal.restart"> & { projectId: string; terminalId: string });

interface TerminalServerMessageBase<T extends string> {
  protocolVersion: TerminalProtocolVersion;
  type: T;
}

export type TerminalServerMessage =
  | (TerminalServerMessageBase<"terminal.list"> & { requestId: string; projectId: string; terminals: ShellTerminalMetadata[] })
  | (TerminalServerMessageBase<"terminal.open"> & { requestId: string; terminal: ShellTerminalMetadata })
  | (TerminalServerMessageBase<"terminal.snapshot"> & { requestId: string; terminal: ShellTerminalMetadata; history: string; sequence: number })
  | (TerminalServerMessageBase<"terminal.output"> & { projectId: string; terminalId: string; sequence: number; data: string })
  | (TerminalServerMessageBase<"terminal.exit"> & { terminal: ShellTerminalMetadata })
  | (TerminalServerMessageBase<"terminal.metadata"> & { projectId: string; terminalId: string; terminal?: ShellTerminalMetadata; deleted: boolean })
  | (TerminalServerMessageBase<"terminal.clear"> & { requestId: string; terminal: ShellTerminalMetadata })
  | (TerminalServerMessageBase<"terminal.close"> & { requestId: string; projectId: string; terminalId: string; deleted: boolean })
  | (TerminalServerMessageBase<"terminal.restart"> & { requestId: string; terminal: ShellTerminalMetadata })
  | (TerminalServerMessageBase<"terminal.reset"> & { terminal: ShellTerminalMetadata; history: string; sequence: number; reason: "cleared" | "backpressure" })
  | (TerminalServerMessageBase<"terminal.error"> & { requestId?: string; code: string; message: string; retryable: boolean });

const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
export const MIN_TERMINAL_ROWS = 2;
export const MAX_TERMINAL_ROWS = 500;
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 1_000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function envelope(value: unknown): value is Record<string, unknown> {
  return record(value) &&
    value.protocolVersion === ANVIL_TERMINAL_PROTOCOL_VERSION &&
    typeof value.type === "string" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 && value.requestId.length <= 100;
}

function projectId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function terminalId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_ID.test(value);
}

export function isTerminalClientMessage(value: unknown): value is TerminalClientMessage {
  if (!envelope(value) || !projectId(value.projectId)) return false;
  const hasTerminal = terminalId(value.terminalId);
  switch (value.type) {
    case "terminal.list":
      return true;
    case "terminal.open":
      return value.label === undefined || (typeof value.label === "string" && value.label.length > 0 && value.label.length <= 80);
    case "terminal.attach":
    case "terminal.clear":
    case "terminal.restart":
      return hasTerminal;
    case "terminal.write":
      return hasTerminal && typeof value.data === "string" && new TextEncoder().encode(value.data).byteLength <= MAX_TERMINAL_INPUT_BYTES;
    case "terminal.resize":
      return hasTerminal &&
        Number.isSafeInteger(value.rows) && Number(value.rows) >= MIN_TERMINAL_ROWS && Number(value.rows) <= MAX_TERMINAL_ROWS &&
        Number.isSafeInteger(value.cols) && Number(value.cols) >= MIN_TERMINAL_COLS && Number(value.cols) <= MAX_TERMINAL_COLS;
    case "terminal.close":
      return hasTerminal && (value.deleteHistory === undefined || typeof value.deleteHistory === "boolean");
    default:
      return false;
  }
}

export function isShellTerminalMetadata(value: unknown): value is ShellTerminalMetadata {
  return record(value) && projectId(value.projectId) && terminalId(value.terminalId) &&
    typeof value.label === "string" && value.label.length > 0 && value.label.length <= 80 &&
    ["running", "exited", "interrupted"].includes(String(value.status)) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 &&
    Number.isSafeInteger(value.rows) && Number(value.rows) >= MIN_TERMINAL_ROWS && Number(value.rows) <= MAX_TERMINAL_ROWS &&
    Number.isSafeInteger(value.cols) && Number(value.cols) >= MIN_TERMINAL_COLS && Number(value.cols) <= MAX_TERMINAL_COLS;
}

export function isTerminalServerMessage(value: unknown): value is TerminalServerMessage {
  if (!record(value) || value.protocolVersion !== ANVIL_TERMINAL_PROTOCOL_VERSION || typeof value.type !== "string") return false;
  if (value.type === "terminal.error") return typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean";
  if (value.type === "terminal.output") return projectId(value.projectId) && terminalId(value.terminalId) && Number.isSafeInteger(value.sequence) && typeof value.data === "string";
  if (value.type === "terminal.exit") return isShellTerminalMetadata(value.terminal);
  if (value.type === "terminal.metadata") return projectId(value.projectId) && terminalId(value.terminalId) && typeof value.deleted === "boolean" && (value.terminal === undefined || isShellTerminalMetadata(value.terminal));
  if (value.type === "terminal.reset") return isShellTerminalMetadata(value.terminal) && typeof value.history === "string" && Number.isSafeInteger(value.sequence);
  if (typeof value.requestId !== "string") return false;
  if (value.type === "terminal.list") return projectId(value.projectId) && Array.isArray(value.terminals) && value.terminals.every(isShellTerminalMetadata);
  if (["terminal.open", "terminal.clear", "terminal.restart"].includes(value.type)) return isShellTerminalMetadata(value.terminal);
  if (value.type === "terminal.snapshot") return isShellTerminalMetadata(value.terminal) && typeof value.history === "string" && Number.isSafeInteger(value.sequence);
  if (value.type === "terminal.close") return projectId(value.projectId) && terminalId(value.terminalId) && typeof value.deleted === "boolean";
  return false;
}
