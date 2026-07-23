import { describe, expect, it } from "vitest";

import { createPiRpcAdapterState, normalizePiRpcRecord } from "./piRpcAdapter";

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
      data: { models: [{ id: "model-1", name: "Model One", provider: "test", reasoning: true, input: ["text"] }] },
    });
    const [commands] = normalizePiRpcRecord(adapter, {
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [
        { name: "review", description: "Review work", source: "prompt", location: "project" },
        { name: "skill:frontend", description: "Design UI", source: "skill", location: "user" },
      ] },
    });

    expect(models).toMatchObject({ type: "catalog.updated", payload: { catalog: { models: [{ id: "test/model-1" }] } } });
    expect(commands).toMatchObject({
      type: "catalog.updated",
      payload: { catalog: { commands: [{ name: "review" }], skills: [{ name: "frontend", command: "skill:frontend" }] } },
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
