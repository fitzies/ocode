import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SUBAGENT_SPAWN_PROMPT_MAX_BYTES, type SubagentRole } from "@anvil/protocol";

const ROLE_INSTRUCTION_MAX_BYTES = 16 * 1024;
const FALLBACKS: Record<SubagentRole, string> = {
  builder: "You are a builder agent. Implement the requested change, keep edits focused, run relevant checks, and report files changed and validation.",
  scout: "You are a scout agent. Read the codebase without editing it and return concise architecture, key files, and relevant code paths.",
  researcher: "You are a researcher agent. Investigate authoritative documentation and return concise findings with source references. Do not modify the project.",
  reviewer: "You are a reviewer agent. Review the relevant implementation without editing it. Prioritize correctness, regressions, races, security, and missing tests.",
};

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  while (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function configuredRole(role: SubagentRole): string | undefined {
  // Only read the fixed role catalog from Pi's normal user configuration. Role
  // names are a closed enum, so no request-controlled path is ever resolved.
  const root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const source = readFileSync(join(root, "extensions", "subagents", "agents", `${role}.md`), "utf8");
    if (Buffer.byteLength(source) > 64 * 1024) return undefined;
    const frontmatterEnd = source.startsWith("---\n") ? source.indexOf("\n---\n", 4) : -1;
    const body = frontmatterEnd >= 0 ? source.slice(frontmatterEnd + 5) : source;
    const instruction = body.trim();
    return instruction ? boundedUtf8(instruction, ROLE_INSTRUCTION_MAX_BYTES) : undefined;
  } catch {
    return undefined;
  }
}

export function buildSubagentPrompt(role: SubagentRole, task: string): string {
  const instruction = configuredRole(role) ?? FALLBACKS[role];
  const prefix = `${instruction}\n\nYou have a fresh, isolated session. The task below is the complete context; do not assume access to the parent transcript.\n\nTask:\n`;
  return boundedUtf8(`${prefix}${task.trim()}`, SUBAGENT_SPAWN_PROMPT_MAX_BYTES);
}
