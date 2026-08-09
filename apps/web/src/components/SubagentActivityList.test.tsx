import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubagentActivityList } from "./SubagentActivityList";

describe("SubagentActivityList", () => {
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
