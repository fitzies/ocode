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
