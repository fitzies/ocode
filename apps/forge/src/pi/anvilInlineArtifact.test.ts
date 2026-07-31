import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOcodeAskUserQuestionResponse,
  OCODE_ASK_USER_QUESTION_EDITOR_SENTINEL,
  parseOcodeAskUserQuestionEditorEnvelope,
} from "@anvil/protocol";
import { afterEach, describe, expect, it } from "vitest";

import anvilInlineArtifact from "./anvilInlineArtifact.ts";

type Tool = Parameters<Parameters<typeof anvilInlineArtifact>[0]["registerTool"]>[0];
let directory: string | undefined;

function toolHarness() {
  const registered = new Map<string, Tool>();
  const sessionStartHandlers: Array<() => void> = [];
  anvilInlineArtifact({
    registerTool: (definition) => registered.set(definition.name, definition),
    on: (_event, handler) => sessionStartHandlers.push(handler),
  });
  return {
    registered,
    startSession: () => sessionStartHandlers.forEach((handler) => handler()),
  };
}

function tools(): Map<string, Tool> {
  const harness = toolHarness();
  harness.startSession();
  return harness.registered;
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("bundled ocode Pi extension", () => {
  it("defers the ask_user_question override until session start", () => {
    const harness = toolHarness();
    expect([...harness.registered.keys()]).toEqual(["ocode_render_html_file", "ocode_open_file"]);

    harness.startSession();
    expect([...harness.registered.keys()]).toEqual([
      "ocode_render_html_file",
      "ocode_open_file",
      "ask_user_question",
    ]);
  });

  it("tunnels rich questions through the versioned editor envelope and maps option responses", async () => {
    let editorTitle: string | undefined;
    let editorPrefill: string | undefined;
    const tool = tools().get("ask_user_question")!;
    const result = await tool.execute(
      "call-ask",
      {
        question: "Which approach?",
        details: "Choose based on maintainability.",
        options: [
          { label: "Direct", value: "direct", description: "Smallest implementation" },
          { label: "Layered", value: "layered" },
        ],
      },
      undefined,
      undefined,
      {
        cwd: "/workspace",
        isProjectTrusted: () => true,
        hasUI: true,
        ui: {
          editor: async (title, prefill) => {
            editorTitle = title;
            editorPrefill = prefill;
            return createOcodeAskUserQuestionResponse([{ type: "option", optionIndex: 1 }]);
          },
        },
      },
    );

    expect(editorTitle).toBe(OCODE_ASK_USER_QUESTION_EDITOR_SENTINEL);
    expect(parseOcodeAskUserQuestionEditorEnvelope(editorPrefill)).toEqual({
      kind: "ocode.ask-user-question",
      schemaVersion: 1,
      question: "Which approach?",
      context: "Choose based on maintainability.",
      mode: "single-select",
      options: [
        { label: "Direct", value: "direct", description: "Smallest implementation" },
        { label: "Layered", value: "layered" },
      ],
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "User selected: 2. Layered" }],
      details: {
        status: "answered",
        question: "Which approach?",
        mode: "single-select",
        answers: [{ type: "option", label: "Layered", value: "layered", index: 2 }],
      },
    });
    expect(result.details).not.toHaveProperty("cancelled");
  });

  it("fails closed for malformed responses and an already-aborted signal", async () => {
    let editorCalls = 0;
    const tool = tools().get("ask_user_question")!;
    const context = {
      cwd: "/workspace",
      isProjectTrusted: () => true,
      hasUI: true,
      ui: { editor: async () => {
        editorCalls++;
        return editorCalls === 1 ? { answers: [] } : undefined;
      } },
    };
    const malformed = await tool.execute("call-bad", { question: "Explain?" }, undefined, undefined, context);
    const explicitlyCancelled = await tool.execute(
      "call-cancel",
      { question: "Explain?" },
      undefined,
      undefined,
      context,
    );
    const controller = new AbortController();
    controller.abort();
    const aborted = await tool.execute("call-abort", { question: "Explain?" }, controller.signal, undefined, context);

    expect(malformed).toMatchObject({
      details: { status: "cancelled", cancelled: true, message: "User cancelled the question" },
    });
    expect(explicitlyCancelled).toMatchObject({
      details: { status: "cancelled", cancelled: true, mode: "text", answers: [] },
    });
    expect(aborted).toMatchObject({
      details: { status: "cancelled", cancelled: true, mode: "text", answers: [] },
    });
    expect(editorCalls).toBe(2);
  });

  it("reports unavailable interactive UI without treating it as user cancellation", async () => {
    const result = await tools().get("ask_user_question")!.execute(
      "call-unavailable",
      { question: "Explain?" },
      undefined,
      undefined,
      { cwd: "/workspace", isProjectTrusted: () => true, hasUI: false },
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "ask_user_question requires interactive mode UI" }],
      details: {
        status: "unavailable",
        message: "ask_user_question requires interactive mode UI",
        mode: "text",
        answers: [],
      },
    });
    expect(result.details).not.toHaveProperty("cancelled");
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
