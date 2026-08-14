import type { ToolEntry } from "@anvil/protocol";
import { describe, expect, it } from "vitest";
import displayRules from "../config/tool-display-rules.json";
import { presentTool } from "./toolPresentation";

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "bash",
    summary: "Run shell command",
    status: "completed",
    arguments: { command: "echo hello" },
    output: [],
    createdAt: "2026-03-23T00:00:00.000Z",
    raw: { type: "tool_execution_end" },
    ...overrides,
  };
}

describe("tool display rule catalog", () => {
  it("keeps the catalog versioned with unique IDs and valid match patterns", () => {
    expect(displayRules.version).toBe(1);
    const ids = [
      ...displayRules.toolAliases.map((rule) => rule.id),
      ...displayRules.shellRules.map((rule) => rule.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of displayRules.shellRules) {
      const match = rule.match as { all?: string[]; any?: string[]; none?: string[] };
      const patterns = [...(match.all ?? []), ...(match.any ?? []), ...(match.none ?? [])];
      for (const pattern of patterns) expect(() => new RegExp(pattern, "i")).not.toThrow();
    }
  });

  it("summarizes a combined typecheck and build without exposing the command", () => {
    const command = "pnpm exec tsc --noEmit && set -a; . ./.env.production.local; set +a; pnpm build >/tmp/build.log 2>&1";
    const presentation = presentTool(tool({ arguments: { command } }));

    expect(presentation).toMatchObject({
      category: "shell",
      title: "Checked types and built the app",
      detail: "TypeScript · Production build",
    });
    expect(presentation.title).not.toContain(".env.production.local");
  });

  it("counts explicitly staged files", () => {
    const presentation = presentTool(tool({
      arguments: { command: "git add prisma/backfill.sql src/route.ts 'src/account form.tsx'" },
    }));

    expect(presentation).toMatchObject({
      category: "git",
      title: "Staged 3 files",
      detail: "Git · 3 files",
    });
  });

  it("uses deployment-aware wording through command wrappers", () => {
    const presentation = presentTool(tool({
      status: "running",
      arguments: { command: "sleep 45; /home/oli/.local/lib/npm/bin/vercel inspect https://example.invalid" },
    }));

    expect(presentation).toMatchObject({
      title: "Waiting for Vercel deployment",
      detail: "Vercel · Deployment",
      status: "Running",
    });
  });

  it("summarizes multi-provider deployment checks as one operation", () => {
    const presentation = presentTool(tool({
      arguments: { command: "vercel ls pulseflow; railway deployment list --service api" },
    }));

    expect(presentation).toMatchObject({
      title: "Checked deployments",
      detail: "Vercel · Railway",
    });
  });

  it("prefers the final Git outcome for chained commands", () => {
    const presentation = presentTool(tool({
      arguments: { command: "git add src/app.ts && git commit -m 'Fix app' && git push" },
    }));

    expect(presentation).toMatchObject({
      category: "git",
      title: "Pushed changes",
      detail: "Git · Remote",
    });
  });

  it("masks unknown commands behind a categorical fallback", () => {
    const command = "SECRET_TOKEN=hidden ./scripts/customer-release-secret --token super-secret";
    const presentation = presentTool(tool({ arguments: { command } }));

    expect(presentation).toMatchObject({ title: "Ran shell command", detail: "Shell" });
    expect(`${presentation.title} ${presentation.detail}`).not.toMatch(/customer|release|secret/i);
  });

  it.each([
    "echo 'pnpm test'",
    "printf 'git push'",
    "echo ignored # git commit -m secret",
    "bash -c 'pnpm build'",
  ])("does not treat quoted or indirect text as an executed operation: %s", (command) => {
    expect(presentTool(tool({ arguments: { command } }))).toMatchObject({
      title: "Ran shell command",
      detail: "Shell",
    });
  });

  it("uses a neutral summary when multiple unrelated operations match", () => {
    const presentation = presentTool(tool({
      status: "failed",
      arguments: { command: "pnpm test && pnpm build" },
    }));

    expect(presentation).toMatchObject({
      title: "Shell operations failed",
      detail: "Multiple operations",
    });
  });

  it.each(["pnpm run typecheck", "yarn run typecheck", "npm exec tsc", "  git status --short"])(
    "recognizes common command form: %s",
    (command) => {
      expect(presentTool(tool({ arguments: { command } })).title).not.toBe("Ran shell command");
    },
  );

  it("aliases subagent actions without exposing role, task, or run identifiers", () => {
    const sensitiveValues = ["customer-builder", "Implement the customer deployment fix", "run-secret-123"];
    const presentation = presentTool(tool({
      name: "ocode_subagent",
      arguments: { action: "spawn", role: sensitiveValues[0], task: sensitiveValues[1], runId: sensitiveValues[2] },
    }));
    const collapsedCopy = `${presentation.title} ${presentation.detail}`;

    expect(presentation).toMatchObject({
      category: "agent",
      title: "Started subagent",
      detail: "Delegated task",
    });
    for (const value of sensitiveValues) expect(collapsedCopy).not.toContain(value);
  });
});
