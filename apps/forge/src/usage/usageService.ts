import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
  UsageCostTotals,
  UsageDaySummary,
  UsageModelSummary,
  UsageSummary,
  UsageTokenTotals,
} from "@anvil/protocol";

interface UsageRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  tokens: UsageTokenTotals;
  cost: UsageCostTotals;
}

interface CachedTranscript {
  size: number;
  mtimeMs: number;
  records: UsageRecord[];
}

const CANONICAL_SESSION_FILE = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f-]+\.jsonl$/i;
const EMPTY_TOKENS = (): UsageTokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
const EMPTY_COST = (): UsageCostTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function defaultSessionRoot(environment: NodeJS.ProcessEnv): string {
  if (environment.PI_CODING_AGENT_SESSION_DIR) return environment.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = environment.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

function dayFormatter(timeZone: string): { timeZone: string; format: (timestamp: number) => string } {
  let resolved = timeZone;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    resolved = "UTC";
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: resolved, year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return { timeZone: resolved, format: (timestamp) => formatter.format(new Date(timestamp)) };
}

function subtractDays(day: string, amount: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - amount);
  return instant.toISOString().slice(0, 10);
}

async function transcriptPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "subagent-artifacts" || entry.name.startsWith(".pi-agent-browser")) continue;
        await walk(join(directory, entry.name));
        continue;
      }
      const name = entry.name;
      if (name === "session.jsonl" || CANONICAL_SESSION_FILE.test(name)) paths.push(join(directory, name));
    }
  };
  await walk(root);
  return paths;
}

async function parseTranscript(path: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message" || typeof entry.id !== "string") continue;
      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const assistant = message as Record<string, unknown>;
      if (assistant.role !== "assistant" || typeof assistant.provider !== "string" || typeof assistant.model !== "string") continue;
      const usageValue = assistant.usage;
      if (!usageValue || typeof usageValue !== "object" || Array.isArray(usageValue)) continue;
      const usage = usageValue as Record<string, unknown>;
      const costValue = usage.cost;
      const rawCost = costValue && typeof costValue === "object" && !Array.isArray(costValue)
        ? costValue as Record<string, unknown>
        : {};
      const timestamp = finite(assistant.timestamp) || Date.parse(String(entry.timestamp ?? ""));
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      records.push({
        id: entry.id,
        timestamp,
        provider: assistant.provider,
        model: assistant.model,
        tokens: {
          input: finite(usage.input),
          output: finite(usage.output),
          cacheRead: finite(usage.cacheRead),
          cacheWrite: finite(usage.cacheWrite),
          reasoning: finite(usage.reasoning),
          total: finite(usage.totalTokens),
        },
        cost: {
          input: finite(rawCost.input),
          output: finite(rawCost.output),
          cacheRead: finite(rawCost.cacheRead),
          cacheWrite: finite(rawCost.cacheWrite),
          total: finite(rawCost.total),
        },
      });
    }
  } catch {
    return [];
  }
  return records;
}

function addTokenTotals(target: UsageTokenTotals, value: UsageTokenTotals): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.reasoning += value.reasoning;
  target.total += value.total;
}

function addCostTotals(target: UsageCostTotals, value: UsageCostTotals): void {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.total += value.total;
}

export class UsageService {
  private readonly cache = new Map<string, CachedTranscript>();
  private readonly roots: string[];

  constructor(options: { sessionRoot?: string; additionalSessionRoots?: string[]; environment?: NodeJS.ProcessEnv } = {}) {
    const environment = options.environment ?? process.env;
    const primaryRoot = options.sessionRoot ?? defaultSessionRoot(environment);
    this.roots = [...new Set([primaryRoot, ...(options.additionalSessionRoots ?? [])].map((root) => resolve(root)))];
  }

  async summary(days: number, requestedTimeZone: string, now = Date.now()): Promise<UsageSummary> {
    const formatter = dayFormatter(requestedTimeZone);
    const untilDay = formatter.format(now);
    const sinceDay = subtractDays(untilDay, days - 1);
    const paths = [...new Set((await Promise.all(this.roots.map(transcriptPaths))).flat())];
    const seen = new Set<string>();
    const tokens = EMPTY_TOKENS();
    const cost = EMPTY_COST();
    const models = new Map<string, UsageModelSummary>();
    const daily = new Map<string, UsageDaySummary>();
    let responses = 0;
    let duplicates = 0;

    for (const path of paths) {
      let metadata;
      try {
        metadata = await stat(path);
      } catch {
        continue;
      }
      const cached = this.cache.get(path);
      const records = cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs
        ? cached.records
        : await parseTranscript(path);
      if (!cached || cached.size !== metadata.size || cached.mtimeMs !== metadata.mtimeMs) {
        this.cache.set(path, { size: metadata.size, mtimeMs: metadata.mtimeMs, records });
      }
      for (const record of records) {
        if (seen.has(record.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(record.id);
        const day = formatter.format(record.timestamp);
        if (day < sinceDay || day > untilDay) continue;
        responses += 1;
        addTokenTotals(tokens, record.tokens);
        addCostTotals(cost, record.cost);
        const modelKey = `${record.provider}\0${record.model}`;
        const model = models.get(modelKey) ?? { provider: record.provider, model: record.model, responses: 0, tokens: 0, cost: 0 };
        model.responses += 1;
        model.tokens += record.tokens.total;
        model.cost += record.cost.total;
        models.set(modelKey, model);
        const daySummary = daily.get(day) ?? { day, tokens: 0, cost: 0 };
        daySummary.tokens += record.tokens.total;
        daySummary.cost += record.cost.total;
        daily.set(day, daySummary);
      }
    }

    return {
      days,
      sinceDay,
      untilDay,
      timeZone: formatter.timeZone,
      responses,
      transcripts: paths.length,
      duplicates,
      tokens,
      cost,
      models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
  }
}
