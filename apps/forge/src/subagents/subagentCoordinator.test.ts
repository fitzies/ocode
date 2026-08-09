import { randomUUID } from "node:crypto";

import {
  ANVIL_PROTOCOL_VERSION,
  SUBAGENT_COMPLETION_MAX_BYTES,
  type AnvilCommandResponse,
  type SessionSummary,
  type SubagentRun,
} from "@anvil/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { ForgeDatabase } from "../store/database.ts";
import { RETAINED_TERMINAL_RUNS_PER_PARENT } from "../store/subagentStore.ts";
import { boundedUtf8, SubagentCoordinator, subagentCompletionContent } from "./subagentCoordinator.ts";

function response(commandId: string, success = true): AnvilCommandResponse {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    id: randomUUID(),
    commandId,
    timestamp: new Date().toISOString(),
    success,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup() {
  const database = new ForgeDatabase(":memory:");
  const project = { id: "project-1", name: "Project", path: "/repo" };
  const events = new ForgeEventService(database, [project]);
  const parent: SessionSummary = {
    id: "parent-1",
    projectId: project.id,
    title: "Parent",
    updatedAt: new Date().toISOString(),
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "off",
  };
  events.createSession(parent, {
    sessionId: parent.id,
    timestamp: parent.updatedAt,
    type: "session.upserted",
    payload: { session: parent },
  });
  const runtime = {
    createSubagentSession: vi.fn((input: { sessionId: string; parentSessionId: string; title: string }) => {
      const child: SessionSummary = {
        id: input.sessionId,
        projectId: project.id,
        title: input.title,
        updatedAt: new Date().toISOString(),
        status: "idle",
        modelId: "test/model",
        thinkingLevel: "off",
        internal: true,
        parentSessionId: input.parentSessionId,
      };
      events.createSession(child, {
        sessionId: child.id,
        timestamp: child.updatedAt,
        type: "session.upserted",
        payload: { session: child },
      });
    }),
    sendSubagentPrompt: vi.fn(async (runId: string, _childSessionId: string, _prompt: string) => response(`subagent-prompt:${runId}`)),
    cancelSubagentSession: vi.fn(async (runId: string) => response(`subagent-cancel:${runId}`)),
    deliverSubagentCompletion: vi.fn(async (deliveryId: string, _parentSessionId: string, _content: string) => response(deliveryId)),
    deleteSubagentSession: vi.fn(async (childSessionId: string) => {
      if (database.getSession(childSessionId)) events.deleteSession(childSessionId, {
        sessionId: childSessionId, timestamp: new Date().toISOString(), type: "session.deleted", payload: { sessionId: childSessionId },
      });
    }),
  };
  const coordinator = new SubagentCoordinator(database, events, runtime, 1);
  return { database, events, runtime, coordinator, parent };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("SubagentCoordinator", () => {
  it("returns after durable admission and deduplicates a repeated tool launch", () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const first = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-1", task: "Do work" });
    const duplicate = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-1", task: "Do other work" });

    expect(first.status).toBe("queued");
    expect(duplicate.id).toBe(first.id);
    expect(database.subagents.get(first.id)?.status).toBe("queued");
    expect(events.currentSnapshot().subagentRuns[parent.id]).toEqual([
      expect.objectContaining({ id: first.id, status: "queued" }),
    ]);
    expect(events.sessionDetail(parent.id)?.subagentRuns).toHaveLength(1);
    expect(runtime.sendSubagentPrompt).not.toHaveBeenCalled();
  });

  it("builds a bounded fresh role prompt without parent transcript", async () => {
    const { database, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const run = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-role", role: "reviewer", task: `Review only this marker ${"x".repeat(60_000)}` });
    await waitUntil(() => database.subagents.get(run.id)?.status === "running");
    const prompt = runtime.sendSubagentPrompt.mock.calls[0]![2];
    expect(prompt).toContain("Review only this marker");
    expect(prompt).not.toContain("unrelated-parent-transcript-secret");
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(48 * 1024);
    expect(database.subagents.get(run.id)?.role).toBe("reviewer");
  });

  it("admits beyond its concurrency bound without starting an extra child", async () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const first = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-bound-1", task: "First" });
    coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-bound-2", task: "Second" });
    await waitUntil(() => database.subagents.get(first.id)?.status === "running");
    expect(runtime.createSubagentSession).toHaveBeenCalledTimes(1);

    events.append([{
      sessionId: first.childSessionId,
      timestamp: new Date().toISOString(),
      type: "run.status",
      payload: { status: "idle", outcome: "completed" },
    }]);
    await waitUntil(() => runtime.createSubagentSession.mock.calls.length === 2);
  });

  it("folds child lifecycle, bounds its preview, and delivers one native parent follow-up", async () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const run = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-2", task: "Summarize" });
    await waitUntil(() => database.subagents.get(run.id)?.status === "running");
    const childId = run.childSessionId;
    events.append([{
      sessionId: childId,
      timestamp: new Date().toISOString(),
      type: "interaction.requested",
      payload: { request: {
        id: "attention-1", sessionId: childId, method: "confirm", title: "Continue?", requestedAt: new Date().toISOString(),
      } },
    }]);
    expect(database.subagents.get(run.id)?.status).toBe("needs_attention");
    events.append([{
      sessionId: childId,
      timestamp: new Date().toISOString(),
      type: "interaction.resolved",
      payload: { requestId: "attention-1", status: "cancelled" },
    }]);
    expect(database.subagents.get(run.id)?.status).toBe("running");
    events.append([{
      sessionId: childId,
      timestamp: new Date().toISOString(),
      type: "message.started",
      payload: { message: {
        id: "assistant-1", kind: "message", role: "assistant", status: "complete",
        content: [{ id: "text-1", type: "text", text: "x".repeat(10_000) }], createdAt: new Date().toISOString(),
      } },
    }, {
      sessionId: childId,
      timestamp: new Date().toISOString(),
      type: "run.status",
      payload: { status: "idle", outcome: "completed" },
    }]);

    await waitUntil(() => database.subagents.get(run.id)?.notification?.status === "delivered");
    const completed = database.subagents.get(run.id)!;
    expect(completed.status).toBe("completed");
    expect(Buffer.byteLength(completed.resultPreview!)).toBeLessThanOrEqual(4 * 1024);
    expect(runtime.deliverSubagentCompletion).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(runtime.deliverSubagentCompletion.mock.calls[0]![2])).toBeLessThanOrEqual(SUBAGENT_COMPLETION_MAX_BYTES);
  });

  it("lets a terminal child event win a cancellation race", async () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const run = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-3", task: "Race" });
    await waitUntil(() => database.subagents.get(run.id)?.status === "running");
    let release!: () => void;
    runtime.cancelSubagentSession.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(response(`subagent-cancel:${run.id}`));
    }));
    const cancelling = coordinator.cancel(parent.id, run.id);
    events.append([{
      sessionId: run.childSessionId,
      timestamp: new Date().toISOString(),
      type: "run.status",
      payload: { status: "idle", outcome: "completed" },
    }]);
    release();
    await cancelling;
    expect(database.subagents.get(run.id)?.status).toBe("cancelled");
  });

  it("stops and removes owned children before parent deletion and ignores late completion races", async () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const run = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-delete", role: "builder", task: "Keep running" });
    await waitUntil(() => database.subagents.get(run.id)?.status === "running");

    await coordinator.deleteOwnedChildren(parent.id);

    expect(runtime.cancelSubagentSession).toHaveBeenCalledOnce();
    expect(runtime.deleteSubagentSession).toHaveBeenCalledWith(run.childSessionId);
    expect(database.getSession(run.childSessionId)).toBeUndefined();
    expect(database.subagents.get(run.id)).toBeUndefined();
    events.append([{
      sessionId: run.childSessionId,
      timestamp: new Date().toISOString(),
      type: "run.status",
      payload: { status: "idle", outcome: "completed" },
    }]);
    expect(database.subagents.get(run.id)).toBeUndefined();
    expect(runtime.deliverSubagentCompletion).not.toHaveBeenCalled();
    expect(() => coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "late-spawn", task: "race" }))
      .toThrow(/being deleted/);
  });

  it("deletes children discovered from session ownership after their run rows are pruned", async () => {
    const { database, events, coordinator, runtime, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const childSessionIds: string[] = [];
    const runIds: string[] = [];
    for (let index = 0; index <= RETAINED_TERMINAL_RUNS_PER_PARENT; index += 1) {
      const childSessionId = `pruned-owned-child-${index}`;
      const timestamp = new Date(index).toISOString();
      childSessionIds.push(childSessionId);
      const child: SessionSummary = {
        id: childSessionId, projectId: parent.projectId, title: "Child", updatedAt: timestamp,
        status: "idle", modelId: "test/model", thinkingLevel: "off", internal: true,
        parentSessionId: parent.id,
      };
      events.createSession(child, {
        sessionId: child.id, timestamp, type: "session.upserted", payload: { session: child },
      });
      const admission = database.subagents.admit({
        parentSessionId: parent.id, parentToolCallId: `pruned-tool-${index}`, childSessionId,
        role: "scout", taskPreview: "done", timestamp,
      });
      runIds.push(admission.run.id);
      events.acceptSubagentEvents(admission.events);
      const completed = database.subagents.updateStatus(
        admission.run.id, "completed", new Date(index + 100).toISOString(), { notify: false },
      );
      if (completed) events.acceptSubagentEvents(completed.events);
    }

    expect(database.subagents.get(runIds[0]!)).toBeUndefined();
    expect(database.getSession(childSessionIds[0]!)).toBeDefined();
    const retained = database.subagents.get(runIds.at(-1)!);
    expect(retained).toBeDefined();
    expect(coordinator.status(parent.id, retained!.id)).toEqual(retained);

    await coordinator.deleteOwnedChildren(parent.id);

    expect(runtime.deleteSubagentSession).toHaveBeenCalledTimes(childSessionIds.length);
    expect(database.childSessionIds(parent.id)).toEqual([]);
    expect(childSessionIds.every((id) => database.getSession(id) === undefined)).toBe(true);
    expect(database.subagents.list(parent.id)).toEqual([]);
  });

  it("bounds retained child-session storage while preserving direct access to retained runs", async () => {
    const { database, events, coordinator, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const runs: SubagentRun[] = [];
    for (let index = 0; index <= RETAINED_TERMINAL_RUNS_PER_PARENT; index += 1) {
      const run = coordinator.launch({
        parentSessionId: parent.id, parentToolCallId: `bounded-tool-${index}`, task: `Task ${index}`,
      });
      runs.push(run);
      await waitUntil(() => database.subagents.get(run.id)?.status === "running");
      events.append([{
        sessionId: run.childSessionId,
        timestamp: new Date().toISOString(),
        type: "run.status",
        payload: { status: "idle", outcome: "completed" },
      }]);
      await waitUntil(() => database.subagents.get(run.id)?.status === "completed");
    }

    await waitUntil(() => database.getSession(runs[0]!.childSessionId) === undefined);
    expect(database.childSessionIds(parent.id).length).toBeLessThanOrEqual(RETAINED_TERMINAL_RUNS_PER_PARENT);
    expect(database.subagents.get(runs[0]!.id)).toBeUndefined();
    const latest = database.subagents.get(runs.at(-1)!.id);
    expect(latest).toMatchObject({ childSessionId: runs.at(-1)!.childSessionId, status: "completed" });
    expect(database.getSession(latest!.childSessionId)).toBeDefined();
    expect(coordinator.status(parent.id, latest!.id)).toEqual(latest);
  });

  it("cleans ownership consistently when an internal child is directly deleted", async () => {
    const { database, coordinator, parent } = setup();
    cleanups.push(() => { coordinator.stop(); database.close(); });
    const run = coordinator.launch({ parentSessionId: parent.id, parentToolCallId: "tool-child-delete", task: "work" });
    await waitUntil(() => database.subagents.get(run.id)?.status === "running");
    await coordinator.prepareChildDeletion(run.childSessionId);
    expect(database.subagents.getByChildSessionId(run.childSessionId)).toBeUndefined();
  });

  it("marks pre-restart work interrupted without replaying its prompt", async () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project-1", name: "Project", path: "/repo" };
    const events = new ForgeEventService(database, [project]);
    const parent: SessionSummary = {
      id: "parent-restart", projectId: project.id, title: "Parent", updatedAt: new Date().toISOString(),
      status: "idle", modelId: "test/model", thinkingLevel: "off",
    };
    events.createSession(parent, { sessionId: parent.id, timestamp: parent.updatedAt, type: "session.upserted", payload: { session: parent } });
    const admission = database.subagents.admit({ parentSessionId: parent.id, parentToolCallId: "tool-restart", childSessionId: randomUUID(), role: "scout", taskPreview: "task", timestamp: new Date().toISOString() });
    events.acceptSubagentEvents(admission.events);
    const running = database.subagents.updateStatus(admission.run.id, "running", new Date().toISOString());
    if (running) events.acceptSubagentEvents(running.events);
    const runtime = {
      createSubagentSession: vi.fn(),
      sendSubagentPrompt: vi.fn(async () => response("prompt")),
      cancelSubagentSession: vi.fn(async () => response("cancel")),
      deliverSubagentCompletion: vi.fn(async (id: string, _parentSessionId: string, _content: string) => response(id)),
      deleteSubagentSession: vi.fn(async () => undefined),
    };
    const coordinator = new SubagentCoordinator(database, events, runtime);
    cleanups.push(() => { coordinator.stop(); database.close(); });

    expect(database.subagents.get(admission.run.id)?.status).toBe("interrupted");
    expect(runtime.sendSubagentPrompt).not.toHaveBeenCalled();
    await waitUntil(() => runtime.deliverSubagentCompletion.mock.calls.length === 1);
  });

  it("never replays a completion side effect whose restart outcome is unknown", async () => {
    const database = new ForgeDatabase(":memory:");
    const project = { id: "project-1", name: "Project", path: "/repo" };
    const events = new ForgeEventService(database, [project]);
    const parent: SessionSummary = { id: "parent-uncertain", projectId: project.id, title: "Parent", updatedAt: new Date().toISOString(), status: "idle", modelId: "test/model", thinkingLevel: "off" };
    events.createSession(parent, { sessionId: parent.id, timestamp: parent.updatedAt, type: "session.upserted", payload: { session: parent } });
    const admission = database.subagents.admit({ parentSessionId: parent.id, parentToolCallId: "tool", childSessionId: "child-preserved", role: "researcher", taskPreview: "preserved task metadata", timestamp: new Date().toISOString() });
    events.acceptSubagentEvents(admission.events);
    const completed = database.subagents.updateStatus(admission.run.id, "completed", new Date().toISOString());
    if (completed) events.acceptSubagentEvents(completed.events);
    expect(database.subagents.claimDelivery()?.status).toBe("delivering");
    const runtime = {
      createSubagentSession: vi.fn(), sendSubagentPrompt: vi.fn(), cancelSubagentSession: vi.fn(),
      deliverSubagentCompletion: vi.fn(), deleteSubagentSession: vi.fn(),
    };
    const coordinator = new SubagentCoordinator(database, events, runtime as never);
    cleanups.push(() => { coordinator.stop(); database.close(); });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.deliverSubagentCompletion).not.toHaveBeenCalled();
    expect(database.subagents.get(admission.run.id)).toMatchObject({
      childSessionId: "child-preserved", role: "researcher", taskPreview: "preserved task metadata",
      notification: { status: "uncertain" },
    });
    expect(database.subagents.resumeMetadata(admission.run.id)).toEqual({
      childSessionId: "child-preserved", role: "researcher", task: "preserved task metadata",
    });
  });

  it("bounds UTF-8 completion content", () => {
    expect(Buffer.byteLength(boundedUtf8("😀".repeat(5_000), 100))).toBeLessThanOrEqual(100);
    const content = subagentCompletionContent({
      id: "run", parentSessionId: "parent", parentToolCallId: "tool", childSessionId: "child", role: "scout",
      status: "completed", taskPreview: "task", resultPreview: "😀".repeat(5_000),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(SUBAGENT_COMPLETION_MAX_BYTES);
  });
});
