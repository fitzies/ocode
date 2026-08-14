import type { SessionSummary, TimelineEntry } from "@anvil/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SubagentActivityItem } from "../lib/subagentActivity";
import { SubagentChatView } from "./SubagentChatView";

const item: SubagentActivityItem = {
  id: "run-1",
  source: "durable",
  role: "builder",
  status: "running",
  task: "Implement the Agents side view",
  parentToolCallId: "tool-1",
  childSessionId: "child-1",
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:01:00.000Z",
};

const session: SessionSummary = {
  id: "child-1",
  projectId: "project-1",
  title: "Builder child",
  updatedAt: item.updatedAt,
  status: "running",
  modelId: "test/model",
  thinkingLevel: "off",
  internal: true,
  parentSessionId: "parent-1",
};

const entries: TimelineEntry[] = [
  {
    id: "task",
    kind: "message",
    role: "user",
    status: "complete",
    createdAt: item.createdAt,
    content: [{ id: "task-text", type: "text", text: item.task }],
  },
  {
    id: "reply",
    kind: "message",
    role: "assistant",
    status: "streaming",
    createdAt: item.updatedAt,
    content: [{ id: "reply-text", type: "text", text: "Updating the shared workspace state." }],
  },
  {
    id: "tool",
    kind: "tool",
    toolCallId: "call-1",
    name: "edit",
    label: "Edited WorkspaceSurfaceState.tsx",
    summary: "Edited one file",
    status: "completed",
    arguments: {},
    output: [],
    createdAt: item.updatedAt,
  },
];

describe("SubagentChatView", () => {
  it("renders the child transcript in a compact read-only view", () => {
    const html = renderToStaticMarkup(
      <SubagentChatView
        item={item}
        session={session}
        entries={entries}
        now={Date.parse("2026-07-25T10:02:00.000Z")}
        loading={false}
        cancelling={false}
        onBack={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("Builder");
    expect(html).toContain("Implement the Agents side view");
    expect(html).toContain("Updating the shared workspace state.");
    expect(html).toContain("Edited WorkspaceSurfaceState.tsx");
    expect(html).toContain(">Read-only</span>");
    expect(html).not.toContain(">Live</span>");
    expect(html).not.toContain("subagent-activity-icon--running");
    expect(html).not.toContain("Open full thread");
  });

  it("shows a waiting state when the child timeline only contains the delegated task", () => {
    const html = renderToStaticMarkup(
      <SubagentChatView
        item={item}
        session={session}
        entries={[entries[0]!]}
        now={Date.parse("2026-07-25T10:02:00.000Z")}
        loading={false}
        cancelling={false}
        onBack={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("Waiting for the agent&#x27;s first activity");
    expect(html).not.toContain("subagent-chat-stream");
  });

  it("shows a finished child as an outcome instead of replaying the task", () => {
    const html = renderToStaticMarkup(
      <SubagentChatView
        item={{
          ...item,
          status: "completed",
          result: "# Answer\n\nImplemented the side panel and added regression coverage.",
          endedAt: "2026-07-25T10:03:00.000Z",
        }}
        session={{ ...session, status: "idle" }}
        entries={entries.map((entry) => entry.kind === "message" && entry.role === "assistant"
          ? { ...entry, status: "complete" as const }
          : entry)}
        now={Date.parse("2026-07-25T10:03:00.000Z")}
        loading={false}
        cancelling={false}
        onBack={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("Completed");
    expect(html).toContain("Implemented the side panel and added regression coverage.");
    expect(html).not.toContain(">Answer<");
    expect(html).toContain("Activity");
    expect(html).toContain("Copy");
    expect(html).not.toContain("<strong>Task</strong>");
    expect(html).not.toContain(">Read-only</span>");
  });
});
