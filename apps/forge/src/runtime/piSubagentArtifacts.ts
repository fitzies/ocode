import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type {
  SubagentCommandReceipt,
  SubagentRun,
  SubagentRunMode,
  SubagentRunStatus,
  SubagentTranscriptEntry,
  ToolEntry,
} from "@anvil/protocol";

const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_META_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 120;
const MAX_TRANSCRIPT_TEXT = 64 * 1024;
const POLL_INTERVAL_MS = 750;
const MISSING_STATUS_RETRY_MS = 15_000;
const ABANDONED_RECEIPT_MS = 60_000;

interface TrackedWorkflow {
  sessionId: string;
  workflowId: string;
  asyncDir: string;
  missingSince?: number;
  terminal: boolean;
}

interface ArtifactStep {
  agent?: unknown;
  label?: unknown;
  workflowKey?: unknown;
  description?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  model?: unknown;
  thinking?: unknown;
  tokens?: unknown;
  totalCost?: unknown;
  currentTool?: unknown;
  currentPath?: unknown;
  recentTools?: unknown;
  recentOutput?: unknown;
  error?: unknown;
  sessionFile?: unknown;
  transcriptPath?: unknown;
  runner?: unknown;
}

interface ArtifactStatus {
  runId?: unknown;
  sessionId?: unknown;
  mode?: unknown;
  state?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  lastUpdate?: unknown;
  steps?: unknown;
  workflow?: unknown;
  steering?: unknown;
  stopped?: unknown;
  error?: unknown;
}

interface ChildMetadata {
  runId?: unknown;
  agent?: unknown;
  task?: unknown;
  model?: unknown;
  thinking?: unknown;
  durationMs?: unknown;
  timestamp?: unknown;
  transcriptPath?: unknown;
  usage?: unknown;
  exitCode?: unknown;
  error?: unknown;
}

export interface PiSubagentArtifactTrackerOptions {
  sessionDir: string;
  currentRuns(sessionId: string): SubagentRun[];
  publish(sessionId: string, runs: SubagentRun[]): void;
  now?: () => number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringOf(value: unknown, max = 4_096): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown, fallback: number): string {
  const milliseconds = numberOf(value) ?? fallback;
  return new Date(milliseconds).toISOString();
}

function mappedStatus(value: unknown): SubagentRunStatus {
  if (value === "queued" || value === "pending") return "queued";
  if (value === "running") return "running";
  if (value === "paused") return "paused";
  if (value === "complete" || value === "completed") return "completed";
  if (value === "stopped") return "cancelled";
  if (value === "rejected") return "rejected";
  return "failed";
}

function isActive(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeRealPath(path: string, root: string): string | undefined {
  try {
    const actual = realpathSync(path);
    const actualRoot = realpathSync(root);
    return actual === actualRoot || actual.startsWith(`${actualRoot}${sep}`) ? actual : undefined;
  } catch {
    return undefined;
  }
}

async function boundedTextFile(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const size = statSync(path).size;
    if (size < 0 || size > maxBytes) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function boundedJson(path: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const text = await boundedTextFile(path, maxBytes);
  if (!text) return undefined;
  try {
    return recordOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asyncRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
}

function trackedWorkflowDescriptor(workflowIdValue: unknown, asyncDirValue: unknown): { workflowId: string; asyncDir: string } | undefined {
  const workflowId = stringOf(workflowIdValue, 160);
  const candidateDir = stringOf(asyncDirValue, 4_096);
  if (!workflowId || !candidateDir || basename(candidateDir) !== workflowId) return undefined;
  const actual = safeRealPath(candidateDir, asyncRoot());
  return actual ? { workflowId, asyncDir: actual } : undefined;
}

export function trackedWorkflowFromTool(entry: ToolEntry): { workflowId: string; asyncDir: string } | undefined {
  if (entry.name.toLowerCase() !== "subagent") return undefined;
  const details = recordOf(entry.details);
  return trackedWorkflowDescriptor(details?.asyncId ?? details?.runId, details?.asyncDir);
}

function providerRunId(status: ArtifactStatus, key: string, index: number, stepValue: unknown): string | undefined {
  const valueRunId = stringOf(recordOf(stepValue)?.runId, 160);
  if (valueRunId) return valueRunId;
  const workflow = recordOf(status.workflow);
  const trace = Array.isArray(workflow?.trace) ? workflow.trace : [];
  const completed = trace.map(recordOf).filter((item) => item?.state === "completed" && stringOf(item.runId, 160));
  for (let offset = completed.length - 1; offset >= 0; offset--) {
    const item = completed[offset];
    if (item?.key === key) return stringOf(item.runId, 160);
  }
  return stringOf(completed[index]?.runId, 160);
}

function workflowValue(status: ArtifactStatus): unknown {
  return recordOf(status.workflow)?.value;
}

function valueForStep(status: ArtifactStatus, key: string, index: number): unknown {
  const value = workflowValue(status);
  if (Array.isArray(value)) return value[index];
  const record = recordOf(value);
  if (!record) return value;
  if (record[key] !== undefined) return record[key];
  if (record.key === key || index === 0) return record;
  return undefined;
}

function responseFromValue(value: unknown): string | undefined {
  if (typeof value === "string") return stringOf(value, MAX_TRANSCRIPT_TEXT);
  const record = recordOf(value);
  return stringOf(record?.output ?? record?.finalOutput, MAX_TRANSCRIPT_TEXT);
}

function sessionFileFromValue(value: unknown): string | undefined {
  const record = recordOf(value);
  const direct = stringOf(record?.sessionFile, 8_192);
  if (direct) return direct;
  const results = Array.isArray(record?.results) ? record.results : [];
  for (const result of results) {
    const sessionFile = stringOf(recordOf(result)?.sessionFile, 8_192);
    if (sessionFile) return sessionFile;
  }
  return undefined;
}

function metadataRoot(status: ArtifactStatus, configuredSessionDir: string): string | undefined {
  const sessionFile = stringOf(status.sessionId, 8_192);
  if (!sessionFile) return undefined;
  const owner = safeRealPath(dirname(sessionFile), configuredSessionDir);
  if (!owner) return undefined;
  const artifacts = join(owner, "subagent-artifacts");
  return existsSync(artifacts) ? safeRealPath(artifacts, configuredSessionDir) : undefined;
}

async function childMetadata(
  root: string | undefined,
  providerRunId: string | undefined,
): Promise<{ metadata?: ChildMetadata; metaPath?: string; output?: string }> {
  if (!root || !providerRunId) return {};
  let name: string | undefined;
  try {
    name = readdirSync(root).find((candidate) => candidate.startsWith(`${providerRunId}_`) && candidate.endsWith("_meta.json"));
  } catch {
    return {};
  }
  if (!name) return {};
  const metaPath = safeRealPath(join(root, name), root);
  if (!metaPath) return {};
  const metadata = await boundedJson(metaPath, MAX_META_BYTES) as ChildMetadata | undefined;
  const outputPath = safeRealPath(metaPath.replace(/_meta\.json$/, "_output.md"), root);
  const output = outputPath ? stringOf(await boundedTextFile(outputPath, MAX_TRANSCRIPT_BYTES), MAX_TRANSCRIPT_TEXT) : undefined;
  return { metadata, metaPath, output };
}

function transcriptEntry(record: Record<string, unknown>): SubagentTranscriptEntry | undefined {
  const ts = numberOf(record.ts) ?? Date.parse(String(record.timestamp ?? ""));
  const at = Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(0).toISOString();
  const recordType = record.recordType;
  if (recordType === "message" && record.role === "assistant") {
    const text = stringOf(record.text, MAX_TRANSCRIPT_TEXT);
    if (!text) return undefined;
    return { id: `message-${digest(`${at}:${text}`)}`, timestamp: at, type: "message", role: "assistant", text };
  }
  if (recordType === "tool_start" || recordType === "tool_end") {
    const toolName = stringOf(record.toolName, 160) ?? "tool";
    const toolCallId = stringOf(record.toolCallId, 256);
    const text = stringOf(record.resultPreview ?? record.argsPreview ?? record.error, 8_192);
    return {
      id: `tool-${digest(`${at}:${toolCallId ?? toolName}:${recordType}:${text ?? ""}`)}`,
      timestamp: at,
      type: "tool",
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      ...(text ? { text } : {}),
      status: recordType === "tool_start" ? "running" : record.isError ? "failed" : "completed",
    };
  }
  return undefined;
}

async function readTranscript(
  root: string | undefined,
  metadata: ChildMetadata | undefined,
  liveTranscriptPath?: unknown,
): Promise<SubagentTranscriptEntry[]> {
  const candidate = stringOf(liveTranscriptPath ?? metadata?.transcriptPath, 8_192);
  if (!root || !candidate) return [];
  const path = safeRealPath(candidate, root);
  const text = path ? await boundedTextFile(path, MAX_TRANSCRIPT_BYTES) : undefined;
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-MAX_TRANSCRIPT_ENTRIES * 3);
  const entries: SubagentTranscriptEntry[] = [];
  const activeTools = new Map<string, number>();
  for (const line of lines) {
    try {
      const record = recordOf(JSON.parse(line));
      const entry = record ? transcriptEntry(record) : undefined;
      if (!entry) continue;
      if (entry.type === "tool" && entry.toolCallId) {
        if (entry.status === "running") {
          activeTools.set(entry.toolCallId, entries.length);
          entries.push(entry);
          continue;
        }
        const startIndex = activeTools.get(entry.toolCallId);
        if (startIndex !== undefined) {
          const started = entries[startIndex]!;
          entries[startIndex] = { ...started, ...entry, id: started.id, text: entry.text ?? started.text };
          activeTools.delete(entry.toolCallId);
          continue;
        }
      }
      entries.push(entry);
    } catch {
      // Ignore a partial final JSONL record while the child is still writing.
    }
  }
  return entries.slice(-MAX_TRANSCRIPT_ENTRIES);
}

function progressTranscript(runId: string, step: ArtifactStep, updatedAt: string): SubagentTranscriptEntry[] {
  const entries: SubagentTranscriptEntry[] = [];
  const seen = new Set<string>();
  const tools = Array.isArray(step.recentTools) ? step.recentTools : [];
  for (const value of tools) {
    const tool = recordOf(value);
    const name = stringOf(tool?.tool, 160);
    if (!name) continue;
    const text = stringOf(tool?.args, 8_192);
    const id = `${runId}-recent-tool-${digest(`${name}:${text ?? ""}:${numberOf(tool?.startMs) ?? ""}:${numberOf(tool?.endMs) ?? ""}`)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      timestamp: updatedAt,
      type: "tool",
      toolName: name,
      ...(text ? { text } : {}),
      status: "completed",
    });
  }
  const output = Array.isArray(step.recentOutput) ? step.recentOutput : [];
  for (const value of output) {
    const text = stringOf(value, 8_192);
    if (!text) continue;
    const id = `${runId}-recent-output-${digest(text)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, timestamp: updatedAt, type: "status", text });
  }
  return entries.slice(-40);
}

function usage(metadata: ChildMetadata | undefined, step: ArtifactStep): SubagentRun["usage"] {
  const source = recordOf(metadata?.usage) ?? recordOf(step.tokens);
  if (!source) return undefined;
  const input = Math.max(0, numberOf(source.input) ?? 0);
  const output = Math.max(0, numberOf(source.output) ?? 0);
  const total = Math.max(input + output, numberOf(source.total) ?? 0);
  const rawCost = numberOf(source.cost);
  const cost = rawCost !== undefined && rawCost >= 0 ? rawCost : undefined;
  const rawTurns = numberOf(source.turns);
  const turns = rawTurns !== undefined && Number.isSafeInteger(rawTurns) && rawTurns >= 0 ? rawTurns : undefined;
  return { input, output, total, ...(cost === undefined ? {} : { cost }), ...(turns === undefined ? {} : { turns }) };
}

function currentActivity(step: ArtifactStep, status: SubagentRunStatus): string | undefined {
  const tool = stringOf(step.currentTool, 160);
  const path = stringOf(step.currentPath, 512);
  if (tool && path) return `${tool} · ${path}`;
  if (tool) return tool;
  const recent = Array.isArray(step.recentOutput) ? step.recentOutput.map((item) => stringOf(item, 512)).filter(Boolean).at(-1) : undefined;
  if (recent) return recent;
  return status === "queued" ? "Waiting to start" : status === "running" ? "Working" : undefined;
}

function runMode(value: unknown): SubagentRunMode | undefined {
  return value === "single" || value === "parallel" || value === "chain" || value === "workflow" ? value : undefined;
}

function unresolvedReceipt(receipt: SubagentCommandReceipt): boolean {
  return receipt.state === "requested" || receipt.state === "scheduled" || receipt.state === "pending";
}

function steeringReceipt(
  receipt: SubagentCommandReceipt,
  status: ArtifactStatus,
  index: number,
  updatedAt: string,
): SubagentCommandReceipt {
  if (receipt.kind !== "steer" || !receipt.providerRequestId || !unresolvedReceipt(receipt)) return receipt;
  const steering = recordOf(status.steering);
  const recent = Array.isArray(steering?.recent) ? steering.recent : [];
  const request = recent.map(recordOf).find((item) => item?.id === receipt.providerRequestId);
  const targets = Array.isArray(request?.targets) ? request.targets : [];
  const target = targets.map(recordOf).find((item) => item?.index === index);
  const providerState = stringOf(target?.state, 64);
  if (!providerState) return receipt;
  const state = providerState === "delivered" ? "delivered"
    : providerState === "recovered" ? "recovered"
    : providerState === "scheduled" ? "scheduled"
    : providerState === "failed" || providerState === "late" ? "failed"
    : "pending";
  const error = state === "failed" ? stringOf(target?.reason, 8_192) ?? "Steering was not delivered" : undefined;
  return {
    ...receipt,
    state,
    updatedAt,
    ...(error ? { error } : {}),
  };
}

function lifecycleReceipts(
  receipts: SubagentCommandReceipt[],
  status: ArtifactStatus,
  runStatus: SubagentRunStatus,
  index: number,
  updatedAt: string,
  observedAt: string,
): SubagentCommandReceipt[] {
  const rootStatus = mappedStatus(status.state);
  const rootTerminal = !isActive(rootStatus);
  return receipts.map((original) => {
    const receipt = steeringReceipt(original, status, index, updatedAt);
    if (!unresolvedReceipt(receipt)) return receipt;
    if (receipt.kind === "stop") {
      if (rootStatus === "cancelled" || status.stopped === true) return { ...receipt, state: "delivered", updatedAt };
      if (rootTerminal) return { ...receipt, state: "failed", updatedAt, error: "The workflow finished before stop was confirmed" };
    }
    if (receipt.kind === "interrupt") {
      if (rootStatus === "paused" || runStatus === "paused") return { ...receipt, state: "delivered", updatedAt };
      if (rootTerminal) return { ...receipt, state: "failed", updatedAt, error: "The run finished before pause was confirmed" };
    }
    if (receipt.kind === "steer" && rootTerminal) {
      return { ...receipt, state: "failed", updatedAt, error: "The run finished before steering was confirmed" };
    }
    const requestedAt = Date.parse(receipt.requestedAt);
    if (receipt.state === "requested" && !receipt.providerRequestId && Number.isFinite(requestedAt) && Date.parse(observedAt) - requestedAt >= ABANDONED_RECEIPT_MS) {
      return { ...receipt, state: "failed", updatedAt: observedAt, error: "Delivery was interrupted before the provider acknowledged the command" };
    }
    return receipt;
  });
}

async function runsFromStatus(
  sessionId: string,
  workflowId: string,
  status: ArtifactStatus,
  configuredSessionDir: string,
  previous: SubagentRun[],
  now: number,
): Promise<SubagentRun[]> {
  const steps = Array.isArray(status.steps) ? status.steps.map((step) => recordOf(step) as ArtifactStep | undefined).filter(Boolean) as ArtifactStep[] : [];
  const fallbackSteps: ArtifactStep[] = steps.length ? steps : [{ agent: status.mode ?? "subagent", status: status.state }];
  const root = metadataRoot(status, configuredSessionDir);
  const rootStarted = numberOf(status.startedAt) ?? now;
  const rootUpdated = numberOf(status.lastUpdate) ?? numberOf(status.endedAt) ?? now;
  const rootEnded = numberOf(status.endedAt);
  const rootStatus = mappedStatus(status.state);
  const mode = runMode(status.mode);
  const runs: SubagentRun[] = [];

  for (const [index, step] of fallbackSteps.entries()) {
    const key = stringOf(step.workflowKey ?? step.label ?? step.agent, 160) ?? `child-${index + 1}`;
    const stepValue = valueForStep(status, key, index);
    const resolvedProviderRunId = providerRunId(status, key, index, stepValue);
    const child = await childMetadata(root, resolvedProviderRunId);
    const metadata = child.metadata;
    let runStatus = mappedStatus(step.status ?? status.state);
    if (rootStatus === "cancelled" && runStatus !== "completed") runStatus = "cancelled";
    else if (rootStatus === "paused" && runStatus !== "completed") runStatus = "paused";
    else if (rootStatus === "rejected" && runStatus !== "completed") runStatus = "rejected";
    const started = numberOf(step.startedAt) ?? rootStarted;
    const ended = numberOf(step.endedAt) ?? (!isActive(runStatus) ? rootEnded : undefined);
    const updatedAt = timestamp(numberOf(step.endedAt) ?? rootUpdated, now);
    const runId = `${workflowId}:${index}`;
    const previousRun = previous.find((run) => run.id === runId);
    const artifactTranscript = await readTranscript(root, metadata, step.transcriptPath);
    const liveTranscript = progressTranscript(runId, step, updatedAt);
    const transcript = artifactTranscript.length ? artifactTranscript : liveTranscript;
    const response = child.output ?? responseFromValue(stepValue) ?? [...transcript].reverse().find((entry) => entry.type === "message" && entry.role === "assistant")?.text;
    const agent = stringOf(metadata?.agent ?? step.agent, 160) ?? key;
    const label = stringOf(step.label, 160);
    const role = label && label !== agent && label !== key ? label : undefined;
    const task = stringOf(metadata?.task ?? step.description, 16_384);
    const model = stringOf(metadata?.model ?? step.model, 256);
    const thinking = stringOf(metadata?.thinking ?? step.thinking, 64);
    const error = stringOf(metadata?.error ?? step.error ?? status.error, 8_192);
    const persistedChildSession = stringOf(step.sessionFile, 8_192) ?? sessionFileFromValue(stepValue);
    const resumable = Boolean(persistedChildSession && safeRealPath(persistedChildSession, configuredSessionDir));
    const externalRunner = recordOf(step.runner)?.type === "external-cli";
    const workflowChild = mode === "workflow";
    const runUsage = usage(metadata, step);

    runs.push({
      id: runId,
      provider: "pi-subagents",
      workflowId,
      ...(resolvedProviderRunId ? { providerRunId: resolvedProviderRunId } : {}),
      ...(mode ? { mode } : {}),
      index,
      key,
      agent,
      ...(role ? { role } : {}),
      ...(task ? { task } : {}),
      status: runStatus,
      startedAt: timestamp(started, now),
      updatedAt,
      ...(ended === undefined ? {} : { endedAt: timestamp(ended, now) }),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(runUsage ? { usage: runUsage } : {}),
      ...(currentActivity(step, runStatus) ? { currentActivity: currentActivity(step, runStatus) } : {}),
      ...(response ? { response } : {}),
      ...(error ? { error } : {}),
      transcript,
      receipts: lifecycleReceipts(previousRun?.receipts ?? [], status, runStatus, index, updatedAt, timestamp(now, now)),
      capabilities: {
        steer: runStatus === "running" && !workflowChild && !externalRunner,
        interrupt: runStatus === "running" && !workflowChild && !externalRunner,
        stop: runStatus === "running" || runStatus === "queued",
        resume: resumable,
      },
    });
  }
  return runs;
}

function mergeReceipts(
  projected: SubagentCommandReceipt[],
  latest: SubagentCommandReceipt[],
): SubagentCommandReceipt[] {
  const merged = new Map(projected.map((receipt) => [receipt.id, receipt]));
  for (const receipt of latest) {
    const existing = merged.get(receipt.id);
    if (!existing) {
      merged.set(receipt.id, receipt);
      continue;
    }
    const existingPending = unresolvedReceipt(existing);
    const incomingPending = unresolvedReceipt(receipt);
    if (existingPending !== incomingPending) {
      merged.set(receipt.id, existingPending ? receipt : existing);
      continue;
    }
    if (Date.parse(receipt.updatedAt) > Date.parse(existing.updatedAt)) merged.set(receipt.id, receipt);
  }
  return [...merged.values()];
}

export class PiSubagentArtifactTracker {
  private readonly workflows = new Map<string, TrackedWorkflow>();
  private readonly resumePreparations = new Set<string>();
  private timer?: NodeJS.Timeout;
  private syncing = false;
  private readonly now: () => number;

  constructor(private readonly options: PiSubagentArtifactTrackerOptions) {
    this.now = options.now ?? Date.now;
  }

  restore(
    entriesBySession: Record<string, ToolEntry[]>,
    runsBySession: Record<string, SubagentRun[]> = {},
  ): void {
    for (const [sessionId, entries] of Object.entries(entriesBySession)) {
      for (const entry of entries) this.track(sessionId, entry);
    }
    for (const [sessionId, runs] of Object.entries(runsBySession)) {
      for (const run of runs) this.trackWorkflow(sessionId, run.workflowId, join(asyncRoot(), run.workflowId));
    }
  }

  track(sessionId: string, entry: ToolEntry): void {
    const tracked = trackedWorkflowFromTool(entry);
    if (tracked) this.trackWorkflow(sessionId, tracked.workflowId, tracked.asyncDir);
  }

  trackWorkflow(sessionId: string, workflowId: string, asyncDir: string): boolean {
    const tracked = trackedWorkflowDescriptor(workflowId, asyncDir);
    if (!tracked) return false;
    const key = `${sessionId}:${tracked.workflowId}`;
    const existing = this.workflows.get(key);
    this.workflows.set(key, {
      sessionId,
      workflowId: tracked.workflowId,
      asyncDir: tracked.asyncDir,
      terminal: existing?.terminal ?? false,
      missingSince: existing?.missingSince,
    });
    void this.sync();
    return true;
  }

  async prepareResume(sessionId: string, run: SubagentRun): Promise<boolean> {
    const workflowKey = `${sessionId}:${run.workflowId}`;
    const workflow = this.workflows.get(workflowKey);
    if (!workflow || run.index < 0 || this.resumePreparations.has(workflowKey)) return false;
    this.resumePreparations.add(workflowKey);
    let temporary: string | undefined;
    try {
      const statusPath = safeRealPath(join(workflow.asyncDir, "status.json"), workflow.asyncDir);
      const originalText = statusPath ? await boundedTextFile(statusPath, MAX_STATUS_BYTES) : undefined;
      if (!statusPath || !originalText) return false;
      let status: ArtifactStatus;
      try {
        status = JSON.parse(originalText) as ArtifactStatus;
      } catch {
        return false;
      }
      if (status.runId !== run.workflowId) return false;
      const rootStatus = mappedStatus(status.state);
      if (rootStatus === "queued" || rootStatus === "running") return false;
      const steps = Array.isArray(status.steps) ? status.steps : [];
      const step = recordOf(steps[run.index]);
      if (!step) return false;
      const key = stringOf(step.workflowKey ?? step.label ?? step.agent, 160) ?? run.key;
      const candidate = stringOf(step.sessionFile, 8_192) ?? sessionFileFromValue(valueForStep(status, key, run.index));
      if (!candidate) return false;
      const trustedSessionFile = safeRealPath(candidate, this.options.sessionDir);
      if (!trustedSessionFile) return false;
      const resumeAgent = run.agent && run.agent !== "workflow" ? run.agent : undefined;
      if (step.sessionFile === trustedSessionFile && (!resumeAgent || step.agent === resumeAgent)) return true;
      step.sessionFile = trustedSessionFile;
      if (resumeAgent) step.agent = resumeAgent;
      temporary = join(workflow.asyncDir, `.ocode-status-${process.pid}-${Date.now()}.json`);
      await writeFile(temporary, JSON.stringify(status, null, 2), { encoding: "utf8", mode: 0o600 });
      if (await boundedTextFile(statusPath, MAX_STATUS_BYTES) !== originalText) return false;
      await rename(temporary, statusPath);
      temporary = undefined;
      return true;
    } catch {
      return false;
    } finally {
      if (temporary) {
        try { await rm(temporary, { force: true }); } catch {}
      }
      this.resumePreparations.delete(workflowKey);
    }
  }

  removeSession(sessionId: string): void {
    for (const [key, workflow] of this.workflows) {
      if (workflow.sessionId === sessionId) this.workflows.delete(key);
    }
  }

  refresh(sessionId?: string): Promise<void> {
    for (const workflow of this.workflows.values()) {
      if (sessionId === undefined || workflow.sessionId === sessionId) workflow.terminal = false;
    }
    return this.sync();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.workflows.clear();
  }

  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let active = false;
    try {
      for (const workflow of this.workflows.values()) {
        if (workflow.terminal) continue;
        const statusPath = safeRealPath(join(workflow.asyncDir, "status.json"), workflow.asyncDir);
        const status = statusPath ? await boundedJson(statusPath, MAX_STATUS_BYTES) as ArtifactStatus | undefined : undefined;
        if (!status || status.runId !== workflow.workflowId) {
          workflow.missingSince ??= this.now();
          if (this.now() - workflow.missingSince < MISSING_STATUS_RETRY_MS) active = true;
          continue;
        }
        workflow.missingSince = undefined;
        const previous = this.options.currentRuns(workflow.sessionId).filter((run) => run.workflowId === workflow.workflowId);
        const runs = await runsFromStatus(
          workflow.sessionId,
          workflow.workflowId,
          status,
          this.options.sessionDir,
          previous,
          this.now(),
        );
        const latest = this.options.currentRuns(workflow.sessionId).filter((run) => run.workflowId === workflow.workflowId);
        const mergedRuns = runs.map((run) => ({
          ...run,
          receipts: mergeReceipts(run.receipts, latest.find((candidate) => candidate.id === run.id)?.receipts ?? []),
        }));
        const changed = mergedRuns.some((run) => JSON.stringify(latest.find((candidate) => candidate.id === run.id)) !== JSON.stringify(run));
        if (changed || latest.length !== mergedRuns.length) this.options.publish(workflow.sessionId, mergedRuns);
        workflow.terminal = mergedRuns.length > 0 && mergedRuns.every(
          (run) => !isActive(run.status) && !run.receipts.some(unresolvedReceipt),
        );
        if (!workflow.terminal) active = true;
      }
    } finally {
      this.syncing = false;
      if (active) {
        this.timer = setTimeout(() => void this.sync(), POLL_INTERVAL_MS);
        this.timer.unref();
      }
    }
  }
}
