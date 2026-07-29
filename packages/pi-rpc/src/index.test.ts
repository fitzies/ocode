import { describe, expect, it } from "vitest";

import { createPiRpcAdapterState, normalizePiRpcRecord } from "./index";

function state() {
  return createPiRpcAdapterState({
    fixtureId: "adapter-test",
    sessionId: "session-1",
    baseTimestamp: "2026-07-21T10:00:00.000Z",
  });
}

describe("Pi RPC normalization", () => {
  it("preserves unknown records in a forward-compatible event", () => {
    const events = normalizePiRpcRecord(state(), { type: "future_event", nested: { value: 42 } }, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unknown",
      payload: { eventType: "future_event", payload: { type: "future_event", nested: { value: 42 } } },
      raw: { type: "future_event", nested: { value: 42 } },
    });
  });

  it("normalizes non-standard multi-select and schema-described interactions", () => {
    const adapter = state();
    const [multi] = normalizePiRpcRecord(adapter, {
      type: "extension_ui_request",
      id: "multi-1",
      method: "multiSelect",
      title: "Pick coverage",
      options: ["Streaming", "Tools"],
      minSelections: 1,
    });
    const [future] = normalizePiRpcRecord(adapter, {
      type: "extension_ui_request",
      id: "future-1",
      method: "futureWizard",
      title: "Configure",
      fields: [{ id: "name", label: "Name", type: "text", required: true }],
    });

    expect(multi).toMatchObject({ type: "interaction.requested", payload: { request: { method: "multiSelect", minSelections: 1 } } });
    expect(future).toMatchObject({ type: "interaction.requested", payload: { request: { method: "unknown", originalMethod: "futureWizard", fields: [{ id: "name", type: "text" }] } } });
  });

  it("drops transport-only records that have no client-visible state", () => {
    const adapter = state();
    const records = [
      { type: "response", id: "prompt-1", command: "prompt", success: true },
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "agent_end" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{}" },
        message: { id: "assistant-1" },
      },
      { type: "message_start", message: { role: "toolResult", toolCallId: "call-1" } },
    ];

    expect(records.flatMap((record) => normalizePiRpcRecord(adapter, record))).toEqual([]);
  });

  it("deduplicates unchanged extension status and widget state", () => {
    const adapter = state();
    const status = {
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "workspace",
      statusText: "Indexing",
    };
    const widget = {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "workspace",
      widgetLines: ["Branch: main", "Clean"],
      widgetPlacement: "aboveEditor",
    };

    expect(normalizePiRpcRecord(adapter, status)).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, status)).toEqual([]);
    expect(normalizePiRpcRecord(adapter, { ...status, statusText: "Ready" })).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, { ...status, statusText: "" })).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, { ...status, statusText: "" })).toEqual([]);

    expect(normalizePiRpcRecord(adapter, widget)).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, { ...widget, widgetLines: [...widget.widgetLines] })).toEqual([]);
    expect(normalizePiRpcRecord(adapter, { ...widget, widgetLines: ["Branch: feature"] })).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, { ...widget, widgetLines: undefined })).toHaveLength(1);
    expect(normalizePiRpcRecord(adapter, { ...widget, widgetLines: undefined })).toEqual([]);
  });

  it("normalizes live model and command catalogs from Pi responses", () => {
    const adapter = state();
    const [models] = normalizePiRpcRecord(adapter, {
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [{
          id: "model-1",
          name: "Model One",
          provider: "test",
          reasoning: true,
          input: ["text"],
          thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
        }],
      },
    });
    const [commands] = normalizePiRpcRecord(adapter, {
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [
        { name: "review", description: "Review work", source: "prompt", sourceInfo: { location: "project", path: "/repo/.pi/prompts/review.md" } },
        { name: "skill:frontend", description: "Design UI", source: "skill", sourceInfo: { location: "user", path: "/home/forge/.pi/skills/frontend/SKILL.md" } },
      ] },
    });

    expect(models).toMatchObject({
      type: "catalog.updated",
      payload: {
        catalog: {
          models: [{
            id: "test/model-1",
            supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
          }],
          modelsReady: true,
        },
      },
    });
    expect(commands).toMatchObject({
      type: "catalog.updated",
      payload: {
        catalog: {
          commands: [{ name: "review", location: "project", path: "/repo/.pi/prompts/review.md" }],
          skills: [{ name: "frontend", command: "skill:frontend", location: "user" }],
        },
      },
    });
  });

  it("normalizes real Pi session metadata events omitted from the RPC event table", () => {
    const adapter = state();
    const [renamed] = normalizePiRpcRecord(adapter, {
      type: "session_info_changed",
      name: "Acceptance session",
    });
    const [thinking] = normalizePiRpcRecord(adapter, {
      type: "thinking_level_changed",
      level: "high",
    });

    expect(renamed).toMatchObject({
      type: "session.configured",
      payload: { title: "Acceptance session" },
    });
    expect(thinking).toMatchObject({
      type: "session.configured",
      payload: { thinkingLevel: "high" },
    });
  });

  it("normalizes compaction completion and leaves sequencing to Forge", () => {
    const [event] = normalizePiRpcRecord(state(), {
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "Compacted", tokensBefore: 1000, estimatedTokensAfter: 300 },
      aborted: false,
      willRetry: false,
    });

    expect(event).toMatchObject({
      type: "timeline.event",
      sessionId: "session-1",
      payload: { entry: { title: "Context compacted", tone: "success" } },
    });
    expect(event).not.toHaveProperty("sequence");
    expect(event).not.toHaveProperty("id");
  });

  it("classifies real Pi aborted tool results as cancelled", () => {
    const adapter = state();
    const [executionEnd] = normalizePiRpcRecord(adapter, {
      type: "tool_execution_end",
      toolCallId: "call-aborted",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Command aborted" }], details: {} },
      isError: true,
    });
    const [, messageEnd] = normalizePiRpcRecord(adapter, {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-restored-aborted",
        toolName: "bash",
        content: [{ type: "text", text: "Command aborted" }],
        details: {},
        isError: true,
      },
    });

    expect(executionEnd).toMatchObject({
      type: "tool.completed",
      payload: { toolCallId: "call-aborted", status: "cancelled" },
    });
    expect(messageEnd).toMatchObject({
      type: "tool.completed",
      payload: { toolCallId: "call-restored-aborted", status: "cancelled" },
    });
  });

  it("does not overwrite a failed or cancelled terminal outcome when Pi settles", () => {
    for (const reason of ["aborted", "provider_error"] as const) {
      const adapter = state();
      normalizePiRpcRecord(adapter, { type: "agent_start" });
      const failure = normalizePiRpcRecord(adapter, {
        type: "message_update",
        assistantMessageEvent: { type: "error", reason },
        message: { id: `message-${reason}` },
      });
      const settled = normalizePiRpcRecord(adapter, { type: "agent_settled" });

      expect(failure.at(-1)).toMatchObject({
        type: "run.status",
        payload: { outcome: reason === "aborted" ? "cancelled" : "failed" },
      });
      expect(settled).toEqual([]);
    }
  });

  it("normalizes completed inline HTML artifacts without duplicating source in raw details", () => {
    const html = "<!doctype html><html><body><svg></svg></body></html>";
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-artifact",
      toolName: "ocode_render_html_file",
      result: {
        content: [{ type: "text", text: "Rendered Usage inline." }],
        details: {
          kind: "ocode.inline-html",
          schemaVersion: 1,
          title: "Usage",
          sourcePath: "artifacts/usage.html",
          byteLength: new TextEncoder().encode(html).byteLength,
          html,
        },
      },
      isError: false,
    });

    expect(event).toMatchObject({
      type: "tool.completed",
      payload: {
        toolCallId: "call-artifact",
        status: "completed",
        output: [{
          type: "inlineHtml",
          title: "Usage",
          html,
          sourcePath: "artifacts/usage.html",
        }],
        details: {
          kind: "ocode.inline-html",
          schemaVersion: 1,
          title: "Usage",
        },
      },
    });
    expect(event).not.toHaveProperty("raw");
    const normalizedDetails = event.type === "tool.completed" ? event.payload.details : undefined;
    expect(JSON.stringify(normalizedDetails)).not.toContain(html);
  });

  it("restores inline HTML artifacts from persisted Pi tool results", () => {
    const html = "<div>Restored preview</div>";
    const events = normalizePiRpcRecord(state(), {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-restored-artifact",
        toolName: "ocode_render_html_file",
        content: [{ type: "text", text: "Rendered preview inline." }],
        details: {
          kind: "ocode.inline-html",
          schemaVersion: 1,
          title: "Restored preview",
          byteLength: new TextEncoder().encode(html).byteLength,
          html,
        },
        isError: false,
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool.started",
      payload: { tool: { name: "ocode_render_html_file" } },
    });
    expect(events[1]).toMatchObject({
      type: "tool.completed",
      payload: { output: [{ type: "inlineHtml", html }] },
    });
    expect(events.every((event) => !("raw" in event))).toBe(true);
  });

  it("accepts legacy inline HTML tool names and detail kinds while emitting canonical metadata", () => {
    const html = "<div>Legacy preview</div>";
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-legacy-artifact",
      toolName: "anvil_render_html_file",
      result: {
        content: [{ type: "text", text: "Rendered preview inline." }],
        details: {
          kind: "anvil.inline-html",
          schemaVersion: 1,
          title: "Legacy preview",
          byteLength: new TextEncoder().encode(html).byteLength,
          html,
        },
      },
      isError: false,
    });

    expect(event).toMatchObject({
      type: "tool.completed",
      payload: {
        output: [{ type: "inlineHtml", html }],
        details: { kind: "ocode.inline-html" },
      },
    });
  });

  it("keeps malformed inline artifact envelopes on the generic tool fallback", () => {
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-bad-artifact",
      toolName: "ocode_render_html_file",
      result: {
        content: [{ type: "text", text: "No preview" }],
        details: { kind: "ocode.inline-html", schemaVersion: 99, html: "<p>Bad</p>" },
      },
      isError: false,
    });

    expect(event).toMatchObject({
      type: "tool.completed",
      payload: { output: [{ type: "text", text: "No preview" }] },
    });
    expect(event).toHaveProperty("raw");
  });

  it("normalizes live and restored open-file results into durable project resources", () => {
    const details = {
      kind: "ocode.open-file",
      schemaVersion: 1,
      path: "src/main.ts",
      view: "source",
      line: 8,
      column: 3,
    };
    const [live] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-open",
      toolName: "ocode_open_file",
      result: { content: [{ type: "text", text: "Ready to open src/main.ts." }], details },
      isError: false,
    });
    const restored = normalizePiRpcRecord(state(), {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-restored-open",
        toolName: "ocode_open_file",
        content: [{ type: "text", text: "Ready to open src/main.ts." }],
        details,
        isError: false,
      },
    });

    expect(live).toMatchObject({
      type: "tool.completed",
      payload: {
        output: [{
          id: "tool-call-open-project-resource",
          type: "projectResource",
          path: "src/main.ts",
          view: "source",
          line: 8,
          column: 3,
        }],
        details,
      },
    });
    expect(live).not.toHaveProperty("raw");
    expect(restored.at(-1)).toMatchObject({
      type: "tool.completed",
      payload: { output: [{ type: "projectResource", path: "src/main.ts" }] },
    });
    expect(restored.every((event) => !("raw" in event))).toBe(true);
  });

  it("accepts legacy open-file tool names and detail kinds while emitting canonical metadata", () => {
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-legacy-open",
      toolName: "anvil_open_file",
      result: {
        content: [{ type: "text", text: "Ready to open src/legacy.ts." }],
        details: { kind: "anvil.open-file", schemaVersion: 1, path: "src/legacy.ts" },
      },
      isError: false,
    });

    expect(event).toMatchObject({
      type: "tool.completed",
      payload: {
        output: [{ type: "projectResource", path: "src/legacy.ts" }],
        details: { kind: "ocode.open-file" },
      },
    });
  });

  it("keeps malformed or failed open-file results on the generic fallback", () => {
    for (const record of [
      {
        type: "tool_execution_end",
        toolCallId: "call-bad-open",
        toolName: "ocode_open_file",
        result: {
          content: [{ type: "text", text: "Malformed" }],
          details: { kind: "ocode.open-file", schemaVersion: 1, path: "../secret" },
        },
        isError: false,
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-failed-open",
        toolName: "ocode_open_file",
        result: {
          content: [{ type: "text", text: "Failed" }],
          details: { kind: "ocode.open-file", schemaVersion: 1, path: "src/main.ts" },
        },
        isError: true,
      },
    ]) {
      const [event] = normalizePiRpcRecord(state(), record);
      expect(event).toMatchObject({
        type: "tool.completed",
        payload: { output: [{ type: "text" }] },
      });
      expect(event).toHaveProperty("raw");
    }
  });

  it("does not infer cancellation from a successful open-file path", () => {
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-cancelled-name",
      toolName: "ocode_open_file",
      result: {
        content: [{ type: "text", text: "Ready to open aborted/cancelled.ts." }],
        details: { kind: "ocode.open-file", schemaVersion: 1, path: "aborted/cancelled.ts" },
      },
      isError: false,
    });
    expect(event).toMatchObject({
      type: "tool.completed",
      payload: { status: "completed", output: [{ type: "projectResource", path: "aborted/cancelled.ts" }] },
    });
  });

  it("keeps cancelled live and restored open-file results generic and non-clickable", () => {
    const details = { kind: "ocode.open-file", schemaVersion: 1, path: "src/main.ts" };
    const [live] = normalizePiRpcRecord(state(), {
      type: "tool_execution_end",
      toolCallId: "call-cancelled-open",
      toolName: "ocode_open_file",
      result: { content: [{ type: "text", text: "Command cancelled" }], details, cancelled: true },
      isError: false,
    });
    const restored = normalizePiRpcRecord(state(), {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-restored-cancelled-open",
        toolName: "ocode_open_file",
        content: [{ type: "text", text: "Command cancelled" }],
        details,
        cancelled: true,
        isError: false,
      },
    });

    expect(live).toMatchObject({
      type: "tool.completed",
      payload: { status: "cancelled", output: [{ type: "text" }] },
    });
    expect(restored.at(-1)).toMatchObject({
      type: "tool.completed",
      payload: { status: "cancelled", output: [{ type: "text" }] },
    });
  });

  it("turns accumulated tool progress into replaceable output events", () => {
    const [event] = normalizePiRpcRecord(state(), {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "custom_tool",
      partialResult: {
        content: [{ type: "text", text: "Accumulated output" }],
        details: { progress: 70 },
      },
    });

    expect(event).toMatchObject({
      type: "tool.updated",
      payload: {
        toolCallId: "call-1",
        output: [{ type: "text", text: "Accumulated output" }],
        details: { progress: 70 },
      },
    });
  });
});
