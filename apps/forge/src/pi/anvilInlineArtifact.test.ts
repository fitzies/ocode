import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import anvilInlineArtifact from "./anvilInlineArtifact.ts";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Anvil inline artifact Pi extension", () => {
  it("snapshots a bounded workspace HTML file into structured tool details", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-inline-html-"));
    const html = "<!doctype html><p>Usage</p>";
    writeFileSync(join(directory, "usage.html"), html);
    let tool: Parameters<Parameters<typeof anvilInlineArtifact>[0]["registerTool"]>[0] | undefined;
    anvilInlineArtifact({ registerTool: (definition) => { tool = definition; } });

    const result = await tool!.execute(
      "call-1",
      { path: "usage.html", title: "Usage preview" },
      undefined,
      undefined,
      { cwd: directory, isProjectTrusted: () => true },
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Rendered Usage preview inline." }],
      details: {
        kind: "anvil.inline-html",
        schemaVersion: 1,
        title: "Usage preview",
        sourcePath: "usage.html",
        html,
      },
    });
  });

  it("rejects files outside the trusted workspace", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-inline-html-"));
    const outside = join(tmpdir(), `outside-${Date.now()}.html`);
    writeFileSync(outside, "<p>Outside</p>");
    let tool: Parameters<Parameters<typeof anvilInlineArtifact>[0]["registerTool"]>[0] | undefined;
    anvilInlineArtifact({ registerTool: (definition) => { tool = definition; } });

    await expect(tool!.execute(
      "call-2",
      { path: outside },
      undefined,
      undefined,
      { cwd: directory, isProjectTrusted: () => true },
    )).rejects.toThrow("inside the trusted workspace");
    rmSync(outside, { force: true });
  });
});
