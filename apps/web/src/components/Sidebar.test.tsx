import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";
import { FixtureAnvilClient, type AnvilClientSnapshot } from "../lib/anvilClient";
import { Sidebar } from "./Sidebar";

function renderSnapshot(snapshot: AnvilClientSnapshot): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <Sidebar
        snapshot={snapshot}
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onNewProject={() => undefined}
        onRequestDeleteSession={() => undefined}
        onRequestRenameSession={() => undefined}
        onSetSessionSettled={async () => undefined}
        onMarkSessionRead={() => undefined}
        onMarkSessionUnread={() => undefined}
      />
    </SidebarProvider>,
  );
}

function renderSidebar(client: FixtureAnvilClient): string {
  return renderSnapshot(client.getSnapshot());
}

describe("Sidebar thread ordering", () => {
  afterEach(() => vi.useRealTimers());

  it("renders fixed-card metadata with a capitalized title and project branch", () => {
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const target = base.sessions[0]!;
    const project = base.projects.find((candidate) => candidate.id === target.projectId)!;
    const markup = renderSnapshot({
      ...base,
      sessions: base.sessions.map((session) => session.id === target.id
        ? { ...session, title: "lowercase thread", branch: "feature/sidebar" }
        : session),
    });

    expect(markup).toContain("Lowercase thread");
    expect(markup).toContain(`${project.path.split("/").at(-1)}/feature/sidebar`);
    expect(markup).toContain('aria-label="Create thread"');
    expect(markup).not.toContain(">Unsettled<");
  });

  it("exposes the active thread as the current page", () => {
    const client = new FixtureAnvilClient();
    const snapshot = client.getSnapshot();
    const activeSessionId = snapshot.activeSessionId!;
    const markup = renderSnapshot(snapshot);
    const start = markup.indexOf(`data-session-id="${activeSessionId}"`);
    const next = markup.indexOf("data-session-id=", start + 1);
    const activeCard = markup.slice(start, next === -1 ? undefined : next);

    expect(activeCard).toContain('aria-current="page"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("uses the repository directory name rather than a display-name slug", () => {
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const project = base.projects[0]!;
    const markup = renderSnapshot({
      ...base,
      projects: base.projects.map((candidate) => candidate.id === project.id
        ? { ...candidate, name: "cell journey", path: "/home/oli/code/cell-journey" }
        : candidate),
    });

    expect(markup).toContain("cell-journey/main");
    expect(markup).not.toContain("cell journey/main");
  });

  it("uses a project select instead of project filter chips", () => {
    const client = new FixtureAnvilClient();
    const markup = renderSidebar(client);

    expect(markup).toContain('aria-label="Select project"');
    expect(markup).toContain('data-variant="sidebar"');
    expect(markup).toContain("All projects");
    expect(markup).not.toContain('aria-label="Filter threads by project"');
    expect(markup).not.toContain(">Threads</span>");
    expect(markup.indexOf('aria-label="New project"')).toBeGreaterThan(markup.indexOf('aria-label="Create thread"'));
  });

  it("shows running time from the latest user message rather than later session updates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T09:02:05.000Z"));
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const target = base.sessions[0]!;
    const markup = renderSnapshot({
      ...base,
      sessions: base.sessions.map((session) => session.id === target.id
        ? {
            ...session,
            status: "running" as const,
            lastUserMessageAt: "2026-07-21T09:00:00.000Z",
            updatedAt: "2026-07-21T09:02:00.000Z",
          }
        : session),
    });
    const start = markup.indexOf(`data-session-id="${target.id}"`);
    const next = markup.indexOf("data-session-id=", start + 1);
    const card = markup.slice(start, next === -1 ? undefined : next);

    expect(card).toContain("2m 5s");
  });

  it("hides the settle action while a thread is running", () => {
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const target = base.sessions[0]!;
    const markup = renderSnapshot({
      ...base,
      sessions: base.sessions.map((session) => session.id === target.id
        ? { ...session, title: "Active task", status: "running" as const, settled: false }
        : session),
    });
    const start = markup.indexOf(`data-session-id="${target.id}"`);
    const next = markup.indexOf("data-session-id=", start + 1);
    const card = markup.slice(start, next === -1 ? undefined : next);

    expect(card).not.toContain('aria-label="Settle Active task"');
    expect(card).toContain("Running");
    expect(card).not.toMatch(/NaN|\d+m \d+s/);
  });

  it("moves user-settled threads into the compact settled section", () => {
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const sessionId = base.sessions[0]!.id;
    const markup = renderSnapshot({
      ...base,
      sessions: base.sessions.map((session) => session.id === sessionId ? { ...session, settled: true } : session),
    });
    const settledHeading = markup.indexOf("Settled");
    const session = markup.indexOf(`data-session-id="${sessionId}"`);

    expect(markup).toContain("session-item--settled");
    expect(settledHeading).toBeLessThan(session);
    expect(markup).toContain("Unsettle");
  });

  it("renders a thread first in its workspace immediately after the user sends a message", () => {
    vi.useFakeTimers();
    const client = new FixtureAnvilClient();
    const targetTitle = "Build the protocol foundation";
    const previousFirstTitle = "Extension interaction contract";

    const before = renderSidebar(client);
    expect(before.indexOf(previousFirstTitle)).toBeLessThan(before.indexOf(targetTitle));

    client.selectSession("ordinary-run");
    client.sendPrompt("Move this thread to the top");

    const after = renderSidebar(client);
    expect(after.indexOf(targetTitle)).toBeLessThan(after.indexOf(previousFirstTitle));
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "uses only a brighter title for an unread %s terminal outcome",
    (outcome) => {
      const client = new FixtureAnvilClient();
      const base = client.getSnapshot();
      const sessionId = base.sessions[0]!.id;
      const withReadThrough = (readThroughSequence: number) => ({
        ...base,
        sessions: base.sessions.map((session) => session.id === sessionId
          ? { ...session, lastTerminalSequence: 500, lastTerminalOutcome: outcome, readThroughSequence }
          : session),
      });
      const targetSession = (markup: string) => {
        const start = markup.indexOf(`data-session-id="${sessionId}"`);
        const next = markup.indexOf("data-session-id=", start + 1);
        return markup.slice(start, next === -1 ? undefined : next);
      };

      const unread = targetSession(renderSnapshot(withReadThrough(499)));
      expect(unread).toContain("session-title--unread");
      expect(unread).not.toContain("session-dot");
      expect(unread.includes("session-recency--completed")).toBe(outcome === "completed");

      const read = targetSession(renderSnapshot(withReadThrough(500)));
      expect(read).not.toContain("session-title--unread");
      expect(read).not.toContain("session-recency--completed");
    },
  );
});
