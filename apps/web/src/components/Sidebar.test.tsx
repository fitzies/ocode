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
        activeProjectId={snapshot.workspaceLocation?.projectId ?? null}
        onSelectProject={() => undefined}
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onAddWorkspace={() => undefined}
        onRequestDeleteSession={() => undefined}
        onSetSessionSettled={async () => undefined}
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
    expect(markup).toContain(`${project.name}/feature/sidebar`);
    expect(markup).toContain('aria-label="Create thread"');
    expect(markup).not.toContain(">Unsettled<");
  });

  it("renders workspace navigation separately from thread filters", () => {
    const client = new FixtureAnvilClient();
    const markup = renderSidebar(client);

    expect(markup).toContain('aria-label="Navigate to workspace"');
    expect(markup).toContain('aria-label="Filter threads by project"');
    expect(markup).toContain("workspace-navigation-label\">Workspace");
    expect(markup).toContain(">Threads</span>");
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

  it("shows successful background completion as unviewed until its sequence is read", () => {
    const client = new FixtureAnvilClient();
    const base = client.getSnapshot();
    const sessionId = base.sessions[0]!.id;
    const completed = {
      ...base,
      sessions: base.sessions.map((session) => session.id === sessionId
        ? { ...session, lastTerminalSequence: 500, lastTerminalOutcome: "completed" as const }
        : session),
      readThroughSequences: { ...base.readThroughSequences, [sessionId]: 499 },
    };
    const targetSession = (markup: string) => {
      const start = markup.indexOf(`data-session-id="${sessionId}"`);
      const next = markup.indexOf("data-session-id=", start + 1);
      return markup.slice(start, next === -1 ? undefined : next);
    };
    expect(targetSession(renderSnapshot(completed))).toContain("session-recency--completed");
    expect(targetSession(renderSnapshot({
      ...completed,
      readThroughSequences: { ...completed.readThroughSequences, [sessionId]: 500 },
    }))).not.toContain("session-recency--completed");
  });
});
