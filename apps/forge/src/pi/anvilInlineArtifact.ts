import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { Type } from "typebox";

const MAX_INLINE_HTML_BYTES = 192 * 1024;
const TOOL_NAME = "anvil_render_html_file";

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
      params: { path: string; title?: string },
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
      const requestedPath = params.path.replace(/^@/, "");
      const lexicalPath = resolve(workspaceRoot, requestedPath);
      if (!isInside(workspaceRoot, lexicalPath)) {
        throw new Error("Artifact path must stay inside the trusted workspace");
      }

      const handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
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

      const sourcePath = relative(workspaceRoot, targetPath);
      const title = params.title?.trim().slice(0, 120) || basename(targetPath, extname(targetPath));
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
}
