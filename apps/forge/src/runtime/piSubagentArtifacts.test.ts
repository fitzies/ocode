import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubagentRun, ToolEntry } from "@anvil/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { PiSubagentArtifactTracker, trackedWorkflowFromTool } from "./piSubagentArtifacts.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const workflowId = crypto.randomUUID();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const asyncRoot = join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
  const asyncDir = join(asyncRoot, workflowId);
  mkdirSync(asyncDir, { recursive: true });
  cleanup.push(asyncDir);

  const sessionDir = mkdtempSync(join(tmpdir(), "ocode-subagent-session-"));
  cleanup.push(sessionDir);
  const ownerDir = join(sessionDir, "session-owner");
  const artifactsDir = join(ownerDir, "subagent-artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const sessionFile = join(ownerDir, "session.jsonl");
  writeFileSync(sessionFile, "");

  const tool: ToolEntry = {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "subagent",
    summary: "Run subagent",
    status: "completed",
    arguments: {},
    output: [],
    details: { mode: "workflow", asyncId: workflowId, asyncDir },
    createdAt: "2026-08-09T08:00:00.000Z",
  };
  return { workflowId, asyncDir, sessionDir, sessionFile, artifactsDir, tool };
}

function nextPublish(published: SubagentRun[][]): Promise<SubagentRun[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = published.shift();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for artifact projection"));
      }
    }, 10);
  });
}

describe("PiSubagentArtifactTracker", () => {
  it("rejects tool details outside the package-owned async root", () => {
    const tool: ToolEntry = {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "subagent",
      summary: "Run subagent",
      status: "completed",
      arguments: {},
      output: [],
      details: { asyncId: "unsafe", asyncDir: "/tmp" },
      createdAt: "2026-08-09T08:00:00.000Z",
    };
    expect(trackedWorkflowFromTool(tool)).toBeUndefined();
  });

  it("projects live children and enriches their completed transcript", async () => {
    const { workflowId, asyncDir, sessionDir, sessionFile, artifactsDir, tool } = fixture();
    const liveTranscriptPath = join(artifactsDir, "live-transcript.jsonl");
    writeFileSync(liveTranscriptPath, [
      JSON.stringify({ recordType: "tool_start", ts: Date.parse("2026-08-09T08:00:01.000Z"), toolName: "search", toolCallId: "live-search", argsPreview: "RPC docs" }),
      JSON.stringify({ recordType: "tool_end", ts: Date.parse("2026-08-09T08:00:02.000Z"), toolName: "search", toolCallId: "live-search", resultPreview: "Found docs" }),
    ].join("\n"));
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "workflow",
      state: "running",
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:00:04.000Z"),
      steps: [{
        agent: "researcher",
        workflowKey: "research",
        description: "Investigate the protocol",
        status: "running",
        currentTool: "search",
        transcriptPath: liveTranscriptPath,
        recentTools: [{ tool: "read", args: "README.md", endMs: 1 }],
      }],
      workflow: { trace: [{ operation: "run", key: "research", state: "started" }], emits: [], console: [] },
    }));

    const published: SubagentRun[][] = [];
    let current: SubagentRun[] = [];
    const tracker = new PiSubagentArtifactTracker({
      sessionDir,
      currentRuns: () => current,
      publish: (_sessionId, runs) => {
        current = runs;
        published.push(runs);
      },
    });
    tracker.track("session-1", tool);
    const live = await nextPublish(published);
    expect(live[0]).toMatchObject({
      id: `${workflowId}:0`,
      agent: "researcher",
      task: "Investigate the protocol",
      status: "running",
      currentActivity: "search",
      mode: "workflow",
      capabilities: { steer: false, interrupt: false, stop: true, resume: false },
    });
    expect(live[0]?.transcript).toMatchObject([{ toolName: "search", status: "completed", text: "Found docs" }]);

    const childId = "abc12345";
    const transcriptPath = join(artifactsDir, `${childId}_researcher_0_transcript.jsonl`);
    writeFileSync(transcriptPath, [
      JSON.stringify({ recordType: "tool_start", ts: Date.parse("2026-08-09T08:00:01.000Z"), toolName: "search", toolCallId: "search-1", argsPreview: "RPC docs" }),
      JSON.stringify({ recordType: "tool_end", ts: Date.parse("2026-08-09T08:00:02.000Z"), toolName: "search", toolCallId: "search-1", resultPreview: "Found docs" }),
      JSON.stringify({ recordType: "message", ts: Date.parse("2026-08-09T08:00:03.000Z"), role: "assistant", text: "## Result\nComplete." }),
    ].join("\n"));
    writeFileSync(join(artifactsDir, `${childId}_researcher_0_meta.json`), JSON.stringify({
      runId: childId,
      agent: "researcher",
      task: "Investigate the protocol deeply",
      model: "test/model:high",
      transcriptPath,
      usage: { input: 10, output: 5, total: 15, turns: 2 },
    }));
    writeFileSync(join(artifactsDir, `${childId}_researcher_0_output.md`), "## Result\nComplete.");
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "workflow",
      state: "complete",
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      endedAt: Date.parse("2026-08-09T08:00:05.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:00:05.000Z"),
      steps: [{ agent: "research", workflowKey: "research", status: "completed" }],
      steering: {
        recent: [{ id: "provider-steer-1", targets: [{ index: 0, state: "delivered", deliveredAt: Date.parse("2026-08-09T08:00:04.500Z") }] }],
      },
      workflow: {
        value: { key: "research", runId: childId, results: [{ sessionFile }] },
        trace: [
          { operation: "run", key: "research", state: "started" },
          { operation: "run", key: "research", state: "completed", runId: childId },
        ],
        emits: [],
        console: [],
      },
    }));

    current[0]!.receipts = [{
      id: "receipt-1",
      kind: "steer",
      state: "pending",
      requestedAt: "2026-08-09T08:00:03.000Z",
      updatedAt: "2026-08-09T08:00:03.000Z",
      providerRequestId: "provider-steer-1",
    }];
    await tracker.refresh("session-1");
    const completed = await nextPublish(published);
    expect(completed[0]).toMatchObject({
      providerRunId: childId,
      agent: "researcher",
      task: "Investigate the protocol deeply",
      status: "completed",
      response: "## Result\nComplete.",
      usage: { input: 10, output: 5, total: 15, turns: 2 },
      capabilities: { steer: false, interrupt: false, stop: false, resume: true },
      receipts: [{ id: "receipt-1", state: "delivered" }],
    });
    expect(completed[0]?.transcript.map((entry) => entry.type)).toEqual(["tool", "message"]);
    expect(await tracker.prepareResume("session-1", completed[0]!)).toBe(true);
    const preparedStatus = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
    expect(preparedStatus.steps[0].sessionFile).toBe(sessionFile);
    expect(preparedStatus.steps[0].agent).toBe("researcher");
    tracker.close();
  });

  it("restores replacement workflow tracking from durable normalized runs", async () => {
    const { workflowId, asyncDir, sessionDir, sessionFile } = fixture();
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "single",
      state: "complete",
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      endedAt: Date.parse("2026-08-09T08:00:01.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:00:01.000Z"),
      steps: [{ agent: "researcher", status: "completed", sessionFile }],
    }));
    const run: SubagentRun = {
      id: `${workflowId}:0`, provider: "pi-subagents", workflowId, mode: "single", index: 0,
      key: "researcher", agent: "researcher", status: "completed",
      startedAt: "2026-08-09T08:00:00.000Z", updatedAt: "2026-08-09T08:00:01.000Z",
      endedAt: "2026-08-09T08:00:01.000Z", transcript: [], receipts: [],
      capabilities: { steer: false, interrupt: false, stop: false, resume: true },
    };
    const tracker = new PiSubagentArtifactTracker({
      sessionDir,
      currentRuns: () => [run],
      publish: () => undefined,
    });

    tracker.restore({}, { "session-1": [run] });
    expect(await tracker.prepareResume("session-1", run)).toBe(true);
    tracker.close();
  });

  it("preserves a command receipt appended while an artifact projection is in flight", async () => {
    const { workflowId, asyncDir, sessionDir, sessionFile, tool } = fixture();
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "single",
      state: "running",
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:00:01.000Z"),
      steps: [{ agent: "scout", status: "running" }],
    }));
    const current: SubagentRun[] = [{
      id: `${workflowId}:0`, provider: "pi-subagents", workflowId, mode: "single", index: 0,
      key: "scout", agent: "scout", status: "running", startedAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:00:01.000Z", transcript: [], receipts: [],
      capabilities: { steer: true, interrupt: true, stop: true, resume: false },
    }];
    let reads = 0;
    const published: SubagentRun[][] = [];
    const tracker = new PiSubagentArtifactTracker({
      sessionDir,
      currentRuns: () => {
        reads += 1;
        if (reads === 2) current[0]!.receipts.push({
          id: "receipt-race", kind: "steer", state: "requested",
          requestedAt: "2026-08-09T08:00:01.100Z", updatedAt: "2026-08-09T08:00:01.100Z",
        });
        return current;
      },
      publish: (_sessionId, runs) => published.push(runs),
    });
    tracker.track("session-1", tool);

    const projected = await nextPublish(published);
    expect(projected[0]?.receipts).toEqual([expect.objectContaining({ id: "receipt-race", state: "requested" })]);
    tracker.close();
  });

  it("fails an abandoned requested receipt so the control can be retried", async () => {
    const { workflowId, asyncDir, sessionDir, sessionFile, tool } = fixture();
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "single",
      state: "running",
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:01:01.000Z"),
      steps: [{ agent: "scout", status: "running" }],
    }));
    const current: SubagentRun[] = [{
      id: `${workflowId}:0`, provider: "pi-subagents", workflowId, mode: "single", index: 0,
      key: "scout", agent: "scout", status: "running", startedAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:00:01.000Z", transcript: [],
      receipts: [{ id: "receipt-abandoned", kind: "interrupt", state: "requested", requestedAt: "2026-08-09T08:00:00.000Z", updatedAt: "2026-08-09T08:00:00.000Z" }],
      capabilities: { steer: true, interrupt: true, stop: true, resume: false },
    }];
    const published: SubagentRun[][] = [];
    const tracker = new PiSubagentArtifactTracker({
      sessionDir,
      currentRuns: () => current,
      publish: (_sessionId, runs) => published.push(runs),
      now: () => Date.parse("2026-08-09T08:01:01.000Z"),
    });
    tracker.track("session-1", tool);

    const projected = await nextPublish(published);
    expect(projected[0]?.receipts).toEqual([expect.objectContaining({
      id: "receipt-abandoned",
      state: "failed",
      error: "Delivery was interrupted before the provider acknowledged the command",
    })]);
    tracker.close();
  });

  it("projects stopped workflow children as cancelled and settles the stop receipt", async () => {
    const { workflowId, asyncDir, sessionDir, sessionFile, tool } = fixture();
    writeFileSync(join(asyncDir, "status.json"), JSON.stringify({
      runId: workflowId,
      sessionId: sessionFile,
      mode: "workflow",
      state: "stopped",
      stopped: true,
      startedAt: Date.parse("2026-08-09T08:00:00.000Z"),
      endedAt: Date.parse("2026-08-09T08:00:02.000Z"),
      lastUpdate: Date.parse("2026-08-09T08:00:02.000Z"),
      steps: [{ agent: "stop-probe", workflowKey: "stop-probe", status: "failed", error: "SIGTERM" }],
      workflow: { trace: [{ operation: "run", key: "stop-probe", state: "failed", runId: "child-stop" }], emits: [], console: [] },
    }));

    const current: SubagentRun[] = [{
      id: `${workflowId}:0`,
      provider: "pi-subagents",
      workflowId,
      mode: "workflow",
      index: 0,
      key: "stop-probe",
      agent: "stop-probe",
      status: "running",
      startedAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:00:01.000Z",
      transcript: [],
      receipts: [{
        id: "stop-receipt",
        kind: "stop",
        state: "pending",
        requestedAt: "2026-08-09T08:00:01.000Z",
        updatedAt: "2026-08-09T08:00:01.000Z",
      }],
      capabilities: { steer: false, interrupt: false, stop: true, resume: false },
    }];
    const published: SubagentRun[][] = [];
    const tracker = new PiSubagentArtifactTracker({
      sessionDir,
      currentRuns: () => current,
      publish: (_sessionId, runs) => published.push(runs),
    });
    tracker.track("session-1", tool);
    const stopped = await nextPublish(published);

    expect(stopped[0]).toMatchObject({
      status: "cancelled",
      mode: "workflow",
      receipts: [{ id: "stop-receipt", state: "delivered" }],
      capabilities: { steer: false, interrupt: false, stop: false, resume: false },
    });
    tracker.close();
  });
});
