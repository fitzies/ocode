import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  type AskUserQuestionMode,
  type OcodeAskUserQuestionEditorEnvelope,
  OCODE_ASK_USER_QUESTION_EDITOR_SENTINEL,
  OCODE_ASK_USER_QUESTION_KIND,
  OCODE_ASK_USER_QUESTION_SCHEMA_VERSION,
  normalizeProjectResourcePath,
  parseOcodeAskUserQuestionResponse,
} from "@anvil/protocol";
import { Type } from "typebox";

import { secureOpenProjectPath } from "../files/secureProjectPath.ts";

const MAX_INLINE_HTML_BYTES = 192 * 1024;
const MAX_OPEN_FILE_BYTES = 20 * 1024 * 1024;
const TOOL_NAME = "ocode_render_html_file";
const OPEN_FILE_TOOL_NAME = "ocode_open_file";
const OPEN_FILE_TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".htm", ".html", ".ini",
  ".java", ".js", ".json", ".jsx", ".log", ".lua", ".md", ".mdx", ".mjs", ".py", ".rb", ".rs", ".sh",
  ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const OPEN_FILE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface ToolContext {
  cwd: string;
  isProjectTrusted(): boolean;
  hasUI?: boolean;
  ui?: {
    editor(title: string, prefill?: string): Promise<unknown>;
  };
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: ReturnType<typeof Type.Object>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>;
}

interface ExtensionApi {
  registerTool(definition: ToolDefinition): void;
  on(event: "session_start", handler: () => void): void;
}

interface AskOption {
  label: string;
  value: string;
  description?: string;
}

type AskAnswer =
  | { type: "text"; label: string; value: string }
  | { type: "option"; label: string; value: string; index: number }
  | { type: "other"; label: string; value: string };

const AskOptionSchema = Type.Object({
  label: Type.String({
    description:
      'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
  }),
  value: Type.Optional(Type.String({
    description: "Optional machine-readable value returned for the option. Defaults to the label.",
  })),
  description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
  question: Type.String({
    description: "The single question to ask the user. Ask exactly one question per tool call.",
  }),
  details: Type.Optional(Type.String({
    description: "Optional extra context or instructions shown under the question.",
  })),
  options: Type.Optional(Type.Array(AskOptionSchema, {
    description:
      "Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
  })),
  multiSelect: Type.Optional(Type.Boolean({
    description: "Set to true to allow multiple answers to be selected for a question.",
  })),
});

function normalizeAskOptions(value: unknown): AskOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AskOption[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const option = item as Record<string, unknown>;
    if (typeof option.label !== "string") return [];
    const label = option.label.trim();
    if (!label) return [];
    return [{
      label,
      value: typeof option.value === "string" && option.value.trim() ? option.value.trim() : label,
      ...(typeof option.description === "string" && option.description.trim()
        ? { description: option.description.trim() }
        : {}),
    }];
  });
}

function askResultDetails(
  status: "answered" | "cancelled" | "unavailable",
  question: string,
  mode: AskUserQuestionMode,
  answers: AskAnswer[],
  context?: string,
  message?: string,
): Record<string, unknown> {
  return { status, question, context, mode, answers, message };
}

function cancelledAskResult(question: string, mode: AskUserQuestionMode, context?: string, message = "User cancelled the question") {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { ...askResultDetails("cancelled", question, mode, [], context, message), cancelled: true },
  };
}

function unavailableAskResult(question: string, mode: AskUserQuestionMode, context?: string) {
  const message = "ask_user_question requires interactive mode UI";
  return {
    content: [{ type: "text" as const, text: message }],
    details: askResultDetails("unavailable", question, mode, [], context, message),
  };
}

function formatAskAnswer(answer: AskAnswer): string {
  if (answer.type === "option") return `${answer.index}. ${answer.label}`;
  if (answer.type === "other") return `Other: ${answer.label}`;
  return answer.label;
}

function answeredAskResult(question: string, mode: AskUserQuestionMode, answers: AskAnswer[], context?: string) {
  const text = mode === "text"
    ? answers[0]!.label.trim() ? `User answered: ${answers[0]!.label}` : "User submitted an empty response"
    : mode === "single-select"
      ? `User selected: ${formatAskAnswer(answers[0]!)}`
      : `User selected:\n${answers.map((answer) => `- ${formatAskAnswer(answer)}`).join("\n")}`;
  return {
    content: [{ type: "text" as const, text }],
    details: askResultDetails("answered", question, mode, answers, context),
  };
}

function askUserQuestionTool(): ToolDefinition {
  return {
    name: "ask_user_question",
    label: "ask_user_question",
    description:
      "Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
    promptSnippet:
      "Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
      'Users will always be able to select "Other" to provide custom text input when options are provided.',
      "Use multiSelect: true only when you need multiple answers to the same question.",
      'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
    ],
    parameters: AskUserQuestionParams,

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const question = typeof params.question === "string" ? params.question : "";
      const options = normalizeAskOptions(params.options);
      const details = typeof params.details === "string" ? params.details.trim() || undefined : undefined;
      const mode: AskUserQuestionMode = options.length === 0
        ? "text"
        : params.multiSelect === true ? "multi-select" : "single-select";
      if (signal?.aborted) return cancelledAskResult(question, mode, details);
      if (context.hasUI !== true || !context.ui) {
        return unavailableAskResult(question, mode, details);
      }

      const envelope: OcodeAskUserQuestionEditorEnvelope = {
        kind: OCODE_ASK_USER_QUESTION_KIND,
        schemaVersion: OCODE_ASK_USER_QUESTION_SCHEMA_VERSION,
        question,
        ...(details ? { context: details } : {}),
        mode,
        options,
      };
      const rawResponse = await context.ui.editor(
        OCODE_ASK_USER_QUESTION_EDITOR_SENTINEL,
        JSON.stringify(envelope),
      );
      if (signal?.aborted || rawResponse === undefined) return cancelledAskResult(question, mode, details);
      const response = parseOcodeAskUserQuestionResponse(rawResponse, envelope);
      if (!response) return cancelledAskResult(question, mode, details);

      const answers = response.answers.map((answer): AskAnswer => {
        if (answer.type === "text") {
          const value = answer.value.trim();
          return { type: "text", label: value, value };
        }
        if (answer.type === "other") {
          const value = answer.value.trim();
          return { type: "other", label: value, value };
        }
        const option = options[answer.optionIndex]!;
        return {
          type: "option",
          label: option.label,
          value: option.value,
          index: answer.optionIndex + 1,
        };
      }).sort((left, right) => {
        const rank = (answer: AskAnswer) => answer.type === "option" ? answer.index : Number.MAX_SAFE_INTEGER;
        return rank(left) - rank(right);
      });
      return answeredAskResult(question, mode, answers, details);
    },
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export default function anvilInlineArtifact(pi: ExtensionApi): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Render HTML artifact",
    description:
      "Render a small, self-contained HTML file inline in ocode chat. The path must be a regular .html or .htm file inside the trusted workspace and the file must be no larger than 192 KiB.",
    promptSnippet: "Render a small local HTML file inline in ocode chat",
    promptGuidelines: [
      "Use ocode_render_html_file after writing a small self-contained HTML artifact that the user should see inline in chat.",
      "Keep ocode_render_html_file artifacts visually clean: use a transparent page background, responsive layout, and no external network resources.",
      "Use HTML, CSS, and SVG for ocode_render_html_file artifacts; generated JavaScript is blocked by the renderer.",
      "When a visual artifact benefits from being drawn in stages, put a subtle CSS or SVG entrance animation in the completed HTML and respect prefers-reduced-motion.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path to the HTML file to render." }),
      title: Type.Optional(Type.String({ description: "Short title shown above the inline artifact." })),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!context.isProjectTrusted()) throw new Error("Inline HTML artifacts require a trusted workspace");
      if (signal?.aborted) throw new Error("Artifact rendering was cancelled");

      const workspaceRoot = await realpath(context.cwd);
      if (typeof params.path !== "string") throw new Error("Artifact path is required");
      const requestedPath = params.path.replace(/^@/, "");
      const lexicalPath = resolve(workspaceRoot, requestedPath);
      if (!isInside(workspaceRoot, lexicalPath)) {
        throw new Error("Artifact path must stay inside the trusted workspace");
      }

      const handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      let targetPath: string;
      let bytes: Buffer;
      try {
        targetPath = process.platform === "linux"
          ? await realpath(`/proc/self/fd/${handle.fd}`)
          : await realpath(lexicalPath);
        if (!isInside(workspaceRoot, targetPath)) {
          throw new Error("Artifact path must stay inside the trusted workspace");
        }
        if (![".html", ".htm"].includes(extname(targetPath).toLowerCase())) {
          throw new Error("Artifact path must point to an HTML file");
        }

        const file = await handle.stat();
        if (!file.isFile()) throw new Error("Artifact path must point to a regular file");
        if (file.size > MAX_INLINE_HTML_BYTES) {
          throw new Error(`Inline HTML artifact exceeds the ${MAX_INLINE_HTML_BYTES / 1024} KiB limit`);
        }

        const buffer = Buffer.allocUnsafe(MAX_INLINE_HTML_BYTES + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          if (signal?.aborted) throw new Error("Artifact rendering was cancelled");
          const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset > MAX_INLINE_HTML_BYTES) {
          throw new Error(`Inline HTML artifact exceeds the ${MAX_INLINE_HTML_BYTES / 1024} KiB limit`);
        }
        bytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }

      let html: string;
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Artifact file must contain valid UTF-8 HTML");
      }
      if (!html.trim()) throw new Error("Artifact file is empty");

      const sourcePath = relative(workspaceRoot, targetPath).split(sep).join("/");
      const title = (typeof params.title === "string" ? params.title.trim().slice(0, 120) : "") || basename(targetPath, extname(targetPath));
      return {
        content: [{ type: "text", text: `Rendered ${title} inline.` }],
        details: {
          kind: "ocode.inline-html",
          schemaVersion: 1,
          title,
          sourcePath,
          byteLength: bytes.byteLength,
          html,
        },
      };
    },
  });

  pi.registerTool({
    name: OPEN_FILE_TOOL_NAME,
    label: "Open project file",
    description:
      "Open a regular file from the trusted workspace in ocode's read-only resource viewer. The path must be project-relative. This tool returns navigation metadata, not file contents.",
    promptSnippet: "Open a project file in ocode's read-only resource viewer",
    promptGuidelines: [
      "Use ocode_open_file when the user should inspect a source, Markdown, HTML, raster image, or other project file in ocode.",
      "Pass only a project-relative path. Never pass or guess a project ID or an absolute filesystem path.",
      "Use source for code and raw text, preview for Markdown, HTML, and allowlisted raster images, or auto to let ocode choose.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Project-relative path to a regular file." }),
      view: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("source"),
        Type.Literal("preview"),
      ])),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      column: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!context.isProjectTrusted()) throw new Error("Opening project files requires a trusted workspace");
      if (signal?.aborted) throw new Error("Opening the project file was cancelled");
      if (typeof params.path !== "string") throw new Error("Project-relative path is required");
      const path = normalizeProjectResourcePath(params.path);
      if (!path) throw new Error("File path must be a normalized project-relative path");
      const view = params.view === undefined ? undefined : String(params.view);
      if (view !== undefined && !["auto", "source", "preview"].includes(view)) throw new Error("File view is invalid");
      const line = params.line === undefined ? undefined : Number(params.line);
      const column = params.column === undefined ? undefined : Number(params.column);
      if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error("Line must be a positive integer");
      if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) throw new Error("Column must be a positive integer");

      const workspaceRoot = await realpath(context.cwd);
      const lexicalPath = resolve(workspaceRoot, ...path.split("/"));
      if (!isInside(workspaceRoot, lexicalPath)) throw new Error("File path must stay inside the trusted workspace");

      let target: Awaited<ReturnType<typeof secureOpenProjectPath>>;
      try {
        target = await secureOpenProjectPath(workspaceRoot, path);
      } catch (error) {
        if (error instanceof Error && error.message === "path_outside_project") {
          throw new Error("File path must stay inside the trusted workspace");
        }
        throw error;
      }

      try {
        if (!target.file.isFile()) throw new Error("File path must point to a regular file");
        const extension = extname(path).toLowerCase();
        const viewLimit = view === "source" || OPEN_FILE_TEXT_EXTENSIONS.has(extension)
          ? 1024 * 1024
          : OPEN_FILE_IMAGE_EXTENSIONS.has(extension)
            ? 10 * 1024 * 1024
            : MAX_OPEN_FILE_BYTES;
        if (target.file.size > viewLimit) throw new Error(`File exceeds the ${viewLimit / 1024 / 1024} MiB viewer limit`);
      } finally {
        await target.handle.close();
      }

      return {
        content: [{ type: "text", text: `Ready to open ${path}.` }],
        details: {
          kind: "ocode.open-file",
          schemaVersion: 1,
          path,
          ...(view ? { view } : {}),
          ...(line ? { line } : {}),
          ...(column ? { column } : {}),
        },
      };
    },
  });

  // Defer the compatibility override until startup. This avoids initial duplicate-tool
  // diagnostics while ensuring this first-loaded CLI extension owns the final tool.
  pi.on("session_start", () => {
    pi.registerTool(askUserQuestionTool());
  });
}
