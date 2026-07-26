import {
  type AnvilEvent,
  type CapabilityCatalog,
  type ContentBlock,
  type GenericInteractionField,
  type InteractionOption,
  type InteractionRequest,
  type JsonValue,
  type MessageEntry,
  normalizeProjectResourcePath,
} from "@anvil/protocol";

export type UnsequencedAnvilEvent = {
  [TType in AnvilEvent["type"]]: Omit<
    Extract<AnvilEvent, { type: TType }>,
    "protocolVersion" | "id" | "sequence"
  >;
}[AnvilEvent["type"]];

export interface PiRpcAdapterState {
  fixtureId: string;
  sessionId: string;
  nextSequence: number;
  baseTimestamp: number;
  activeAssistantMessageId?: string;
  lastAssistantMessageId?: string;
  reasoningIds: Record<number, string>;
  catalog: CapabilityCatalog;
  knownToolCallIds: Set<string>;
  extensionStatuses: Map<string, string | undefined>;
  extensionWidgets: Map<string, { lines: string[] | undefined; placement: "aboveEditor" | "belowEditor" }>;
  terminalOutcomeInCurrentRun?: "failed" | "cancelled";
}

export interface RecordedRpcItem {
  at: number;
  record: Record<string, unknown>;
}

export function createPiRpcAdapterState(input: {
  fixtureId: string;
  sessionId: string;
  baseTimestamp: string;
}): PiRpcAdapterState {
  return {
    fixtureId: input.fixtureId,
    sessionId: input.sessionId,
    nextSequence: 1,
    baseTimestamp: new Date(input.baseTimestamp).getTime(),
    reasoningIds: {},
    catalog: { models: [], commands: [], skills: [], modelsReady: false },
    knownToolCallIds: new Set(),
    extensionStatuses: new Map(),
    extensionWidgets: new Map(),
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function messageId(message: Record<string, unknown>, state: PiRpcAdapterState): string {
  const direct = stringOf(message.id);
  if (direct) return direct;
  const timestamp = numberOf(message.timestamp);
  return timestamp ? `message-${timestamp}` : `message-${state.fixtureId}-${state.nextSequence}`;
}

function contentBlocks(value: unknown, prefix: string): ContentBlock[] {
  if (typeof value === "string") return [{ id: `${prefix}-text-0`, type: "text", text: value }];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item, index): ContentBlock[] => {
    const block = recordOf(item);
    const type = stringOf(block.type, "unknown");
    const id = `${prefix}-${type}-${index}`;
    if (type === "text") return [{ id, type: "text", text: stringOf(block.text) }];
    if (type === "image") {
      const source = recordOf(block.source);
      return [
        {
          id,
          type: "image",
          mimeType: stringOf(block.mimeType, stringOf(source.mediaType, "image/png")),
          data: stringOf(block.data, stringOf(source.data)) || undefined,
          url: stringOf(source.url) || undefined,
          alt: stringOf(block.alt) || undefined,
          name: stringOf(block.name) || undefined,
        },
      ];
    }
    if (type === "toolCall") {
      return [
        {
          id,
          type: "toolCall",
          toolCallId: stringOf(block.id, `${prefix}-tool-${index}`),
          name: stringOf(block.name, "unknown_tool"),
          arguments: json(block.arguments ?? {}),
        },
      ];
    }
    if (type === "thinking") return [];
    return [{ id, type: "unknown", contentType: type, raw: json(block) }];
  });
}

const INLINE_HTML_TOOL = "anvil_render_html_file";
const MAX_INLINE_HTML_BYTES = 192 * 1024;

function inlineHtmlBlock(
  toolName: string,
  detailsValue: unknown,
  id: string,
): Extract<ContentBlock, { type: "inlineHtml" }> | undefined {
  if (toolName !== INLINE_HTML_TOOL) return undefined;
  const details = recordOf(detailsValue);
  if (
    details.kind !== "anvil.inline-html" ||
    details.schemaVersion !== 1 ||
    typeof details.title !== "string" ||
    !details.title.trim() ||
    details.title.length > 120 ||
    typeof details.html !== "string" ||
    !details.html.trim()
  ) return undefined;
  const bytes = new TextEncoder().encode(details.html).byteLength;
  if (bytes > MAX_INLINE_HTML_BYTES || (details.byteLength !== undefined && details.byteLength !== bytes)) return undefined;
  const sourcePath = typeof details.sourcePath === "string" && details.sourcePath
    ? details.sourcePath
    : undefined;
  return {
    id,
    type: "inlineHtml",
    title: details.title,
    html: details.html,
    sourcePath,
    byteLength: bytes,
  };
}

function inlineHtmlMetadata(block: Extract<ContentBlock, { type: "inlineHtml" }>): JsonValue {
  return {
    kind: "anvil.inline-html",
    schemaVersion: 1,
    title: block.title,
    byteLength: block.byteLength,
    ...(block.sourcePath ? { sourcePath: block.sourcePath } : {}),
  };
}

const OPEN_FILE_TOOL = "anvil_open_file";

function projectResourceBlock(
  toolName: string,
  detailsValue: unknown,
  id: string,
): Extract<ContentBlock, { type: "projectResource" }> | undefined {
  if (toolName !== OPEN_FILE_TOOL) return undefined;
  const details = recordOf(detailsValue);
  if (
    details.kind !== "anvil.open-file" ||
    details.schemaVersion !== 1 ||
    typeof details.path !== "string" ||
    normalizeProjectResourcePath(details.path) !== details.path ||
    (details.view !== undefined && !["auto", "source", "preview"].includes(String(details.view))) ||
    (details.line !== undefined && (!Number.isSafeInteger(details.line) || Number(details.line) <= 0)) ||
    (details.column !== undefined && (!Number.isSafeInteger(details.column) || Number(details.column) <= 0))
  ) return undefined;
  return {
    id,
    type: "projectResource",
    path: details.path,
    ...(details.view ? { view: details.view as "auto" | "source" | "preview" } : {}),
    ...(details.line ? { line: Number(details.line) } : {}),
    ...(details.column ? { column: Number(details.column) } : {}),
  };
}

function projectResourceMetadata(block: Extract<ContentBlock, { type: "projectResource" }>): JsonValue {
  return {
    kind: "anvil.open-file",
    schemaVersion: 1,
    path: block.path,
    ...(block.view ? { view: block.view } : {}),
    ...(block.line ? { line: block.line } : {}),
    ...(block.column ? { column: block.column } : {}),
  };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function supportedThinkingLevels(model: Record<string, unknown>): Array<(typeof THINKING_LEVELS)[number]> {
  if (model.reasoning !== true) return ["off"];
  const levelMap = recordOf(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = levelMap[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function toolWasCancelled(record: Record<string, unknown>, inferFromErrorText = false): boolean {
  const details = recordOf(record.details);
  if (record.cancelled === true || details.cancelled === true) return true;
  if (!inferFromErrorText || !Array.isArray(record.content)) return false;
  return record.content.some((item) => {
    const block = recordOf(item);
    return block.type === "text" && /\b(?:aborted|cancelled)\b/i.test(stringOf(block.text));
  });
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "read") return `Read ${stringOf(args.path, "file")}`;
  if (name === "bash") return stringOf(args.command, "Run shell command");
  if (name.includes("search")) return stringOf(args.query, `Run ${name}`);
  if (name === "agent_browser") return stringOf(args.action, "Use browser");
  return `Run ${name}`;
}

function optionsOf(value: unknown): InteractionOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === "string") return { id: `option-${index}`, label: item, value: item };
    const option = recordOf(item);
    const value = stringOf(option.value, stringOf(option.label, `option-${index}`));
    return {
      id: stringOf(option.id, `option-${index}`),
      label: stringOf(option.label, value),
      value,
      description: stringOf(option.description) || undefined,
    };
  });
}

function fieldsOf(value: unknown): GenericInteractionField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields = value.flatMap((item, index): GenericInteractionField[] => {
    const field = recordOf(item);
    const type = stringOf(field.type);
    const base = {
      id: stringOf(field.id, `field-${index}`),
      label: stringOf(field.label, `Field ${index + 1}`),
      required: field.required === true,
    };
    if (type === "text" || type === "textarea") {
      return [
        {
          ...base,
          type,
          placeholder: stringOf(field.placeholder) || undefined,
          defaultValue: stringOf(field.defaultValue) || undefined,
        },
      ];
    }
    if (type === "boolean") {
      return [{ ...base, type, defaultValue: field.defaultValue === true }];
    }
    if (type === "select" || type === "multiSelect") {
      return [{ ...base, type, options: optionsOf(field.options) }];
    }
    return [];
  });
  return fields.length ? fields : undefined;
}

function interactionFromRecord(
  record: Record<string, unknown>,
  state: PiRpcAdapterState,
  timestamp: string,
): InteractionRequest {
  const id = stringOf(record.id, `interaction-${state.nextSequence}`);
  const method = stringOf(record.method, "unknown");
  const common = {
    id,
    sessionId: state.sessionId,
    title: stringOf(record.title, "Extension request"),
    message: stringOf(record.message) || undefined,
    requestedAt: timestamp,
    timeoutMs: numberOf(record.timeout),
    raw: json(record),
  };
  if (method === "select") return { ...common, method, options: optionsOf(record.options) };
  if (method === "multiSelect") {
    return {
      ...common,
      method,
      options: optionsOf(record.options),
      minSelections: numberOf(record.minSelections),
      maxSelections: numberOf(record.maxSelections),
    };
  }
  if (method === "confirm") return { ...common, method };
  if (method === "input") {
    return {
      ...common,
      method,
      placeholder: stringOf(record.placeholder) || undefined,
      defaultValue: stringOf(record.defaultValue) || undefined,
    };
  }
  if (method === "editor") {
    return {
      ...common,
      method,
      value: stringOf(record.prefill, stringOf(record.value)) || undefined,
      language: stringOf(record.language) || undefined,
    };
  }
  return {
    ...common,
    method: "unknown",
    originalMethod: method,
    fields: fieldsOf(record.fields),
  };
}

export function normalizePiRpcRecord(
  state: PiRpcAdapterState,
  record: Record<string, unknown>,
  at = 0,
): UnsequencedAnvilEvent[] {
  const timestamp = new Date(state.baseTimestamp + at).toISOString();
  const raw = json(record);
  const events: UnsequencedAnvilEvent[] = [];
  const emit = <T extends AnvilEvent["type"]>(
    type: T,
    payload: Extract<AnvilEvent, { type: T }>["payload"],
    includeRaw = true,
  ) => {
    state.nextSequence++;
    events.push({
      sessionId: state.sessionId,
      timestamp,
      type,
      payload,
      ...(includeRaw ? { raw } : {}),
    } as UnsequencedAnvilEvent);
  };

  const type = stringOf(record.type, "unknown");
  if (type === "response") {
    const command = stringOf(record.command);
    if (record.success === false) {
      emit("timeline.event", {
        entry: {
          id: `command-error-${state.nextSequence}`,
          kind: "event",
          category: "error",
          tone: "error",
          title: `Pi command failed: ${command || "unknown"}`,
          message: stringOf(record.error, "The command was rejected."),
          details: raw,
          createdAt: timestamp,
          raw,
        },
      });
      return events;
    }
    const data = recordOf(record.data);
    if (command === "get_available_models") {
      const models = Array.isArray(data.models)
        ? data.models.map((item) => {
            const model = recordOf(item);
            const provider = stringOf(model.provider, "unknown");
            const id = stringOf(model.id, "unknown");
            const reasoning = model.reasoning === true;
            return {
              id: `${provider}/${id}`,
              provider,
              name: stringOf(model.name, id),
              reasoning,
              input: Array.isArray(model.input)
                ? model.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
                : ["text" as const],
              contextWindow: numberOf(model.contextWindow),
              maxTokens: numberOf(model.maxTokens),
              supportedThinkingLevels: supportedThinkingLevels(model),
            };
          })
        : [];
      state.catalog = {
        ...state.catalog,
        models: models.map((model) => ({ ...model, supportedThinkingLevels: [...model.supportedThinkingLevels] })),
        modelsReady: true,
      };
      emit("catalog.updated", { catalog: state.catalog });
      return events;
    }
    if (command === "get_commands") {
      const commands = Array.isArray(data.commands) ? data.commands.map(recordOf) : [];
      state.catalog = {
        ...state.catalog,
        commands: commands
          .filter((item) => item.source !== "skill")
          .map((item) => {
            const sourceInfo = recordOf(item.sourceInfo);
            const location = sourceInfo.location ?? item.location;
            return {
              name: stringOf(item.name),
              description: stringOf(item.description) || undefined,
              source: item.source === "extension" ? "extension" as const : "prompt" as const,
              location: location === "user" || location === "project" || location === "path" ? location : undefined,
              path: stringOf(sourceInfo.path, stringOf(item.path)) || undefined,
            };
          }),
        skills: commands
          .filter((item) => item.source === "skill")
          .map((item) => {
            const commandName = stringOf(item.name);
            const sourceInfo = recordOf(item.sourceInfo);
            const location = sourceInfo.location ?? item.location;
            return {
              name: commandName.replace(/^skill:/, ""),
              command: commandName,
              description: stringOf(item.description) || undefined,
              location: location === "user" || location === "project" || location === "path" ? location : undefined,
              path: stringOf(sourceInfo.path, stringOf(item.path)) || undefined,
            };
          }),
      };
      emit("catalog.updated", { catalog: state.catalog });
      return events;
    }
    if (command === "get_state") {
      const model = recordOf(data.model);
      const provider = stringOf(model.provider);
      const modelId = stringOf(model.id);
      const configured: {
        modelId?: string;
        thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
        title?: string;
      } = {};
      if (provider && modelId) configured.modelId = `${provider}/${modelId}`;
      const thinkingLevel = stringOf(data.thinkingLevel);
      if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
        configured.thinkingLevel = thinkingLevel as typeof configured.thinkingLevel;
      }
      if (stringOf(data.sessionName)) configured.title = stringOf(data.sessionName);
      emit("session.configured", configured);
      emit("run.status", { status: data.isStreaming === true ? "running" : "idle" });
      return events;
    }
    if (command === "get_messages" && Array.isArray(data.messages)) {
      return data.messages.flatMap((message, index) => {
        const itemAt = at + index;
        return [
          ...normalizePiRpcRecord(state, { type: "message_start", message }, itemAt),
          ...normalizePiRpcRecord(state, { type: "message_end", message }, itemAt),
        ];
      });
    }
    return events;
  }
  if (type === "session_info_changed") {
    emit("session.configured", {
      title: stringOf(record.name, "New session"),
    });
    return events;
  }
  if (type === "thinking_level_changed") {
    const level = stringOf(record.level);
    if (THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
      emit("session.configured", {
        thinkingLevel: level as (typeof THINKING_LEVELS)[number],
      });
      return events;
    }
  }
  if (type === "agent_start") {
    state.terminalOutcomeInCurrentRun = undefined;
    emit("run.status", { status: "running" });
    return events;
  }
  if (type === "agent_settled") {
    if (!state.terminalOutcomeInCurrentRun) {
      emit("run.status", { status: "idle", outcome: "completed" });
    }
    state.terminalOutcomeInCurrentRun = undefined;
    return events;
  }
  if (type === "message_start") {
    const message = recordOf(record.message);
    const role = stringOf(message.role, "system");
    if (role === "toolResult") return events;
    const id = messageId(message, state);
    if (role === "assistant") {
      state.activeAssistantMessageId = id;
      state.lastAssistantMessageId = id;
      state.reasoningIds = {};
    }
    const normalized: MessageEntry = {
      id,
      kind: "message",
      role:
        role === "user" || role === "assistant" || role === "system"
          ? role
          : "extension",
      content: contentBlocks(role === "bashExecution" ? message.output : message.content, id),
      status: "streaming",
      modelId: stringOf(message.model) || undefined,
      createdAt: timestamp,
      raw: json(message),
    };
    emit("message.started", { message: normalized });
    return events;
  }
  if (type === "message_update") {
    const update = recordOf(record.assistantMessageEvent);
    const updateType = stringOf(update.type);
    const message = recordOf(record.message);
    const id = state.activeAssistantMessageId ?? messageId(message, state);
    const contentIndex = numberOf(update.contentIndex) ?? 0;
    if (updateType === "text_delta") {
      emit("message.delta", {
        messageId: id,
        blockId: `${id}-text-${contentIndex}`,
        delta: stringOf(update.delta),
        modelId: stringOf(message.model) || undefined,
      }, false);
    } else if (updateType === "thinking_start") {
      const reasoningId = `${id}-reasoning-${contentIndex}`;
      state.reasoningIds[contentIndex] = reasoningId;
      emit("reasoning.started", {
        reasoning: {
          id: reasoningId,
          kind: "reasoning",
          messageId: id,
          content: "",
          status: "streaming",
          createdAt: timestamp,
          raw,
        },
      });
    } else if (updateType === "thinking_delta") {
      let reasoningId = state.reasoningIds[contentIndex];
      if (!reasoningId) {
        reasoningId = `${id}-reasoning-${contentIndex}`;
        state.reasoningIds[contentIndex] = reasoningId;
        emit("reasoning.started", {
          reasoning: {
            id: reasoningId,
            kind: "reasoning",
            messageId: id,
            content: "",
            status: "streaming",
            createdAt: timestamp,
            raw,
          },
        });
      }
      emit("reasoning.delta", { reasoningId, delta: stringOf(update.delta) }, false);
    } else if (updateType === "thinking_end") {
      const reasoningId =
        state.reasoningIds[contentIndex] ?? `${id}-reasoning-${contentIndex}`;
      emit("reasoning.completed", {
        reasoningId,
        content: stringOf(update.content) || undefined,
      });
    } else if (updateType === "error") {
      const reason = stringOf(update.reason, "error");
      emit("message.completed", {
        messageId: id,
        status: reason === "aborted" ? "cancelled" : "failed",
        error: stringOf(update.error, reason),
      });
      state.terminalOutcomeInCurrentRun = reason === "aborted" ? "cancelled" : "failed";
      emit("run.status", {
        status: reason === "aborted" ? "idle" : "failed",
        outcome: state.terminalOutcomeInCurrentRun,
      });
    }
    return events;
  }
  if (type === "message_end") {
    const message = recordOf(record.message);
    const role = stringOf(message.role);
    if (role === "toolResult") {
      const toolCallId = stringOf(message.toolCallId, `restored-tool-${state.nextSequence}`);
      const toolName = stringOf(message.toolName, "unknown_tool");
      const cancelled = toolWasCancelled(message, message.isError === true);
      const inlineHtml = message.isError === true
        ? undefined
        : inlineHtmlBlock(toolName, message.details, `tool-${toolCallId}-inline-html`);
      const projectResource = message.isError === true || cancelled
        ? undefined
        : projectResourceBlock(toolName, message.details, `tool-${toolCallId}-project-resource`);
      if (!state.knownToolCallIds.has(toolCallId)) {
        state.knownToolCallIds.add(toolCallId);
        emit("tool.started", {
          tool: {
            id: `tool-${toolCallId}`,
            kind: "tool",
            toolCallId,
            name: toolName,
            summary: `Restored ${toolName} result`,
            status: "running",
            arguments: {},
            output: [],
            createdAt: timestamp,
            startedAt: timestamp,
            ...(inlineHtml || projectResource ? {} : { raw }),
          },
        }, !inlineHtml && !projectResource);
      }
      emit("tool.completed", {
        toolCallId,
        output: inlineHtml
          ? [inlineHtml]
          : projectResource
            ? [projectResource]
            : contentBlocks(message.content, `tool-${toolCallId}-result`),
        details: inlineHtml
          ? inlineHtmlMetadata(inlineHtml)
          : projectResource
            ? projectResourceMetadata(projectResource)
            : message.details === undefined ? undefined : json(message.details),
        status: cancelled
          ? "cancelled"
          : message.isError === true ? "failed" : "completed",
      }, !inlineHtml && !projectResource);
      return events;
    }
    const id =
      role === "assistant"
        ? state.activeAssistantMessageId ?? messageId(message, state)
        : messageId(message, state);
    emit("message.completed", {
      messageId: id,
      content: contentBlocks(role === "bashExecution" ? message.output : message.content, id),
      status:
        message.stopReason === "aborted"
          ? "cancelled"
          : message.stopReason === "error"
            ? "failed"
            : "complete",
      error: stringOf(message.errorMessage) || undefined,
    });
    if (role === "assistant" && Array.isArray(message.content)) {
      message.content.forEach((item, index) => {
        const block = recordOf(item);
        if (block.type !== "thinking") return;
        const reasoningId = state.reasoningIds[index] ?? `${id}-reasoning-${index}`;
        if (!state.reasoningIds[index]) {
          state.reasoningIds[index] = reasoningId;
          emit("reasoning.started", {
            reasoning: {
              id: reasoningId,
              kind: "reasoning",
              messageId: id,
              content: "",
              status: "streaming",
              createdAt: timestamp,
              raw,
            },
          });
        }
        emit("reasoning.completed", {
          reasoningId,
          content: stringOf(block.thinking),
        });
      });
      state.activeAssistantMessageId = undefined;
    }
    return events;
  }
  if (type === "tool_execution_start") {
    const name = stringOf(record.toolName, "unknown_tool");
    const args = recordOf(record.args);
    const toolCallId = stringOf(record.toolCallId, `tool-${state.nextSequence}`);
    state.knownToolCallIds.add(toolCallId);
    emit("tool.started", {
      tool: {
        id: `tool-${toolCallId}`,
        kind: "tool",
        toolCallId,
        name,
        summary: toolSummary(name, args),
        status: "running",
        arguments: json(args),
        output: [],
        createdAt: timestamp,
        startedAt: timestamp,
        batchId: state.lastAssistantMessageId,
        raw,
      },
    });
    return events;
  }
  if (type === "tool_execution_update") {
    const partial = recordOf(record.partialResult);
    emit("tool.updated", {
      toolCallId: stringOf(record.toolCallId),
      output: contentBlocks(partial.content, `tool-${stringOf(record.toolCallId)}-partial`),
      details: partial.details === undefined ? undefined : json(partial.details),
    }, false);
    return events;
  }
  if (type === "tool_execution_end") {
    const result = recordOf(record.result);
    const toolCallId = stringOf(record.toolCallId);
    const cancelled = toolWasCancelled(result, record.isError === true);
    const inlineHtml = record.isError === true
      ? undefined
      : inlineHtmlBlock(
          stringOf(record.toolName),
          result.details,
          `tool-${toolCallId}-inline-html`,
        );
    const projectResource = record.isError === true || cancelled
      ? undefined
      : projectResourceBlock(
          stringOf(record.toolName),
          result.details,
          `tool-${toolCallId}-project-resource`,
        );
    emit("tool.completed", {
      toolCallId,
      output: inlineHtml
        ? [inlineHtml]
        : projectResource
          ? [projectResource]
          : contentBlocks(result.content, `tool-${toolCallId}-result`),
      details: inlineHtml
        ? inlineHtmlMetadata(inlineHtml)
        : projectResource
          ? projectResourceMetadata(projectResource)
          : result.details === undefined ? undefined : json(result.details),
      status: cancelled
        ? "cancelled"
        : record.isError === true ? "failed" : "completed",
    }, !inlineHtml && !projectResource);
    return events;
  }
  if (type === "queue_update") {
    emit("queue.updated", {
      steering: Array.isArray(record.steering) ? record.steering.map(String) : [],
      followUp: Array.isArray(record.followUp) ? record.followUp.map(String) : [],
    });
    return events;
  }
  if (type === "extension_error") {
    emit("timeline.event", {
      entry: {
        id: `extension-error-${state.nextSequence}`,
        kind: "event",
        category: "error",
        tone: "error",
        title: "Extension error",
        message: stringOf(record.error, "An extension failed."),
        source: stringOf(record.extensionPath) || undefined,
        details: json({ event: record.event ?? null }),
        createdAt: timestamp,
        raw,
      },
    });
    return events;
  }
  if (type === "extension_ui_request") {
    const method = stringOf(record.method, "unknown");
    if (["select", "multiSelect", "confirm", "input", "editor"].includes(method)) {
      emit("interaction.requested", {
        request: interactionFromRecord(record, state, timestamp),
      });
    } else if (method === "notify") {
      const notifyType = stringOf(record.notifyType, "info");
      emit("timeline.event", {
        entry: {
          id: `notification-${stringOf(record.id, String(state.nextSequence))}`,
          kind: "event",
          category: "notification",
          tone:
            notifyType === "error" ? "error" : notifyType === "warning" ? "warning" : "info",
          title: "Extension notification",
          message: stringOf(record.message),
          createdAt: timestamp,
          raw,
        },
      });
    } else if (method === "setStatus") {
      const key = stringOf(record.statusKey, "extension");
      const text = stringOf(record.statusText) || undefined;
      if (state.extensionStatuses.has(key) && state.extensionStatuses.get(key) === text) return events;
      state.extensionStatuses.set(key, text);
      emit("extension.status", { key, text });
    } else if (method === "setWidget") {
      const key = stringOf(record.widgetKey, "extension");
      const lines = Array.isArray(record.widgetLines) ? record.widgetLines.map(String) : undefined;
      const placement = record.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor";
      const previous = state.extensionWidgets.get(key);
      const unchanged = previous !== undefined &&
        previous.placement === placement &&
        previous.lines?.length === lines?.length &&
        (lines === undefined || lines.every((line, index) => previous.lines?.[index] === line));
      if (unchanged) return events;
      state.extensionWidgets.set(key, { lines, placement });
      emit("extension.widget", { key, lines, placement });
    } else if (method === "set_editor_text") {
      emit("composer.prefill", { text: stringOf(record.text) });
    } else if (method === "setTitle") {
      emit("timeline.event", {
        entry: {
          id: `title-${stringOf(record.id, String(state.nextSequence))}`,
          kind: "event",
          category: "status",
          tone: "neutral",
          title: "Extension changed the session title",
          message: stringOf(record.title),
          createdAt: timestamp,
          raw,
        },
      });
    } else {
      emit("interaction.requested", {
        request: interactionFromRecord(record, state, timestamp),
      });
    }
    return events;
  }
  if (type === "compaction_start") {
    emit("timeline.event", {
      entry: {
        id: `compaction-${state.nextSequence}`,
        kind: "event",
        category: "lifecycle",
        tone: "info",
        title: "Compacting context",
        message: `Reason: ${stringOf(record.reason, "manual")}`,
        createdAt: timestamp,
        raw,
      },
    });
    return events;
  }
  if (type === "compaction_end") {
    const failed = record.aborted !== true && !record.result;
    emit("timeline.event", {
      entry: {
        id: `compaction-end-${state.nextSequence}`,
        kind: "event",
        category: failed ? "error" : "lifecycle",
        tone: failed ? "error" : record.aborted === true ? "warning" : "success",
        title: failed ? "Context compaction failed" : record.aborted === true ? "Context compaction cancelled" : "Context compacted",
        message: failed
          ? stringOf(record.errorMessage, "Compaction did not produce a result.")
          : `Reason: ${stringOf(record.reason, "manual")}`,
        details: raw,
        createdAt: timestamp,
        raw,
      },
    });
    return events;
  }
  if (type === "auto_retry_start" || type === "auto_retry_end") {
    emit("timeline.event", {
      entry: {
        id: `retry-${state.nextSequence}`,
        kind: "event",
        category: type === "auto_retry_end" && record.success === false ? "error" : "lifecycle",
        tone: type === "auto_retry_end" && record.success === false ? "error" : "warning",
        title: type === "auto_retry_start" ? "Retrying request" : "Retry finished",
        message:
          type === "auto_retry_start"
            ? stringOf(record.errorMessage)
            : record.success === false
              ? stringOf(record.finalError)
              : `Succeeded on attempt ${numberOf(record.attempt) ?? 1}`,
        details: raw,
        createdAt: timestamp,
        raw,
      },
    });
    return events;
  }
  if (type === "agent_end" || type === "turn_start" || type === "turn_end") return events;

  emit("unknown", { eventType: type, payload: raw });
  return events;
}

export function normalizeRecordedRpcItems(
  state: PiRpcAdapterState,
  items: RecordedRpcItem[],
): UnsequencedAnvilEvent[] {
  return items.flatMap((item) => normalizePiRpcRecord(state, item.record, item.at));
}
