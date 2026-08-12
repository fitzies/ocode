import { describe, expect, it } from "vitest";

const nodeFsSpecifier = "node:fs";
const { readFileSync } = await import(nodeFsSpecifier);
const actionSource = readFileSync(new URL("./ProjectGitAction.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("./ProjectGitStatusPanel.tsx", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");

describe("ProjectGitAction Mira header control", () => {
  it("uses the shared outline button instead of the bespoke segmented repository control", () => {
    expect(actionSource).toContain('variant="outline"');
    expect(actionSource).toContain("repository-header-button");
    expect(actionSource).not.toContain("repository-status-trigger");
    expect(actionSource).not.toContain("repository-inline-action");
    expect(shellStyles).not.toContain(".repository-status-trigger");
    expect(shellStyles).not.toContain(".repository-inline-action");
  });

  it("opens repository status in the shared dialog without a dropdown chevron", () => {
    expect(actionSource).toContain("<Dialog open={statusOpen}");
    expect(actionSource).toContain("<DialogTrigger asChild>{trigger}</DialogTrigger>");
    expect(actionSource).not.toContain("PopoverContent");
    expect(actionSource).not.toContain("SheetContent");
    expect(actionSource).not.toContain("ArrowDown01Icon");
  });

  it("stays compact on narrow screens", () => {
    expect(actionSource).toContain("max-[420px]:hidden");
  });

  it("uses standard completion toasts with a dynamic check count", () => {
    expect(actionSource).toContain('"Delivery complete"');
    expect(actionSource).toContain('"Delivery finished with issues"');
    expect(actionSource).toContain("${completion.passed}/${completion.total} checks passed");
    expect(actionSource).toContain("toast.success(title, options)");
    expect(actionSource).toContain("toast.error(title, options)");
    expect(actionSource).toContain('action: { label: "View"');
  });

  it("keeps the repository dialog compact and avoids repeated commit metadata", () => {
    expect(actionSource).toContain("!max-w-[28rem]");
    expect(panelSource).not.toContain("Status for {commit.shortHash}");
    expect(panelSource).not.toContain("not included in this delivery");
    expect(panelSource).not.toContain(">Commit<HugeiconsIcon");
  });
});
