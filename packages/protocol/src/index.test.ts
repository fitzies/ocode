import { describe, expect, it } from "vitest";

import { ANVIL_PROTOCOL_VERSION, decodeAnvilEvent, isAnvilEvent, isJsonValue } from "./index";

describe("protocol runtime guards", () => {
  it("accepts JSON-compatible arbitrary extension details", () => {
    expect(isJsonValue({ nested: ["value", 3, true, null] })).toBe(true);
    expect(isJsonValue({ invalid: undefined })).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("requires future event names to use the explicit unknown fallback", () => {
    expect(
      isAnvilEvent({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "event-1",
        sequence: 1,
        sessionId: "session-1",
        timestamp: "2026-07-21T08:00:00.000Z",
        type: "future.extension.event",
        payload: { arbitrary: true },
      }),
    ).toBe(false);
    expect(
      isAnvilEvent({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "event-2",
        sequence: 2,
        sessionId: "session-1",
        timestamp: "2026-07-21T08:00:01.000Z",
        type: "unknown",
        payload: { eventType: "future.extension.event", payload: { arbitrary: true } },
      }),
    ).toBe(true);
  });

  it("rejects malformed envelopes and decodes malformed payloads as unknown", () => {
    expect(isAnvilEvent({ protocolVersion: 99, id: "event-1" })).toBe(false);
    const malformed = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-malformed",
      sequence: 4,
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:04.000Z",
      type: "interaction.requested",
      payload: {},
    };
    expect(isAnvilEvent(malformed)).toBe(false);
    expect(decodeAnvilEvent(malformed)).toMatchObject({
      type: "unknown",
      payload: { eventType: "interaction.requested", payload: {} },
    });
    const nonJsonKnownEvent = {
      ...malformed,
      id: "event-non-json",
      type: "tool.started",
      payload: {
        tool: {
          id: "tool-1",
          kind: "tool",
          toolCallId: "call-1",
          name: "test",
          summary: "Test",
          status: "running",
          arguments: { value: Number.POSITIVE_INFINITY },
          output: [],
          createdAt: "2026-07-21T08:00:04.000Z",
        },
      },
    };
    expect(isAnvilEvent(nonJsonKnownEvent)).toBe(false);
    expect(decodeAnvilEvent(nonJsonKnownEvent)).toMatchObject({ type: "unknown", payload: { payload: null } });
    expect(isAnvilEvent({
      ...malformed,
      id: "event-bad-content",
      type: "message.started",
      payload: { message: { id: "m1", kind: "message", role: "assistant", status: "streaming", createdAt: "now", content: [42] } },
    })).toBe(false);
    expect(isAnvilEvent({
      ...malformed,
      id: "event-bad-catalog",
      type: "catalog.updated",
      payload: { catalog: { models: [{}], commands: [], skills: [] } },
    })).toBe(false);
    expect(
      isAnvilEvent({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "event-1",
        sequence: 1.5,
        sessionId: null,
        timestamp: "now",
        type: "unknown",
        payload: {},
      }),
    ).toBe(false);
  });
});
