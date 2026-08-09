import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { UsageService } from "./usageService.ts";

function assistant(id: string, timestamp: number, model = "gpt-test") {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      provider: "test-provider",
      model,
      timestamp,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 2,
        reasoning: 3,
        totalTokens: 37,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      },
    },
  });
}

describe("UsageService", () => {
  it("aggregates Pi assistant usage and deduplicates copied fork entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocode-usage-"));
    const project = join(root, "--repo--");
    const subagent = join(project, "run", "run-0");
    await mkdir(subagent, { recursive: true });
    const now = Date.parse("2026-08-09T12:00:00.000Z");
    const header = JSON.stringify({ type: "session", version: 3, id: "session", timestamp: new Date(now).toISOString(), cwd: "/repo" });
    await writeFile(join(project, "2026-08-09T12-00-00-000Z_abc.jsonl"), `${header}\n${assistant("shared", now)}\n`);
    await writeFile(join(project, "2026-08-09T12-01-00-000Z_def.jsonl"), `${header}\n${assistant("shared", now)}\n`);
    await writeFile(join(subagent, "session.jsonl"), `${header}\n${assistant("child", now, "gpt-child")}\n`);

    const summary = await new UsageService({ sessionRoot: root }).summary(30, "UTC", now);

    expect(summary).toMatchObject({ responses: 2, transcripts: 3, duplicates: 1 });
    expect(summary.tokens).toEqual({ input: 20, output: 10, cacheRead: 40, cacheWrite: 4, reasoning: 6, total: 74 });
    expect(summary.cost.total).toBeCloseTo(0.74);
    expect(summary.models.map((model) => model.model)).toEqual(["gpt-test", "gpt-child"]);
  });

  it("ignores records outside the requested calendar window", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocode-usage-window-"));
    const project = join(root, "--repo--");
    await mkdir(project, { recursive: true });
    const now = Date.parse("2026-08-09T12:00:00.000Z");
    await writeFile(
      join(project, "2026-01-01T00-00-00-000Z_abc.jsonl"),
      `${assistant("old", Date.parse("2026-01-01T00:00:00.000Z"))}\n${assistant("current", now)}\n`,
    );

    const summary = await new UsageService({ sessionRoot: root }).summary(7, "UTC", now);
    expect(summary.responses).toBe(1);
    expect(summary.daily).toEqual([{ day: "2026-08-09", tokens: 37, cost: 0.37 }]);
  });
});
