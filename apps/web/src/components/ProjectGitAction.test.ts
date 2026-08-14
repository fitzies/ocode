import { describe, expect, it } from "vitest";

const nodeFsSpecifier = "node:fs";
const { readFileSync } = await import(nodeFsSpecifier);
const actionSource = readFileSync(new URL("./ProjectGitAction.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./ProjectGitStatusPanel.tsx", import.meta.url), "utf8");
const surfaceSource = readFileSync(new URL("./ProjectGitSurface.tsx", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");

describe("ProjectGitAction Mira header control", () => {
  it("matches the compact terminal and folder controls", () => {
    expect(actionSource).toContain('variant="ghost"');
    expect(actionSource).toContain('size="icon-sm"');
    expect(actionSource).toContain("header-outline-control");
    expect(actionSource).not.toContain("repository-header-button");
    expect(actionSource).not.toContain("repository-status-trigger");
    expect(actionSource).not.toContain("repository-inline-action");
    expect(shellStyles).not.toContain(".repository-status-trigger");
    expect(shellStyles).not.toContain(".repository-inline-action");
  });

  it("opens repository status in the shared file side viewer", () => {
    expect(actionSource).toContain('openSidePage("git")');
    expect(actionSource).toContain("gitActive ? setRightVisible(false)");
    expect(actionSource).toContain("<TooltipTrigger asChild>{trigger}</TooltipTrigger>");
    expect(actionSource).not.toContain("<Dialog open={statusOpen}");
    expect(actionSource).not.toContain("ProjectGitConnectDialog");
    expect(surfaceSource).toContain("ProjectGitConnectDialog");
    expect(actionSource).not.toContain("PopoverContent");
    expect(actionSource).not.toContain("SheetContent");
    expect(actionSource).not.toContain("ArrowDown01Icon");
  });

  it("keeps line changes in a compact badge without a text label", () => {
    expect(actionSource).toContain("status.additions > 0");
    expect(actionSource).toContain("status.deletions > 0");
    expect(actionSource).toContain("header-outline-control--changes");
    expect(actionSource).toContain("flex items-center gap-1");
    expect(actionSource).not.toContain("absolute -right-2 -bottom-1.5");
    expect(actionSource).toContain("repositoryLabel");
    expect(actionSource).toContain("additions");
    expect(actionSource).toContain("deletions");
    expect(actionSource).not.toContain("primaryStatusLabel");
  });

  it("uses standard completion toasts with a dynamic check count", () => {
    expect(actionSource).toContain('"Delivery complete"');
    expect(actionSource).toContain('"Delivery finished with issues"');
    expect(actionSource).toContain("${completion.passed}/${completion.total} checks passed");
    expect(actionSource).toContain("toast.success(title, options)");
    expect(actionSource).toContain("toast.error(title, options)");
    expect(actionSource).toContain('action: { label: "View"');
  });

  it("uses a compact activity-tab layout with readable file paths", () => {
    expect(panelSource).toContain('role="tablist"');
    expect(panelSource).toContain('label: "Changes"');
    expect(panelSource).toContain('label: "Commits"');
    expect(panelSource).toContain('label: "Checks"');
    expect(panelSource).toContain("Recent commits");
    expect(panelSource).toContain("status.recentCommits");
    expect(panelSource).toContain("status.files.map");
    expect(panelSource).toContain("pathParts(file.path)");
    expect(panelSource).toContain("onOpenFile?.(file.path)");
    expect(panelSource).not.toContain("font-mono");
    expect(panelSource).not.toContain("Status for {commit.shortHash}");
  });
});
