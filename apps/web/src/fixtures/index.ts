import type { RecordedRpcItem } from "@anvil/pi-rpc";
import { isSubagentRun } from "@anvil/protocol";
import type {
  CapabilityCatalog,
  ProjectSummary,
  SessionSummary,
  SubagentRun,
} from "@anvil/protocol";
import asyncSubagents from "./async-subagents.json";
import dialogQueue from "./dialog-queue.json";
import failureUnknown from "./failure-unknown.json";
import ordinaryRun from "./ordinary-run.json";
import parallelTools from "./parallel-tools.json";
import resourceOpen from "./resource-open.json";

export interface FixtureDefinition {
  id: string;
  name: string;
  description: string;
  baseTimestamp: string;
  project: ProjectSummary;
  session: SessionSummary;
  records: RecordedRpcItem[];
  subagentRuns?: SubagentRun[];
}

export const fixtureCatalog: CapabilityCatalog = {
  modelsReady: true,
  models: [
    {
      id: "openai/gpt-5.4",
      provider: "openai",
      name: "Sol",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    },
    {
      id: "openai/gpt-5.3-codex",
      provider: "openai",
      name: "Luna",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 64_000,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      id: "anthropic/claude-opus-4.6",
      provider: "anthropic",
      name: "Terra",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 32_000,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
    },
  ],
  commands: [
    {
      name: "session-name",
      description: "Set or clear the session display name",
      source: "extension",
      path: "~/.pi/agent/extensions/session-name.ts",
    },
    {
      name: "handoff",
      description: "Create a concise handoff for another Pi session",
      source: "prompt",
      location: "user",
      path: "~/.pi/agent/prompts/handoff.md",
    },
    {
      name: "review",
      description: "Review the current implementation for regressions",
      source: "prompt",
      location: "project",
      path: ".pi/prompts/review.md",
    },
  ],
  skills: [
    {
      name: "frontend-design",
      command: "skill:frontend-design",
      description: "Create and review production-grade frontend interfaces",
      location: "user",
      path: "~/.pi/agent/skills/frontend-design/SKILL.md",
    },
    {
      name: "github-investigation",
      command: "skill:github-investigation",
      description: "Investigate GitHub repositories, issues, and pull requests",
      location: "user",
      path: "~/.pi/agent/skills/github-investigation/SKILL.md",
    },
  ],
};

function parseFixture(value: unknown): FixtureDefinition {
  if (!value || typeof value !== "object") throw new Error("Fixture must be an object");
  const fixture = value as Record<string, unknown>;
  const session = fixture.session as Record<string, unknown> | undefined;
  const project = fixture.project as Record<string, unknown> | undefined;
  if (
    typeof fixture.id !== "string" ||
    typeof fixture.name !== "string" ||
    typeof fixture.baseTimestamp !== "string" ||
    !Array.isArray(fixture.records) ||
    typeof session?.id !== "string" ||
    typeof project?.id !== "string"
  ) {
    throw new Error(`Invalid fixture: ${String(fixture.id ?? "unknown")}`);
  }
  if (fixture.subagentRuns !== undefined && (
    !Array.isArray(fixture.subagentRuns) || !fixture.subagentRuns.every(isSubagentRun)
  )) throw new Error(`Invalid subagent projection in fixture: ${fixture.id}`);
  for (const item of fixture.records) {
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.at !== "number" || !candidate.record || typeof candidate.record !== "object") {
      throw new Error(`Invalid RPC record in fixture: ${fixture.id}`);
    }
  }
  return value as FixtureDefinition;
}

export const fixtures = [ordinaryRun, parallelTools, asyncSubagents, dialogQueue, failureUnknown, resourceOpen].map(parseFixture);

export const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
