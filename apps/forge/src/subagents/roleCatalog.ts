import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SUBAGENT_SPAWN_PROMPT_MAX_BYTES, type SubagentRole, type ThinkingLevel } from "@anvil/protocol";

import { agentDocument } from "../pi/agentFrontmatter.ts";

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

export function configuredRole(role: SubagentRole): { text?: string; modelId?: string; thinkingLevel?: ThinkingLevel } {
  if (process.platform !== "linux" || !Object.hasOwn(FALLBACKS, role)) return {};
  const root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  let fd: number | undefined;
  try {
    let expected = realpathSync(root);
    fd = openSync(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const part of ["extensions", "subagents", "agents", `${role}.md`]) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
      expected = join(expected, part);
    }
    if (realpathSync(`/proc/self/fd/${fd}`) !== expected) return {};
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) return {};
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > 64 * 1024) return {};
    const { fields, text } = agentDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
    const modelId = fields.model && fields.model.length <= 300 && !/[\s\u0000-\u001f\u007f]/.test(fields.model) ? fields.model : undefined;
    const thinkingLevel = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(fields.thinking ?? "") ? fields.thinking as ThinkingLevel : undefined;
    return { text: text.trim() ? boundedUtf8(text.trim(), ROLE_INSTRUCTION_MAX_BYTES) : undefined, modelId, thinkingLevel };
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function buildSubagentPrompt(role: SubagentRole, task: string): string {
  const instruction = configuredRole(role).text ?? FALLBACKS[role];
  const prefix = `${instruction}\n\nYou have a fresh, isolated session. The task below is the complete context; do not assume access to the parent transcript.\n\nTask:\n`;
  return boundedUtf8(`${prefix}${task.trim()}`, SUBAGENT_SPAWN_PROMPT_MAX_BYTES);
}
