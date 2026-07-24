import { describe, expect, it } from "vitest";

import {
  ANVIL_PROTOCOL_VERSION,
  decodeAnvilEvent,
  isAnvilBootstrap,
  isAnvilClientCommand,
  isAnvilEvent,
  isAnvilSessionDetailSync,
  isAnvilSummaryBootstrap,
  isJsonValue,
} from "./index";

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

  it("validates client commands at the wire boundary", () => {
    const command = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "command-1",
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "prompt.send",
      payload: {
        content: "Continue",
        delivery: "steer",
        images: [],
        attachments: [{
          type: "artifactReference",
          artifactId: "01959f7e-7d64-7000-8000-000000000002",
          url: "/api/v1/artifacts/01959f7e-7d64-7000-8000-000000000002",
          mediaType: "text/plain",
          byteLength: 12,
          name: "notes.txt",
        }],
      },
    };
    expect(isAnvilClientCommand(command)).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      payload: {
        ...command.payload,
        attachments: [{ ...command.payload.attachments[0], url: "/api/v1/artifacts/other" }],
      },
    })).toBe(false);
    expect(isAnvilClientCommand({ ...command, payload: { ...command.payload, delivery: "later" } })).toBe(false);
    expect(isAnvilClientCommand({ ...command, sessionId: null })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.create",
      sessionId: null,
      payload: { name: "Anvil", path: "/repo/anvil" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.create",
      sessionId: null,
      payload: { projectId: "anvil", sessionId: "01959f7e-7d64-7000-8000-000000000001" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.create",
      sessionId: null,
      payload: { projectId: "anvil" },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.delete",
      sessionId: null,
      payload: { sessionId: "session-1" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.settled",
      sessionId: "session-1",
      payload: { settled: true },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.settled",
      sessionId: "session-1",
      payload: { settled: "yes" },
    })).toBe(false);
  });

  it("validates externalized artifact content blocks", () => {
    const base = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-artifact",
      sequence: 1,
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "message.started",
    };
    expect(isAnvilEvent({
      ...base,
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          status: "complete",
          createdAt: base.timestamp,
          content: [{
            id: "artifact-1",
            type: "artifact",
            artifactId: "01959f7e-7d64-7000-8000-000000000001",
            url: "/api/v1/artifacts/01959f7e-7d64-7000-8000-000000000001",
            mediaType: "text/plain",
            byteLength: 500000,
            preview: "Preview",
          }],
        },
      },
    })).toBe(true);
    expect(isAnvilEvent({
      ...base,
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          status: "complete",
          createdAt: base.timestamp,
          content: [{ id: "artifact-1", type: "artifact", artifactId: "id", url: "/artifact", mediaType: "text/plain", byteLength: -1 }],
        },
      },
    })).toBe(false);
  });

  it("validates workspace and deletion events", () => {
    const base = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-action",
      sequence: 1,
      sessionId: null,
      timestamp: "2026-07-21T08:00:00.000Z",
    };
    expect(isAnvilEvent({
      ...base,
      type: "project.upserted",
      payload: { project: { id: "anvil", name: "Anvil", path: "/repo/anvil" } },
    })).toBe(true);
    expect(isAnvilEvent({
      ...base,
      sessionId: "session-1",
      type: "session.deleted",
      payload: { sessionId: "session-1" },
    })).toBe(true);
    expect(isAnvilEvent({
      ...base,
      sessionId: "session-1",
      type: "session.settled",
      payload: { settled: true },
    })).toBe(true);
  });

  it("requires a bootstrap tail to follow its snapshot cursor", () => {
    const snapshot = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: "2026-07-21T08:00:00.000Z",
      connection: "connected",
      projects: [],
      sessions: [],
      activeSessionId: null,
      timelines: {},
      catalogs: {},
      pendingInteractions: [],
      extensionStatuses: [],
      widgets: [],
      queues: {},
      composerDrafts: {},
      runStates: {},
      lastSequence: 0,
      sequenceGap: null,
    };
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-1",
      sequence: 1,
      sessionId: null,
      timestamp: "2026-07-21T08:00:01.000Z",
      type: "connection.changed",
      payload: { connection: "connected" },
    };
    expect(isAnvilBootstrap({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [event], cursor: 1 })).toBe(true);
    expect(isAnvilBootstrap({ protocolVersion: ANVIL_PROTOCOL_VERSION, snapshot, events: [{ ...event, sequence: 2 }], cursor: 1 })).toBe(false);
  });

  it("validates lightweight summary and per-session detail synchronization", () => {
    const session = {
      id: "session-1",
      projectId: "anvil",
      title: "Thread",
      updatedAt: "2026-07-21T08:00:00.000Z",
      status: "idle",
      modelId: "test/model",
      thinkingLevel: "medium",
      lastActivitySequence: 4,
      lastTerminalSequence: 4,
      lastTerminalOutcome: "completed",
    };
    expect(isAnvilSummaryBootstrap({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: session.updatedAt,
      connection: "connected",
      projects: [{ id: "anvil", name: "Anvil", path: "/repo" }],
      sessions: [session],
      cursor: 4,
    })).toBe(true);
    expect(isAnvilSessionDetailSync({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "reset",
      detail: {
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        sessionId: session.id,
        throughSequence: 4,
        timeline: [],
        catalog: { models: [], commands: [], skills: [] },
        pendingInteractions: [],
        extensionStatuses: [],
        widgets: [],
        queue: { steering: [], followUp: [] },
        composerDraft: "",
        runState: "idle",
      },
    })).toBe(true);
    expect(isAnvilSummaryBootstrap({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: session.updatedAt,
      connection: "connected",
      projects: [],
      sessions: [{ ...session, lastActivitySequence: -1 }],
      cursor: 4,
    })).toBe(false);
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
    expect(isAnvilEvent({
      ...malformed,
      id: "event-unscoped-catalog",
      sessionId: null,
      type: "catalog.updated",
      payload: { catalog: { models: [], commands: [], skills: [] } },
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
    expect(
      isAnvilEvent({
        protocolVersion: ANVIL_PROTOCOL_VERSION,
        id: "event-zero",
        sequence: 0,
        sessionId: null,
        timestamp: "now",
        type: "connection.changed",
        payload: { connection: "connected" },
      }),
    ).toBe(false);
  });
});
