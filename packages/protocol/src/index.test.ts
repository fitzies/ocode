import { describe, expect, it } from "vitest";

import {
  ANVIL_PROTOCOL_VERSION,
  decodeAnvilEvent,
  GENERAL_PROJECT_ID,
  isAnvilBootstrap,
  isAnvilClientCommand,
  isAnvilEvent,
  isAnvilSessionDetailSync,
  isAnvilSummaryBootstrap,
  isGeneralProject,
  isGitHubRepositoryPage,
  isGitHubRepositorySummary,
  isJsonValue,
  isProjectDirectoryCatalog,
  normalizeProjectSlug,
  provisionalSessionTitleFromPrompt,
} from "./index";

describe("protocol runtime guards", () => {
  it("validates Forge-native subagent lifecycle events and cancellation", () => {
    const run = {
      id: "run-1",
      parentSessionId: "session-1",
      parentToolCallId: "tool-1",
      childSessionId: "child-1",
      role: "reviewer",
      status: "needs_attention",
      taskPreview: "Review the migration",
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-21T08:01:00.000Z",
    };
    expect(isAnvilEvent({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-subagent",
      sequence: 1,
      sessionId: "session-1",
      timestamp: run.updatedAt,
      type: "subagent.updated",
      payload: { run },
    })).toBe(true);
    expect(isAnvilEvent({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-subagent-invalid",
      sequence: 1,
      sessionId: "session-1",
      timestamp: run.updatedAt,
      type: "subagent.updated",
      payload: { run: { ...run, status: "paused" } },
    })).toBe(false);
    expect(isAnvilClientCommand({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "cancel-subagent",
      sessionId: "session-1",
      timestamp: run.updatedAt,
      type: "subagent.cancel",
      payload: { runId: run.id },
    })).toBe(true);
  });

  it("builds a compact provisional title from the first prompt", () => {
    expect(provisionalSessionTitleFromPrompt("  Fix   the sidebar\nwhile Pi names this thread  "))
      .toBe("Fix the sidebar while Pi names this…");
    expect(provisionalSessionTitleFromPrompt("Ship it")).toBe("Ship it");
    expect(provisionalSessionTitleFromPrompt("😀".repeat(37))).toBe(`${"😀".repeat(35)}…`);
  });

  it("identifies reserved and adopted General workspaces", () => {
    expect(isGeneralProject({ id: GENERAL_PROJECT_ID })).toBe(true);
    expect(isGeneralProject({ id: "existing-home", workspaceKind: "general" })).toBe(true);
    expect(isGeneralProject({ id: "project", workspaceKind: "folder" })).toBe(false);
  });

  it("accepts JSON-compatible arbitrary extension details", () => {
    expect(isJsonValue({ nested: ["value", 3, true, null] })).toBe(true);
    expect(isJsonValue({ invalid: undefined })).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("validates shared GitHub repository summaries", () => {
    const repository = {
      nameWithOwner: "organization/private-tools",
      name: "private-tools",
      owner: "organization",
      private: true,
      updatedAt: "2026-07-23T01:00:00Z",
    };
    expect(isGitHubRepositorySummary(repository)).toBe(true);
    expect(isGitHubRepositorySummary({ ...repository, extra: true })).toBe(true);
    expect(isGitHubRepositorySummary({ ...repository, private: "yes" })).toBe(false);
    expect(isGitHubRepositorySummary({ ...repository, updatedAt: undefined })).toBe(false);
    expect(isGitHubRepositorySummary({ ...repository, updatedAt: "not-a-date" })).toBe(false);
    expect(isGitHubRepositorySummary({ ...repository, owner: "" })).toBe(false);
    expect(isGitHubRepositorySummary({ ...repository, name: "private tools" })).toBe(false);
    for (const name of ["-private-tools", ".git", "..git", "...git"]) {
      expect(isGitHubRepositorySummary({
        ...repository,
        name,
        nameWithOwner: `organization/${name}`,
      })).toBe(false);
    }
    expect(isGitHubRepositorySummary({ ...repository, nameWithOwner: "other/private-tools" })).toBe(false);
    expect(isGitHubRepositorySummary({ ...repository, nameWithOwner: "organization/private-tools/extra" })).toBe(false);
  });

  it("validates paginated GitHub repository responses", () => {
    const page = {
      repositories: [{
        nameWithOwner: "organization/private-tools",
        name: "private-tools",
        owner: "organization",
        private: true,
        updatedAt: "2026-07-23T01:00:00Z",
      }],
      page: 2,
      hasMore: true,
    };
    expect(isGitHubRepositoryPage(page)).toBe(true);
    expect(isGitHubRepositoryPage({ ...page, extra: true })).toBe(true);
    expect(isGitHubRepositoryPage({ ...page, repositories: [{}] })).toBe(false);
    expect(isGitHubRepositoryPage({ ...page, page: 0 })).toBe(false);
    expect(isGitHubRepositoryPage({ ...page, page: 1.5 })).toBe(false);
    expect(isGitHubRepositoryPage({ ...page, hasMore: "yes" })).toBe(false);
  });

  it("validates bounded project directory catalogs", () => {
    expect(isProjectDirectoryCatalog({ directories: [{ name: "ocode", path: "/srv/projects/ocode" }] })).toBe(true);
    expect(isProjectDirectoryCatalog({ directories: [{ name: "ocode", path: "relative/ocode" }] })).toBe(false);
    expect(isProjectDirectoryCatalog({ directories: Array.from({ length: 201 }, () => ({ name: "x", path: "/x" })) })).toBe(false);
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

  it("accepts durable project removal only at project scope", () => {
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-project-deleted",
      sequence: 1,
      sessionId: null,
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "project.deleted",
      payload: { projectId: "anvil" },
    };
    expect(isAnvilEvent(event)).toBe(true);
    expect(isAnvilEvent({ ...event, sessionId: "session-1" })).toBe(false);
    expect(isAnvilEvent({ ...event, payload: {} })).toBe(false);
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
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.create",
      sessionId: null,
      payload: { name: "New Project" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.clone",
      sessionId: null,
      payload: { name: "Ocode", repository: "owner/ocode" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.clone",
      sessionId: null,
      payload: { name: "Ocode" },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.clone",
      sessionId: "session-1",
      payload: { name: "Ocode", repository: "owner/ocode" },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.clone",
      sessionId: null,
      payload: { name: "Ocode", repository: "owner/ocode", path: "/tmp/ocode" },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.addExisting",
      sessionId: null,
      payload: { name: "Existing Project", path: "/code/existing-project" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.delete",
      sessionId: null,
      payload: { projectId: "anvil" },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "project.delete",
      sessionId: "session-1",
      payload: { projectId: "anvil" },
    })).toBe(false);
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
      type: "session.rename",
      sessionId: "session-1",
      payload: { title: "  A clearer thread title  " },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.rename",
      sessionId: "session-1",
      payload: { title: "   " },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.rename",
      sessionId: "session-1",
      payload: { title: "x".repeat(121) },
    })).toBe(false);
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
    expect(isAnvilClientCommand({
      ...command,
      type: "session.markRead",
      sessionId: "session-1",
      payload: { throughSequence: 42 },
    })).toBe(true);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.markRead",
      sessionId: "session-1",
      payload: { throughSequence: -1 },
    })).toBe(false);
    expect(isAnvilClientCommand({
      ...command,
      type: "session.markUnread",
      sessionId: "session-1",
      payload: {},
    })).toBe(true);
  });

  it("validates Forge-owned session read-state events", () => {
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-read-state",
      sequence: 1,
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "session.readState",
      payload: { readThroughSequence: 42 },
    };
    expect(isAnvilEvent(event)).toBe(true);
    expect(isAnvilEvent({ ...event, payload: { readThroughSequence: -1 } })).toBe(false);
  });

  it("validates subagent provenance on user-role messages", () => {
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-subagent-origin",
      sequence: 1,
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "message-subagent",
          kind: "message",
          role: "user",
          origin: {
            type: "subagentCompletion",
            runId: "run-1",
            childSessionId: "child-1",
            deliveryId: "subagent-completion:run-1",
            role: "reviewer",
            status: "completed",
          },
          status: "complete",
          createdAt: "2026-07-21T08:00:00.000Z",
          content: [{ id: "text-1", type: "text", text: "Result" }],
        },
      },
    };
    expect(isAnvilEvent(event)).toBe(true);
    expect(isAnvilEvent({
      ...event,
      payload: { message: { ...event.payload.message, origin: { ...event.payload.message.origin, status: "running" } } },
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

  it("validates bounded inline HTML content blocks", () => {
    const html = "<!doctype html><p>Hello</p>";
    const event = {
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      id: "event-inline-html",
      sequence: 1,
      sessionId: "session-1",
      timestamp: "2026-07-21T08:00:00.000Z",
      type: "message.started",
      payload: {
        message: {
          id: "message-1",
          kind: "message",
          role: "assistant",
          status: "complete",
          createdAt: "2026-07-21T08:00:00.000Z",
          content: [{
            id: "inline-html-1",
            type: "inlineHtml",
            title: "Greeting",
            html,
            sourcePath: "artifacts/greeting.html",
            byteLength: new TextEncoder().encode(html).byteLength,
          }],
        },
      },
    };

    expect(isAnvilEvent(event)).toBe(true);
    expect(isAnvilEvent({
      ...event,
      payload: {
        message: {
          ...event.payload.message,
          content: [{ ...event.payload.message.content[0], byteLength: 1 }],
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
    expect(isAnvilEvent({
      ...base,
      sessionId: "session-1",
      type: "session.prompted",
      payload: {},
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
      subagentRuns: {},
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
      lastUserMessageAt: "2026-07-21T07:59:00.000Z",
      lastUserMessageSequence: 4,
      lastActivitySequence: 4,
      lastTerminalSequence: 4,
      lastTerminalOutcome: "completed",
    };
    expect(isAnvilSummaryBootstrap({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: session.updatedAt,
      connection: "connected",
      projects: [{ id: "anvil", name: "Anvil", path: "/repo", workspaceKind: "worktree" }],
      sessions: [session],
      cursor: 4,
    })).toBe(true);
    expect(isAnvilSummaryBootstrap({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: session.updatedAt,
      connection: "connected",
      projects: [{ id: "anvil", name: "Anvil", path: "/repo", workspaceKind: "unknown" }],
      sessions: [session],
      cursor: 4,
    })).toBe(false);
    expect(isAnvilSessionDetailSync({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "delta",
      sessionId: session.id,
      fromSequence: 4,
      throughSequence: 4,
      events: [],
      subagentRuns: [],
    })).toBe(true);
    expect(isAnvilSessionDetailSync({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "delta",
      sessionId: session.id,
      fromSequence: 4,
      throughSequence: 4,
      events: [],
      subagentRuns: [{}],
    })).toBe(false);
    // Older servers omitted the projection; clients still accept that shape.
    expect(isAnvilSessionDetailSync({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      mode: "delta",
      sessionId: session.id,
      fromSequence: 4,
      throughSequence: 4,
      events: [],
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
        subagentRuns: [],
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
    expect(isAnvilSummaryBootstrap({
      protocolVersion: ANVIL_PROTOCOL_VERSION,
      capturedAt: session.updatedAt,
      connection: "connected",
      projects: [],
      sessions: [{ ...session, lastUserMessageAt: "not-a-timestamp" }],
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

  it("normalizes neat project names into filesystem slugs", () => {
    expect(normalizeProjectSlug("  My Café / API!!  ")).toBe("my-cafe-api");
    expect(normalizeProjectSlug("---___***")).toBe("");
    expect(normalizeProjectSlug("Already--Neat")).toBe("already-neat");
  });
});
