import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const GENERATION_TIMEOUT_MS = 90_000;

export interface CommitMessageInput {
  cwd: string;
  modelId?: string;
  branch: string;
  summary: string;
  changes: string;
}

export interface CommitMessageGenerator {
  generate(input: CommitMessageInput): Promise<string>;
}

export function normalizeCommitMessage(value: string): string {
  let text = value.trim();
  const fenced = /^```(?:text)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^commit (?:message|subject):\s*/i, "").trim();
  const subject = text.split(/\r?\n/).find((line) => line.trim())?.trim()
    .replace(/^['"`]|['"`]$/g, "")
    .trim();
  if (!subject || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error("Pi did not return a valid commit subject");
  }
  return subject.length <= 72 ? subject : subject.slice(0, 72).trimEnd();
}

export class PiCommitMessageGenerator implements CommitMessageGenerator {
  constructor(private readonly executable: string) {}

  async generate(input: CommitMessageInput): Promise<string> {
    const args = [
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--thinking",
      "off",
      "--system-prompt",
      "You write concise Git commit subjects. Return exactly one imperative subject line, at most 72 characters. Do not use Markdown, quotes, prefixes, explanations, or tools.",
      ...(input.modelId ? ["--model", input.modelId] : []),
      `Generate a commit subject for the following changes on branch ${input.branch}.`,
    ];
    const prompt = `${input.summary}\n\n${input.changes}`;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd: input.cwd,
        env: {
          ...process.env,
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value!);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Commit message generation timed out"));
      }, GENERATION_TIMEOUT_MS);
      timeout.unref();

      child.once("error", (error) => finish(new Error(`Pi could not be started: ${error.message}`)));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("Pi returned too much commit message output"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_OUTPUT_BYTES) return;
        stderrBytes += chunk.length;
        stderr.push(chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - (stderrBytes - chunk.length))));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          finish(new Error(detail || `Pi exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}`));
          return;
        }
        try {
          finish(undefined, normalizeCommitMessage(Buffer.concat(stdout).toString("utf8")));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.once("error", (error) => finish(new Error(`Pi input failed: ${error.message}`)));
      child.stdin.end(prompt);
    });
  }
}
