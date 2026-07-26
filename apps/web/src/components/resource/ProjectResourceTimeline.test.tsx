import type { SessionSummary, ToolEntry } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { Timeline, trustedFileToolResource } from "../Timeline";

it("keeps an explicit manual Open file action on completed timeline results", () => {
  const session: SessionSummary = {
    id: "session-1",
    projectId: "project-1",
    title: "Resource",
    updatedAt: "2026-07-23T01:00:00.000Z",
    status: "idle",
    modelId: "test/model",
    thinkingLevel: "off",
  };
  const tool: ToolEntry = {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    name: "anvil_open_file",
    summary: "Open file",
    status: "completed",
    arguments: { path: "src/main.ts" },
    output: [{ id: "resource-1", type: "projectResource", path: "src/main.ts", line: 7 }],
    createdAt: session.updatedAt,
  };
  const html = renderToStaticMarkup(
    <Timeline session={session} entries={[tool]} onSuggestion={vi.fn()} onOpenProjectResource={vi.fn()} />,
  );

  expect(html).toContain("Open file");
  expect(html).toContain("src/main.ts:7");
});

it("offers successful write and edit paths without trusting unsafe or absolute arguments", () => {
  const base: ToolEntry = {
    id: "tool-write",
    kind: "tool",
    toolCallId: "call-write",
    name: "write",
    summary: "Write file",
    status: "completed",
    arguments: { path: "docs/hello.md", content: "Hello" },
    output: [{ id: "text", type: "text", text: "Wrote docs/hello.md" }],
    createdAt: "2026-07-23T01:00:00.000Z",
  };

  expect(trustedFileToolResource(base)).toMatchObject({ type: "projectResource", path: "docs/hello.md" });
  expect(trustedFileToolResource({ ...base, id: "edit", name: "edit" })).toMatchObject({ path: "docs/hello.md" });
  expect(trustedFileToolResource({ ...base, status: "failed" })).toBeUndefined();
  expect(trustedFileToolResource({ ...base, arguments: { path: "../secret" } })).toBeUndefined();
  expect(trustedFileToolResource({ ...base, arguments: { path: "/tmp/hello.md" } })).toBeUndefined();
  expect(trustedFileToolResource({ ...base, name: "custom_tool" })).toBeUndefined();
});
