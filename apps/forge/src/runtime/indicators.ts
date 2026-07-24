import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SessionManager } from "./sessionManager.ts";

const execFileAsync = promisify(execFile);
const CHATGPT_BASE_URL = (process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
const FIVE_HOURS = 5 * 60 * 60;
const ONE_WEEK = 7 * 24 * 60 * 60;

export interface UsageWindow {
  usedPercent: number;
  resetAt?: number;
}

export interface LiveIndicators {
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  git?: { additions: number; deletions: number };
  usage?: { fiveHour?: UsageWindow; weekly?: UsageWindow };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function usageWindow(value: unknown): (UsageWindow & { seconds: number }) | undefined {
  const item = record(value);
  return typeof item?.used_percent === "number" && typeof item.limit_window_seconds === "number"
    ? { usedPercent: item.used_percent, seconds: item.limit_window_seconds, resetAt: typeof item.reset_at === "number" ? item.reset_at : undefined }
    : undefined;
}

export class LiveIndicatorsService {
  private usageCache?: { value?: LiveIndicators["usage"]; expiresAt: number };

  constructor(private readonly sessions: SessionManager) {}

  async get(sessionId: string): Promise<LiveIndicators | undefined> {
    const info = await this.sessions.getIndicatorSource(sessionId);
    if (!info) return undefined;
    const [git, usage] = await Promise.all([this.gitDiff(info.projectPath), this.codexUsage()]);
    return { context: info.context, git, usage };
  }

  private async gitDiff(cwd: string): Promise<LiveIndicators["git"]> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--numstat", "--"], {
        cwd,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      let additions = 0;
      let deletions = 0;
      for (const line of stdout.split("\n")) {
        const [added, deleted] = line.split("\t");
        if (added !== "-") additions += Number(added) || 0;
        if (deleted !== "-") deletions += Number(deleted) || 0;
      }
      return { additions, deletions };
    } catch {
      return undefined;
    }
  }

  private async codexUsage(): Promise<LiveIndicators["usage"]> {
    if (this.usageCache && this.usageCache.expiresAt > Date.now()) return this.usageCache.value;
    let value: LiveIndicators["usage"];
    try {
      const auth = record(JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8")));
      const codex = record(auth?.["openai-codex"]);
      if (typeof codex?.access !== "string") throw new Error("Codex auth unavailable");
      const headers: Record<string, string> = {
        authorization: `Bearer ${codex.access}`,
        accept: "application/json",
        "user-agent": "anvil-forge",
      };
      if (typeof codex.accountId === "string") headers["chatgpt-account-id"] = codex.accountId;
      const response = await fetch(`${CHATGPT_BASE_URL}/wham/usage`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Usage request failed: ${response.status}`);
      const body = record(await response.json());
      const limits = record(body?.rate_limit);
      const windows = [usageWindow(limits?.primary_window), usageWindow(limits?.secondary_window)]
        .filter((window): window is NonNullable<typeof window> => Boolean(window));
      const select = (seconds: number) => windows.find((window) => Math.abs(window.seconds - seconds) <= 120);
      value = { fiveHour: select(FIVE_HOURS), weekly: select(ONE_WEEK) };
    } catch {
      value = undefined;
    }
    this.usageCache = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }
}
