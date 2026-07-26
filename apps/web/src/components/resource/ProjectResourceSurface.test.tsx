import type { ProjectFileMetadata } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildInlineHtmlDocument } from "../InlineHtmlArtifact";
import { createImageObjectUrl, loadProjectImageObjectUrl } from "./ProjectImageViewer";
import { ResourceViewer } from "./ProjectResourceSurface";
import { SourceViewer } from "./SourceViewer";

const baseFile: ProjectFileMetadata = {
  path: "src/main.ts",
  name: "main.ts",
  kind: "file",
  size: 20,
  modifiedAt: "2026-07-23T01:00:00.000Z",
  etag: "\"etag\"",
  mediaType: "text/typescript; charset=utf-8",
  viewer: "source",
};

const tab = {
  id: "src/main.ts",
  projectId: "project-1",
  path: "src/main.ts",
  view: "auto" as const,
  openedFrom: "timeline" as const,
};

describe("project resource viewers", () => {
  it("targets source lines and columns with syntax-highlighted, selectable text", () => {
    const html = renderToStaticMarkup(
      <SourceViewer path="src/main.ts" text={"const one = 1;\nreturn one;"} line={2} column={4} />,
    );
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('data-line="2"');
    expect(html).toContain('data-target-column="4"');
    expect(html).toContain("syntax-keyword");
    expect(html).toContain("source-line-number");
  });

  it("renders Markdown without enabling raw HTML", () => {
    const html = renderToStaticMarkup(
      <ResourceViewer
        tab={{ ...tab, id: "README.md", path: "README.md" }}
        state={{
          status: "ready",
          file: { ...baseFile, path: "README.md", name: "README.md", viewer: "markdown", mediaType: "text/markdown; charset=utf-8" },
          text: "# Safe\n<script>window.pwned = true</script>",
        }}
      />,
    );
    expect(html).toContain("<h1>Safe</h1>");
    expect(html).not.toContain("<script>window.pwned");
    expect(html).toContain("&lt;script&gt;");
  });

  it("builds HTML previews with a deny-by-default CSP and sanitizing bridge", () => {
    const document = buildInlineHtmlDocument('<a href="https://example.com" onclick="pwn()">Go</a><script>pwn()</script>', "test-token");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("navigate-to 'none'");
    expect(document).toContain('querySelectorAll("script, iframe');
    expect(document).toContain("/^on/i");
    expect(document).not.toContain('<script>pwn()</script>');
  });

  it("revokes authenticated image object URLs on cleanup", () => {
    const revoked: string[] = [];
    const handle = createImageObjectUrl(new Blob(["image"]), {
      createObjectURL: () => "blob:project-image",
      revokeObjectURL: (url) => revoked.push(url),
    });
    expect(handle.url).toBe("blob:project-image");
    handle.dispose();
    expect(revoked).toEqual(["blob:project-image"]);
  });

  it("does not create an object URL when the viewer aborts while blob decoding is pending", async () => {
    const controller = new AbortController();
    let resolveBlob!: (blob: Blob) => void;
    const blob = new Promise<Blob>((resolve) => { resolveBlob = resolve; });
    const created: string[] = [];
    const loading = loadProjectImageObjectUrl("project-1", "pixel.png", controller.signal, {
      fetch: (async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => blob,
      }) as Response) as typeof fetch,
      urlApi: {
        createObjectURL: () => { created.push("blob:late"); return "blob:late"; },
        revokeObjectURL: () => undefined,
      },
    });

    controller.abort();
    resolveBlob(new Blob(["image"]));
    await expect(loading).resolves.toBeUndefined();
    expect(created).toEqual([]);
  });

  it("shows metadata instead of decoding unsupported binary files", () => {
    const html = renderToStaticMarkup(
      <ResourceViewer
        tab={{ ...tab, id: "archive.bin", path: "archive.bin" }}
        state={{
          status: "ready",
          file: { ...baseFile, path: "archive.bin", name: "archive.bin", viewer: "unsupported", mediaType: "application/octet-stream" },
        }}
      />,
    );
    expect(html).toContain("Preview unavailable");
    expect(html).toContain("application/octet-stream");
  });
});
