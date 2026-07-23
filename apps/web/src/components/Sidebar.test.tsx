import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FixtureAnvilClient } from "../lib/anvilClient";
import { Sidebar } from "./Sidebar";

function renderSidebar(client: FixtureAnvilClient): string {
  return renderToStaticMarkup(
    <Sidebar
      snapshot={client.getSnapshot()}
      open
      mobile={false}
      onClose={() => undefined}
      onSelectSession={() => undefined}
      onCreateSession={() => undefined}
      onAddWorkspace={() => undefined}
      onRequestDeleteSession={() => undefined}
    />,
  );
}

describe("Sidebar thread ordering", () => {
  afterEach(() => vi.useRealTimers());

  it("renders a thread first in its workspace immediately after the user sends a message", () => {
    vi.useFakeTimers();
    const client = new FixtureAnvilClient();
    const targetTitle = "Extension interaction contract";
    const previousFirstTitle = "Build the protocol foundation";

    const before = renderSidebar(client);
    expect(before.indexOf(previousFirstTitle)).toBeLessThan(before.indexOf(targetTitle));

    client.selectSession("dialog-queue");
    client.sendPrompt("Move this thread to the top");

    const after = renderSidebar(client);
    expect(after.indexOf(targetTitle)).toBeLessThan(after.indexOf(previousFirstTitle));
  });
});
