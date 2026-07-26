export const ANVIL_PROTOCOL_VERSION = 6 as const;
export type ProtocolVersion = typeof ANVIL_PROTOCOL_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ConnectionState = "connected" | "reconnecting" | "offline";
export type SessionStatus = "idle" | "running" | "waiting" | "failed";
export type RunOutcome = "completed" | "failed" | "cancelled";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type EntryStatus = "streaming" | "complete" | "failed" | "cancelled";
export type ToolStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  branch?: string;
  /** User-controlled resolution state. Missing on legacy sessions means unsettled. */
  settled?: boolean;
  /** Global Forge event sequence for the latest meaningful lifecycle activity. */
  lastActivitySequence?: number;
  /** Global Forge event sequence for the latest terminal run transition. */
  lastTerminalSequence?: number;
  lastTerminalOutcome?: RunOutcome;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  supportedThinkingLevels: ThinkingLevel[];
}

export interface CommandDescriptor {
  name: string;
  description?: string;
  source: "extension" | "prompt";
  location?: "user" | "project" | "path";
  path?: string;
}

export interface SkillDescriptor {
  name: string;
  command: string;
  description?: string;
  location?: "user" | "project" | "path";
  path?: string;
}

export interface CapabilityCatalog {
  models: ModelDescriptor[];
  commands: CommandDescriptor[];
  skills: SkillDescriptor[];
  modelsReady?: boolean;
}

export interface TextContentBlock {
  id: string;
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  id: string;
  type: "image";
  mimeType: string;
  alt?: string;
  name?: string;
  url?: string;
  data?: string;
}

export interface DataContentBlock {
  id: string;
  type: "data";
  label?: string;
  data: JsonValue;
}

export interface ToolCallContentBlock {
  id: string;
  type: "toolCall";
  toolCallId: string;
  name: string;
  arguments: JsonValue;
}

export interface UnknownContentBlock {
  id: string;
  type: "unknown";
  contentType: string;
  raw: JsonValue;
}

export interface ArtifactContentBlock {
  id: string;
  type: "artifact";
  artifactId: string;
  url: string;
  mediaType: string;
  byteLength: number;
  name?: string;
  preview?: string;
}

export interface ArtifactReference {
  type: "artifactReference";
  artifactId: string;
  url: string;
  mediaType: string;
  byteLength: number;
  name?: string;
}

export interface InlineHtmlContentBlock {
  id: string;
  type: "inlineHtml";
  title: string;
  html: string;
  sourcePath?: string;
  byteLength: number;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | DataContentBlock
  | ToolCallContentBlock
  | UnknownContentBlock
  | ArtifactContentBlock
  | InlineHtmlContentBlock;

interface TimelineEntryBase {
  id: string;
  createdAt: string;
  raw?: JsonValue;
}

export interface MessageEntry extends TimelineEntryBase {
  kind: "message";
  role: "user" | "assistant" | "system" | "extension";
  content: ContentBlock[];
  status: EntryStatus;
  modelId?: string;
  error?: string;
}

export interface ReasoningEntry extends TimelineEntryBase {
  kind: "reasoning";
  messageId: string;
  content: string;
  status: EntryStatus;
}

export interface ToolEntry extends TimelineEntryBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  label?: string;
  summary: string;
  status: ToolStatus;
  arguments: JsonValue;
  output: ContentBlock[];
  details?: JsonValue;
  startedAt?: string;
  endedAt?: string;
  batchId?: string;
}

export type EventTone = "neutral" | "info" | "success" | "warning" | "error";
export type SystemEventCategory =
  | "notification"
  | "status"
  | "widget"
  | "lifecycle"
  | "error"
  | "unknown";

export interface SystemEventEntry extends TimelineEntryBase {
  kind: "event";
  category: SystemEventCategory;
  tone: EventTone;
  title: string;
  message?: string;
  source?: string;
  details?: JsonValue;
}

export interface InteractionTimelineEntry extends TimelineEntryBase {
  kind: "interaction";
  requestId: string;
  method: InteractionMethod;
  title: string;
  status: "pending" | "answered" | "cancelled" | "unsupported";
  summary?: string;
}

export type TimelineEntry =
  | MessageEntry
  | ReasoningEntry
  | ToolEntry
  | SystemEventEntry
  | InteractionTimelineEntry;

export interface InteractionOption {
  id: string;
  label: string;
  value: string;
  description?: string;
}

interface InteractionRequestBase {
  id: string;
  sessionId: string;
  title: string;
  message?: string;
  requestedAt: string;
  timeoutMs?: number;
  raw?: JsonValue;
}

export interface SelectInteractionRequest extends InteractionRequestBase {
  method: "select";
  options: InteractionOption[];
}

export interface MultiSelectInteractionRequest extends InteractionRequestBase {
  method: "multiSelect";
  options: InteractionOption[];
  minSelections?: number;
  maxSelections?: number;
}

export interface ConfirmInteractionRequest extends InteractionRequestBase {
  method: "confirm";
}

export interface InputInteractionRequest extends InteractionRequestBase {
  method: "input";
  placeholder?: string;
  defaultValue?: string;
}

export interface EditorInteractionRequest extends InteractionRequestBase {
  method: "editor";
  value?: string;
  language?: string;
}

export type GenericInteractionField =
  | {
      id: string;
      label: string;
      type: "text" | "textarea";
      required?: boolean;
      placeholder?: string;
      defaultValue?: string;
    }
  | {
      id: string;
      label: string;
      type: "boolean";
      defaultValue?: boolean;
    }
  | {
      id: string;
      label: string;
      type: "select" | "multiSelect";
      required?: boolean;
      options: InteractionOption[];
    };

export interface UnknownInteractionRequest extends InteractionRequestBase {
  method: "unknown";
  originalMethod: string;
  fields?: GenericInteractionField[];
}

export type InteractionRequest =
  | SelectInteractionRequest
  | MultiSelectInteractionRequest
  | ConfirmInteractionRequest
  | InputInteractionRequest
  | EditorInteractionRequest
  | UnknownInteractionRequest;

export type InteractionMethod = InteractionRequest["method"];

export interface InteractionResponse {
  requestId: string;
  value?: JsonValue;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface ExtensionStatus {
  sessionId: string;
  key: string;
  text: string;
  source?: string;
  updatedAt: string;
}

export interface ExtensionWidget {
  sessionId: string;
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
  updatedAt: string;
}

export interface SessionQueue {
  steering: string[];
  followUp: string[];
}

export interface SequenceGap {
  expected: number;
  received: number;
  detectedAt: string;
}

export type DurableRunState = "idle" | "running" | "failed";

export interface AnvilSnapshot {
  protocolVersion: ProtocolVersion;
  capturedAt: string;
  connection: ConnectionState;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  timelines: Record<string, TimelineEntry[]>;
  catalogs: Record<string, CapabilityCatalog>;
  pendingInteractions: InteractionRequest[];
  extensionStatuses: ExtensionStatus[];
  widgets: ExtensionWidget[];
  queues: Record<string, SessionQueue>;
  composerDrafts: Record<string, string>;
  runStates: Record<string, DurableRunState>;
  lastSequence: number;
  sequenceGap: SequenceGap | null;
}

export interface AnvilBootstrap {
  protocolVersion: ProtocolVersion;
  snapshot: AnvilSnapshot;
  events: AnvilEvent[];
  cursor: number;
}

/** Lightweight bootstrap used by live clients. Thread details are loaded separately. */
export interface AnvilSummaryBootstrap {
  protocolVersion: ProtocolVersion;
  capturedAt: string;
  connection: ConnectionState;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  cursor: number;
}

export interface AnvilSessionDetail {
  protocolVersion: ProtocolVersion;
  sessionId: string;
  throughSequence: number;
  timeline: TimelineEntry[];
  catalog: CapabilityCatalog;
  pendingInteractions: InteractionRequest[];
  extensionStatuses: ExtensionStatus[];
  widgets: ExtensionWidget[];
  queue: SessionQueue;
  composerDraft: string;
  runState: DurableRunState;
}

export type AnvilSessionDetailSync =
  | {
      protocolVersion: ProtocolVersion;
      mode: "reset";
      detail: AnvilSessionDetail;
    }
  | {
      protocolVersion: ProtocolVersion;
      mode: "delta";
      sessionId: string;
      fromSequence: number;
      throughSequence: number;
      events: AnvilEvent[];
    };

export interface AnvilStreamReset {
  protocolVersion: ProtocolVersion;
  reason: "cursor_invalid" | "cursor_expired" | "server_reset";
  cursor: number;
}

export interface AnvilApiError {
  protocolVersion: ProtocolVersion;
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

interface AnvilEventBase<TType extends string, TPayload> {
  protocolVersion: ProtocolVersion;
  id: string;
  sequence: number;
  sessionId: string | null;
  timestamp: string;
  type: TType;
  payload: TPayload;
  raw?: JsonValue;
}

export type AnvilEvent =
  | AnvilEventBase<"connection.changed", { connection: ConnectionState }>
  | AnvilEventBase<"catalog.updated", { catalog: CapabilityCatalog }>
  | AnvilEventBase<"project.upserted", { project: ProjectSummary }>
  | AnvilEventBase<"session.upserted", { session: SessionSummary }>
  | AnvilEventBase<"session.deleted", { sessionId: string }>
  | AnvilEventBase<"session.settled", { settled: boolean }>
  | AnvilEventBase<"session.selected", { sessionId: string }>
  | AnvilEventBase<
      "session.configured",
      { modelId?: string; thinkingLevel?: ThinkingLevel; title?: string; branch?: string | null }
    >
  | AnvilEventBase<"run.status", { status: DurableRunState; message?: string; outcome?: RunOutcome }>
  | AnvilEventBase<"message.started", { message: MessageEntry }>
  | AnvilEventBase<
      "message.delta",
      {
        messageId: string;
        blockId: string;
        delta: string;
        modelId?: string;
        artifact?: ArtifactContentBlock;
      }
    >
  | AnvilEventBase<
      "message.completed",
      { messageId: string; content?: ContentBlock[]; status?: EntryStatus; error?: string }
    >
  | AnvilEventBase<
      "stream.marker",
      {
        messageId: string;
        markerType: string;
        contentIndex?: number;
        data?: JsonValue;
      }
    >
  | AnvilEventBase<"reasoning.started", { reasoning: ReasoningEntry }>
  | AnvilEventBase<"reasoning.delta", { reasoningId: string; delta: string }>
  | AnvilEventBase<
      "reasoning.completed",
      { reasoningId: string; content?: string; status?: EntryStatus }
    >
  | AnvilEventBase<"tool.started", { tool: ToolEntry }>
  | AnvilEventBase<
      "tool.updated",
      { toolCallId: string; output: ContentBlock[]; details?: JsonValue }
    >
  | AnvilEventBase<
      "tool.completed",
      {
        toolCallId: string;
        output: ContentBlock[];
        details?: JsonValue;
        status: Exclude<ToolStatus, "queued" | "running">;
      }
    >
  | AnvilEventBase<"timeline.event", { entry: SystemEventEntry }>
  | AnvilEventBase<"interaction.requested", { request: InteractionRequest }>
  | AnvilEventBase<
      "interaction.resolved",
      {
        requestId: string;
        status: "answered" | "cancelled" | "unsupported";
        response?: InteractionResponse;
      }
    >
  | AnvilEventBase<"extension.status", { key: string; text?: string; source?: string }>
  | AnvilEventBase<
      "extension.widget",
      { key: string; lines?: string[]; placement?: "aboveEditor" | "belowEditor" }
    >
  | AnvilEventBase<"composer.prefill", { text: string }>
  | AnvilEventBase<"queue.updated", SessionQueue>
  | AnvilEventBase<"unknown", { eventType: string; payload: JsonValue }>;

export type PromptDelivery = "prompt" | "steer" | "followUp";

interface AnvilCommandBase<TType extends string, TPayload> {
  protocolVersion: ProtocolVersion;
  id: string;
  sessionId: string | null;
  timestamp: string;
  type: TType;
  payload: TPayload;
}

export type AnvilClientCommand =
  | AnvilCommandBase<"project.create", { name: string; path: string }>
  | AnvilCommandBase<"session.select", { sessionId: string }>
  | AnvilCommandBase<"session.create", { projectId: string; sessionId: string; parentSessionId?: string }>
  | AnvilCommandBase<"session.delete", { sessionId: string }>
  | AnvilCommandBase<"session.settled", { settled: boolean }>
  | AnvilCommandBase<
      "prompt.send",
      {
        content: string;
        delivery: PromptDelivery;
        images?: ImageContentBlock[];
        attachments?: ArtifactReference[];
      }
    >
  | AnvilCommandBase<"run.cancel", Record<string, never>>
  | AnvilCommandBase<"model.set", { modelId: string }>
  | AnvilCommandBase<"thinking.set", { level: ThinkingLevel }>
  | AnvilCommandBase<"interaction.respond", InteractionResponse>;

export interface AnvilCommandResponse {
  protocolVersion: ProtocolVersion;
  id: string;
  commandId: string;
  timestamp: string;
  success: boolean;
  outcome?: "completed" | "unknown";
  data?: JsonValue;
  error?: string;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

const ANVIL_EVENT_TYPES = new Set<AnvilEvent["type"]>([
  "connection.changed",
  "catalog.updated",
  "project.upserted",
  "session.upserted",
  "session.deleted",
  "session.settled",
  "session.selected",
  "session.configured",
  "run.status",
  "message.started",
  "message.delta",
  "message.completed",
  "stream.marker",
  "reasoning.started",
  "reasoning.delta",
  "reasoning.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "timeline.event",
  "interaction.requested",
  "interaction.resolved",
  "extension.status",
  "extension.widget",
  "composer.prefill",
  "queue.updated",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, ...keys: string[]) {
  return keys.every((key) => typeof value[key] === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return isRecord(value) &&
    value.type === "artifactReference" &&
    hasStrings(value, "artifactId", "url", "mediaType") &&
    value.url === `/api/v1/artifacts/${String(value.artifactId)}` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.artifactId)) &&
    Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 &&
    (value.name === undefined || typeof value.name === "string");
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, "id", "type")) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.mimeType === "string" &&
        (value.data === undefined || typeof value.data === "string") &&
        (value.url === undefined || typeof value.url === "string");
    case "data":
      return isJsonValue(value.data);
    case "toolCall":
      return hasStrings(value, "toolCallId", "name") && isJsonValue(value.arguments);
    case "unknown":
      return typeof value.contentType === "string" && isJsonValue(value.raw);
    case "artifact":
      return hasStrings(value, "artifactId", "url", "mediaType") &&
        /^\/[a-z0-9/_-]+$/i.test(String(value.url)) &&
        value.url === `/api/v1/artifacts/${String(value.artifactId)}` &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.artifactId)) &&
        Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 &&
        (value.name === undefined || typeof value.name === "string") &&
        (value.preview === undefined || typeof value.preview === "string");
    case "inlineHtml":
      return hasStrings(value, "title", "html") &&
        Number.isSafeInteger(value.byteLength) &&
        Number(value.byteLength) === new TextEncoder().encode(String(value.html)).byteLength &&
        Number(value.byteLength) <= 192 * 1024 &&
        (value.sourcePath === undefined || typeof value.sourcePath === "string");
    default:
      return false;
  }
}

function isModelDescriptor(value: unknown): boolean {
  return isRecord(value) &&
    hasStrings(value, "id", "provider", "name") &&
    typeof value.reasoning === "boolean" &&
    isStringArray(value.input) &&
    value.input.every((item) => item === "text" || item === "image") &&
    isStringArray(value.supportedThinkingLevels) &&
    value.supportedThinkingLevels.every((level) => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level));
}

function isCapabilityCatalog(value: unknown): boolean {
  return isRecord(value) &&
    Array.isArray(value.models) && value.models.every(isModelDescriptor) &&
    Array.isArray(value.commands) && value.commands.every((item) => isRecord(item) && hasStrings(item, "name", "source")) &&
    Array.isArray(value.skills) && value.skills.every((item) => isRecord(item) && hasStrings(item, "name", "command")) &&
    (value.modelsReady === undefined || typeof value.modelsReady === "boolean");
}

function isSessionSummary(value: unknown): boolean {
  return isRecord(value) &&
    hasStrings(value, "id", "projectId", "title", "updatedAt", "status", "modelId", "thinkingLevel") &&
    ["idle", "running", "waiting", "failed"].includes(String(value.status)) &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thinkingLevel)) &&
    (value.settled === undefined || typeof value.settled === "boolean") &&
    (value.lastActivitySequence === undefined || (Number.isSafeInteger(value.lastActivitySequence) && Number(value.lastActivitySequence) >= 0)) &&
    (value.lastTerminalSequence === undefined || (Number.isSafeInteger(value.lastTerminalSequence) && Number(value.lastTerminalSequence) > 0)) &&
    (value.lastTerminalOutcome === undefined || ["completed", "failed", "cancelled"].includes(String(value.lastTerminalOutcome)));
}

function isInteractionOption(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, "id", "label", "value") &&
    (value.description === undefined || typeof value.description === "string");
}

function isInteractionRequest(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, "id", "sessionId", "method", "title", "requestedAt")) return false;
  if (!["select", "multiSelect", "confirm", "input", "editor", "unknown"].includes(String(value.method))) return false;
  if ((value.method === "select" || value.method === "multiSelect") &&
      (!Array.isArray(value.options) || !value.options.every(isInteractionOption))) return false;
  if (value.method === "unknown" && typeof value.originalMethod !== "string") return false;
  return true;
}

function isTimelineEntry(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, "id", "kind", "createdAt")) return false;
  if (value.raw !== undefined && !isJsonValue(value.raw)) return false;
  switch (value.kind) {
    case "message":
      return hasStrings(value, "role", "status") &&
        ["user", "assistant", "system", "extension"].includes(String(value.role)) &&
        ["streaming", "complete", "failed", "cancelled"].includes(String(value.status)) &&
        Array.isArray(value.content) && value.content.every(isContentBlock) &&
        (value.error === undefined || typeof value.error === "string");
    case "reasoning":
      return hasStrings(value, "messageId", "content", "status") &&
        ["streaming", "complete", "failed", "cancelled"].includes(String(value.status));
    case "tool":
      return hasStrings(value, "toolCallId", "name", "summary", "status") &&
        ["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status)) &&
        isJsonValue(value.arguments) &&
        Array.isArray(value.output) && value.output.every(isContentBlock) &&
        (value.details === undefined || isJsonValue(value.details));
    case "event":
      return hasStrings(value, "category", "tone", "title") &&
        ["notification", "status", "widget", "lifecycle", "error", "unknown"].includes(String(value.category)) &&
        ["neutral", "info", "success", "warning", "error"].includes(String(value.tone)) &&
        (value.details === undefined || isJsonValue(value.details));
    case "interaction":
      return hasStrings(value, "requestId", "method", "title", "status") &&
        ["select", "multiSelect", "confirm", "input", "editor", "unknown"].includes(String(value.method)) &&
        ["pending", "answered", "cancelled", "unsupported"].includes(String(value.status));
    default:
      return false;
  }
}

function isExtensionStatus(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, "sessionId", "key", "text", "updatedAt") &&
    (value.source === undefined || typeof value.source === "string");
}

function isExtensionWidget(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, "sessionId", "key", "placement", "updatedAt") &&
    ["aboveEditor", "belowEditor"].includes(String(value.placement)) &&
    isStringArray(value.lines);
}

function isSessionQueue(value: unknown): boolean {
  return isRecord(value) && isStringArray(value.steering) && isStringArray(value.followUp);
}

function isEventPayload(type: AnvilEvent["type"], value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (type) {
    case "connection.changed":
      return ["connected", "reconnecting", "offline"].includes(String(value.connection));
    case "catalog.updated":
      return isCapabilityCatalog(value.catalog);
    case "project.upserted":
      return isRecord(value.project) && hasStrings(value.project, "id", "name", "path");
    case "session.upserted":
      return isSessionSummary(value.session);
    case "session.deleted":
      return hasStrings(value, "sessionId");
    case "session.settled":
      return typeof value.settled === "boolean";
    case "session.selected":
      return hasStrings(value, "sessionId");
    case "session.configured":
      return (value.modelId === undefined || typeof value.modelId === "string") &&
        (value.thinkingLevel === undefined || ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thinkingLevel))) &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.branch === undefined || value.branch === null || typeof value.branch === "string");
    case "run.status":
      return ["idle", "running", "failed"].includes(String(value.status)) &&
        (value.outcome === undefined || ["completed", "failed", "cancelled"].includes(String(value.outcome)));
    case "message.started":
      return isRecord(value.message) && value.message.kind === "message" &&
        hasStrings(value.message, "id", "role", "status", "createdAt") &&
        Array.isArray(value.message.content) && value.message.content.every(isContentBlock);
    case "message.delta":
      return hasStrings(value, "messageId", "blockId", "delta") &&
        (value.artifact === undefined || (
          isRecord(value.artifact) && isContentBlock(value.artifact) && value.artifact.type === "artifact"
        ));
    case "message.completed":
      return hasStrings(value, "messageId") &&
        (value.content === undefined || (Array.isArray(value.content) && value.content.every(isContentBlock)));
    case "stream.marker":
      return hasStrings(value, "messageId", "markerType");
    case "reasoning.started":
      return isRecord(value.reasoning) && value.reasoning.kind === "reasoning" && hasStrings(value.reasoning, "id", "messageId", "content", "status", "createdAt");
    case "reasoning.delta":
      return hasStrings(value, "reasoningId", "delta");
    case "reasoning.completed":
      return hasStrings(value, "reasoningId");
    case "tool.started":
      return isRecord(value.tool) && value.tool.kind === "tool" &&
        hasStrings(value.tool, "id", "toolCallId", "name", "summary", "status", "createdAt") &&
        isJsonValue(value.tool.arguments) &&
        Array.isArray(value.tool.output) && value.tool.output.every(isContentBlock) &&
        (value.tool.details === undefined || isJsonValue(value.tool.details));
    case "tool.updated":
      return hasStrings(value, "toolCallId") &&
        Array.isArray(value.output) && value.output.every(isContentBlock) &&
        (value.details === undefined || isJsonValue(value.details));
    case "tool.completed":
      return hasStrings(value, "toolCallId", "status") &&
        Array.isArray(value.output) && value.output.every(isContentBlock) &&
        (value.details === undefined || isJsonValue(value.details)) &&
        ["completed", "failed", "cancelled"].includes(String(value.status));
    case "timeline.event":
      return isRecord(value.entry) && value.entry.kind === "event" && hasStrings(value.entry, "id", "title", "category", "tone", "createdAt");
    case "interaction.requested":
      return isInteractionRequest(value.request);
    case "interaction.resolved":
      return hasStrings(value, "requestId", "status") && ["answered", "cancelled", "unsupported"].includes(String(value.status));
    case "extension.status":
      return hasStrings(value, "key");
    case "extension.widget":
      return hasStrings(value, "key") && (value.lines === undefined || Array.isArray(value.lines));
    case "composer.prefill":
      return hasStrings(value, "text");
    case "queue.updated":
      return Array.isArray(value.steering) && Array.isArray(value.followUp);
    case "unknown":
      return hasStrings(value, "eventType") && isJsonValue(value.payload);
  }
}

function hasEventEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === ANVIL_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 0 &&
    (value.sessionId === null || typeof value.sessionId === "string") &&
    typeof value.timestamp === "string" &&
    typeof value.type === "string"
  );
}

export function isAnvilEvent(value: unknown): value is AnvilEvent {
  if (!hasEventEnvelope(value)) return false;
  if (!ANVIL_EVENT_TYPES.has(value.type as AnvilEvent["type"])) return false;
  if (!isJsonValue(value.payload)) return false;
  if (value.raw !== undefined && !isJsonValue(value.raw)) return false;
  if (value.type === "catalog.updated" && typeof value.sessionId !== "string") return false;
  return isEventPayload(value.type as AnvilEvent["type"], value.payload);
}

export function decodeAnvilEvent(value: unknown): AnvilEvent | undefined {
  if (!hasEventEnvelope(value)) return undefined;
  if (isAnvilEvent(value)) return value;
  const payload = isJsonValue(value.payload) ? value.payload : null;
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: value.id as string,
    sequence: value.sequence as number,
    sessionId: value.sessionId as string | null,
    timestamp: value.timestamp as string,
    type: "unknown",
    payload: { eventType: String(value.type), payload },
  };
}

export function isAnvilClientCommand(value: unknown): value is AnvilClientCommand {
  if (
    !isRecord(value) ||
    value.protocolVersion !== ANVIL_PROTOCOL_VERSION ||
    !hasStrings(value, "id", "timestamp", "type") ||
    !(value.sessionId === null || typeof value.sessionId === "string") ||
    !isRecord(value.payload)
  ) {
    return false;
  }

  const payload = value.payload;
  switch (value.type) {
    case "project.create":
      return value.sessionId === null && hasStrings(payload, "name", "path");
    case "session.select":
      return hasStrings(payload, "sessionId");
    case "session.create":
      return value.sessionId === null &&
        hasStrings(payload, "projectId", "sessionId") &&
        (payload.parentSessionId === undefined || typeof payload.parentSessionId === "string");
    case "session.delete":
      return value.sessionId === null && hasStrings(payload, "sessionId");
    case "session.settled":
      return typeof value.sessionId === "string" && typeof payload.settled === "boolean";
    case "prompt.send":
      return typeof value.sessionId === "string" &&
        hasStrings(payload, "content", "delivery") &&
        ["prompt", "steer", "followUp"].includes(String(payload.delivery)) &&
        (payload.images === undefined ||
          (Array.isArray(payload.images) &&
            payload.images.every((image) => isRecord(image) && image.type === "image" && isContentBlock(image)))) &&
        (payload.attachments === undefined ||
          (Array.isArray(payload.attachments) && payload.attachments.every(isArtifactReference)));
    case "run.cancel":
      return typeof value.sessionId === "string" && Object.keys(payload).length === 0;
    case "model.set":
      return typeof value.sessionId === "string" && hasStrings(payload, "modelId");
    case "thinking.set":
      return typeof value.sessionId === "string" &&
        typeof payload.level === "string" &&
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(payload.level);
    case "interaction.respond":
      return typeof value.sessionId === "string" &&
        hasStrings(payload, "requestId") &&
        (payload.value === undefined || isJsonValue(payload.value)) &&
        (payload.confirmed === undefined || typeof payload.confirmed === "boolean") &&
        (payload.cancelled === undefined || typeof payload.cancelled === "boolean");
    default:
      return false;
  }
}

export function isAnvilSnapshot(value: unknown): value is AnvilSnapshot {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  return value.protocolVersion === ANVIL_PROTOCOL_VERSION &&
    typeof value.capturedAt === "string" &&
    ["connected", "reconnecting", "offline"].includes(String(value.connection)) &&
    Array.isArray(value.projects) &&
    value.projects.every((project) => isRecord(project) && hasStrings(project, "id", "name", "path")) &&
    Array.isArray(value.sessions) && value.sessions.every(isSessionSummary) &&
    (value.activeSessionId === null || typeof value.activeSessionId === "string") &&
    isRecord(value.timelines) && Object.values(value.timelines).every(
      (timeline) => Array.isArray(timeline) && timeline.every(isTimelineEntry)
    ) &&
    isRecord(value.catalogs) &&
    Object.values(value.catalogs).every(isCapabilityCatalog) &&
    Array.isArray(value.pendingInteractions) && value.pendingInteractions.every(isInteractionRequest) &&
    Array.isArray(value.extensionStatuses) && value.extensionStatuses.every(isExtensionStatus) &&
    Array.isArray(value.widgets) && value.widgets.every(isExtensionWidget) &&
    isRecord(value.queues) && Object.values(value.queues).every(isSessionQueue) &&
    isRecord(value.composerDrafts) && Object.values(value.composerDrafts).every((draft) => typeof draft === "string") &&
    isRecord(value.runStates) && Object.values(value.runStates).every(
      (state) => ["idle", "running", "failed"].includes(String(state))
    ) &&
    Number.isSafeInteger(value.lastSequence) && Number(value.lastSequence) >= 0 &&
    (value.sequenceGap === null ||
      (isRecord(value.sequenceGap) &&
        Number.isSafeInteger(value.sequenceGap.expected) &&
        Number.isSafeInteger(value.sequenceGap.received) &&
        typeof value.sequenceGap.detectedAt === "string"));
}

export function isAnvilBootstrap(value: unknown): value is AnvilBootstrap {
  if (
    !isRecord(value) ||
    value.protocolVersion !== ANVIL_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    !isAnvilSnapshot(value.snapshot) ||
    !Array.isArray(value.events) ||
    !value.events.every(isAnvilEvent)
  ) {
    return false;
  }
  const snapshot = value.snapshot;
  const cursor = Number(value.cursor);
  return snapshot.lastSequence <= cursor &&
    value.events.every((event) =>
      event.sequence > snapshot.lastSequence && event.sequence <= cursor
    );
}

export function isAnvilSummaryBootstrap(value: unknown): value is AnvilSummaryBootstrap {
  return isRecord(value) &&
    value.protocolVersion === ANVIL_PROTOCOL_VERSION &&
    typeof value.capturedAt === "string" &&
    ["connected", "reconnecting", "offline"].includes(String(value.connection)) &&
    Array.isArray(value.projects) &&
    value.projects.every((project) => isRecord(project) && hasStrings(project, "id", "name", "path")) &&
    Array.isArray(value.sessions) && value.sessions.every(isSessionSummary) &&
    Number.isSafeInteger(value.cursor) && Number(value.cursor) >= 0;
}

export function isAnvilSessionDetail(value: unknown): value is AnvilSessionDetail {
  if (!isRecord(value) || !isJsonValue(value) || typeof value.sessionId !== "string") return false;
  const sessionId = value.sessionId;
  return value.protocolVersion === ANVIL_PROTOCOL_VERSION &&
    Number.isSafeInteger(value.throughSequence) && Number(value.throughSequence) >= 0 &&
    Array.isArray(value.timeline) && value.timeline.every(isTimelineEntry) &&
    isCapabilityCatalog(value.catalog) &&
    Array.isArray(value.pendingInteractions) && value.pendingInteractions.every(
      (request) => isRecord(request) && isInteractionRequest(request) && request.sessionId === sessionId
    ) &&
    Array.isArray(value.extensionStatuses) && value.extensionStatuses.every(
      (status) => isRecord(status) && isExtensionStatus(status) && status.sessionId === sessionId
    ) &&
    Array.isArray(value.widgets) && value.widgets.every(
      (widget) => isRecord(widget) && isExtensionWidget(widget) && widget.sessionId === sessionId
    ) &&
    isSessionQueue(value.queue) &&
    typeof value.composerDraft === "string" &&
    ["idle", "running", "failed"].includes(String(value.runState));
}

export function isAnvilSessionDetailSync(value: unknown): value is AnvilSessionDetailSync {
  if (!isRecord(value) || value.protocolVersion !== ANVIL_PROTOCOL_VERSION) return false;
  if (value.mode === "reset") return isAnvilSessionDetail(value.detail);
  return value.mode === "delta" &&
    typeof value.sessionId === "string" &&
    Number.isSafeInteger(value.fromSequence) && Number(value.fromSequence) >= 0 &&
    Number.isSafeInteger(value.throughSequence) && Number(value.throughSequence) >= Number(value.fromSequence) &&
    Array.isArray(value.events) && value.events.every(isAnvilEvent) &&
    value.events.every((event) => event.sessionId === value.sessionId && event.sequence > Number(value.fromSequence) && event.sequence <= Number(value.throughSequence));
}
