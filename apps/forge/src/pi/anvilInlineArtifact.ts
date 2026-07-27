import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeProjectResourcePath } from "@anvil/protocol";
import { Type } from "typebox";

import { secureOpenProjectPath } from "../files/secureProjectPath.ts";

const MAX_INLINE_HTML_BYTES = 192 * 1024;
const MAX_OPEN_FILE_BYTES = 20 * 1024 * 1024;
const TOOL_NAME = "anvil_render_html_file";
const OPEN_FILE_TOOL_NAME = "anvil_open_file";
const OPEN_FILE_TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".htm", ".html", ".ini",
  ".java", ".js", ".json", ".jsx", ".log", ".lua", ".md", ".mdx", ".mjs", ".py", ".rb", ".rs", ".sh",
  ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const OPEN_FILE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface ToolContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

interface ExtensionApi {
  registerTool(definition: {
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
  }): void;
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
      "Render a small, self-contained HTML file inline in Anvil chat. The path must be a regular .html or .htm file inside the trusted workspace and the file must be no larger than 192 KiB.",
    promptSnippet: "Render a small local HTML file inline in Anvil chat",
    promptGuidelines: [
      "Use anvil_render_html_file after writing a small self-contained HTML artifact that the user should see inline in chat.",
      "Keep anvil_render_html_file artifacts visually clean: use a transparent page background, responsive layout, and no external network resources.",
      "Use HTML, CSS, and SVG for anvil_render_html_file artifacts; generated JavaScript is blocked by the renderer.",
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
          kind: "anvil.inline-html",
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
      "Open a regular file from the trusted workspace in Anvil's read-only resource viewer. The path must be project-relative. This tool returns navigation metadata, not file contents.",
    promptSnippet: "Open a project file in Anvil's read-only resource viewer",
    promptGuidelines: [
      "Use anvil_open_file when the user should inspect a source, Markdown, HTML, raster image, or other project file in Anvil.",
      "Pass only a project-relative path. Never pass or guess a project ID or an absolute filesystem path.",
      "Use source for code and raw text, preview for Markdown, HTML, and allowlisted raster images, or auto to let Anvil choose.",
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
          kind: "anvil.open-file",
          schemaVersion: 1,
          path,
          ...(view ? { view } : {}),
          ...(line ? { line } : {}),
          ...(column ? { column } : {}),
        },
      };
    },
  });
}
