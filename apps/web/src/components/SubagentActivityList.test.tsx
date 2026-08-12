import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubagentActivityList } from "./SubagentActivityList";

describe("SubagentActivityList", () => {
  it("groups compact agent rows into active and recent sections", () => {
    const html = renderToStaticMarkup(
      <SubagentActivityList
        activity={{
          active: 1,
          finished: 1,
          failed: 0,
          needsAttention: 0,
          items: [
            {
              id: "run-live",
              source: "durable",
              role: "scout",
              status: "running",
              task: "Inspect the project boundary",
              parentToolCallId: "tool-live",
              createdAt: "2026-07-25T10:00:00.000Z",
              updatedAt: "2026-07-25T10:01:00.000Z",
              startedAt: "2026-07-25T10:00:00.000Z",
            },
            {
              id: "run-done",
              source: "durable",
              role: "reviewer",
              status: "completed",
              task: "Review the final patch",
              parentToolCallId: "tool-done",
              createdAt: "2026-07-25T09:55:00.000Z",
              updatedAt: "2026-07-25T09:59:00.000Z",
              startedAt: "2026-07-25T09:55:00.000Z",
              endedAt: "2026-07-25T09:59:00.000Z",
            },
          ],
        }}
        now={Date.parse("2026-07-25T10:02:00.000Z")}
        connection="connected"
        loading={false}
        restoreScrollTop={0}
        scrollAreaRef={createRef<HTMLDivElement>()}
        onSelect={() => undefined}
        onClose={() => undefined}
        embedded
      />,
    );

    expect(html).toContain("1 active");
    expect(html).toContain("2 total");
    expect(html).toContain("Active");
    expect(html).toContain("Recent");
    expect(html).toContain("Scout");
    expect(html).toContain("Reviewer");
    expect(html).not.toContain("subagent-status-badge");
  });

  it("shows only a centered No Agents label when empty", () => {
    const html = renderToStaticMarkup(
      <SubagentActivityList
        activity={{ active: 0, finished: 0, failed: 0, needsAttention: 0, items: [] }}
        now={Date.now()}
        connection="connected"
        loading={false}
        restoreScrollTop={0}
        scrollAreaRef={createRef<HTMLDivElement>()}
        onSelect={() => undefined}
        onClose={() => undefined}
        embedded
      />,
    );

    expect(html).toContain("No Agents");
    expect(html).not.toContain("No agent runs");
    expect(html).not.toContain("Agent work launched");
    expect(html).not.toContain('data-slot="empty-icon"');
  });
});
