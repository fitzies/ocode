import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSubagentPrompt } from "./roleCatalog.ts";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
let directory: string | undefined;

afterEach(() => {
  if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDir;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("subagent role catalog", () => {
  it.each(["builder", "scout", "researcher", "reviewer"] as const)(
    "provides the %s role without requiring Pi configuration edits",
    (role) => {
      directory = mkdtempSync(join(tmpdir(), "ocode-empty-pi-agent-"));
      process.env.PI_CODING_AGENT_DIR = directory;

      const prompt = buildSubagentPrompt(role, "Complete this task");

      expect(prompt).toContain(`You are a ${role} agent.`);
      expect(prompt).toContain("Complete this task");
      expect(prompt).toContain("fresh, isolated session");
    },
  );
});
