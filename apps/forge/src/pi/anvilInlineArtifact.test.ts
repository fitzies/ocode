import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import anvilInlineArtifact from "./anvilInlineArtifact.ts";

type Tool = Parameters<Parameters<typeof anvilInlineArtifact>[0]["registerTool"]>[0];
let directory: string | undefined;

function tools(): Map<string, Tool> {
  const registered = new Map<string, Tool>();
  anvilInlineArtifact({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered;
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("bundled ocode Pi extension", () => {
  it("registers inline HTML and project-file tools", () => {
    expect([...tools().keys()]).toEqual(["ocode_render_html_file", "ocode_open_file"]);
  });

  it("snapshots a bounded workspace HTML file into structured tool details", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-inline-html-"));
    const html = "<!doctype html><p>Usage</p>";
    writeFileSync(join(directory, "usage.html"), html);
    const tool = tools().get("ocode_render_html_file")!;

    const result = await tool.execute(
      "call-1",
      { path: "usage.html", title: "Usage preview" },
      undefined,
      undefined,
      { cwd: directory, isProjectTrusted: () => true },
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Rendered Usage preview inline." }],
      details: {
        kind: "ocode.inline-html",
        schemaVersion: 1,
        title: "Usage preview",
        sourcePath: "usage.html",
        html,
      },
    });
  });

  it("returns normalized open-file metadata without file contents or project identity", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-open-file-"));
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "main.ts"), "export const ready = true;\n");
    const result = await tools().get("ocode_open_file")!.execute(
      "call-open",
      { path: "src/main.ts", view: "source", line: 3, column: 2 },
      undefined,
      undefined,
      { cwd: directory, isProjectTrusted: () => true },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Ready to open src/main.ts." }],
      details: {
        kind: "ocode.open-file",
        schemaVersion: 1,
        path: "src/main.ts",
        view: "source",
        line: 3,
        column: 2,
      },
    });
    expect(result.details).not.toHaveProperty("projectId");
    expect(JSON.stringify(result)).not.toContain("export const");
  });

  it.each(["/etc/passwd", "../secret", "src/../secret", "C:/Windows/file.txt", "bad\0path"])(
    "rejects unsafe open-file path %s",
    async (path) => {
      directory = mkdtempSync(join(tmpdir(), "anvil-open-file-"));
      await expect(tools().get("ocode_open_file")!.execute(
        "call-invalid",
        { path },
        undefined,
        undefined,
        { cwd: directory, isProjectTrusted: () => true },
      )).rejects.toThrow("project-relative path");
    },
  );

  it("requires trust, a regular file, and containment after following symlinks", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-open-file-"));
    const outside = join(tmpdir(), `anvil-open-file-outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(directory, "escape.txt"));
    const tool = tools().get("ocode_open_file")!;

    await expect(tool.execute("call-untrusted", { path: "escape.txt" }, undefined, undefined, {
      cwd: directory,
      isProjectTrusted: () => false,
    })).rejects.toThrow("trusted workspace");
    await expect(tool.execute("call-directory", { path: "." }, undefined, undefined, {
      cwd: directory,
      isProjectTrusted: () => true,
    })).rejects.toThrow("project-relative path");
    await expect(tool.execute("call-escape", { path: "escape.txt" }, undefined, undefined, {
      cwd: directory,
      isProjectTrusted: () => true,
    })).rejects.toThrow("inside the trusted workspace");
    rmSync(outside, { force: true });
  });

  it.runIf(process.platform !== "win32")("rejects special files without blocking", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-open-file-"));
    execFileSync("mkfifo", [join(directory, "pipe")]);
    await expect(Promise.race([
      tools().get("ocode_open_file")!.execute("call-pipe", { path: "pipe" }, undefined, undefined, {
        cwd: directory,
        isProjectTrusted: () => true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO open blocked")), 1_000)),
    ])).rejects.toThrow("regular file");
  });

  it("rejects inline artifact files outside the trusted workspace", async () => {
    directory = mkdtempSync(join(tmpdir(), "anvil-inline-html-"));
    const outside = join(tmpdir(), `outside-${Date.now()}.html`);
    writeFileSync(outside, "<p>Outside</p>");
    const tool = tools().get("ocode_render_html_file")!;

    await expect(tool.execute(
      "call-2",
      { path: outside },
      undefined,
      undefined,
      { cwd: directory, isProjectTrusted: () => true },
    )).rejects.toThrow("inside the trusted workspace");
    rmSync(outside, { force: true });
  });
});
