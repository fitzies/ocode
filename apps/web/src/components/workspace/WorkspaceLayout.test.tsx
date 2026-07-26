import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceLayout } from "./WorkspaceLayout";

describe("WorkspaceLayout", () => {
  it("leaves no desktop panel handles or gaps when optional slots are absent", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceLayout isMobile={false} main={<main>Conversation</main>} />,
    );

    expect(markup).toContain("Conversation");
    expect(markup.match(/workspace-layout-handle--hidden/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Project terminal surface" hidden=""');
    expect(markup).toContain('aria-label="Project resource surface" hidden=""');
  });

  it("mounts bottom and right placeholders in nested desktop resizable groups", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceLayout
        isMobile={false}
        main={<main>Conversation</main>}
        bottom={<div>Terminal placeholder</div>}
        right={<div>Resource placeholder</div>}
      />,
    );

    expect(markup).toContain("Terminal placeholder");
    expect(markup).toContain("Resource placeholder");
    expect(markup).toContain("workspace-layout-terminal-handle");
    expect(markup.match(/data-slot="resizable-panel-group"/g)).toHaveLength(2);
    expect(markup.match(/data-slot="resizable-handle"/g)).toHaveLength(2);
  });

  it("keeps the terminal under the same stable desktop panel ancestry when resources toggle", () => {
    const withoutResource = renderToStaticMarkup(
      <WorkspaceLayout isMobile={false} main={<main>Conversation</main>} bottom={<div data-testid="terminal">Terminal</div>} />,
    );
    const withResource = renderToStaticMarkup(
      <WorkspaceLayout isMobile={false} main={<main>Conversation</main>} bottom={<div data-testid="terminal">Terminal</div>} right={<div>Resource</div>} />,
    );

    for (const markup of [withoutResource, withResource]) {
      expect(markup).toContain('id="workspace-bottom"');
      expect(markup).toContain('data-testid="terminal"');
      expect(markup.indexOf('id="workspace-bottom"')).toBeLessThan(markup.indexOf('data-testid="terminal"'));
    }
  });

  it("shows one full-screen mobile surface and falls back to conversation for an absent slot", () => {
    const terminal = renderToStaticMarkup(
      <WorkspaceLayout
        isMobile
        mobileSurface="terminal"
        main={<main>Conversation</main>}
        bottom={<div>Terminal placeholder</div>}
      />,
    );
    const missingResource = renderToStaticMarkup(
      <WorkspaceLayout
        isMobile
        mobileSurface="resource"
        main={<main>Conversation</main>}
      />,
    );

    expect(terminal).toContain('data-mobile-surface="terminal"');
    expect(terminal).toContain("Terminal placeholder");
    expect(terminal).not.toContain("<main>Conversation</main>");
    expect(terminal).toContain("Conversation</button>");
    expect(missingResource).toContain('data-mobile-surface="conversation"');
    expect(missingResource).toContain("<main>Conversation</main>");
  });
});
