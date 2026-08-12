import { describe, expect, it } from "vitest";

import { richPreviewKind, sortFilesByChangedLines } from "./FilePickerDialog";

describe("file picker preview choices", () => {
  it("offers rendered and source views for Markdown and HTML files", () => {
    expect(richPreviewKind("README.md")).toBe("markdown");
    expect(richPreviewKind("docs/guide.MDX")).toBe("markdown");
    expect(richPreviewKind("artifacts/report.html")).toBe("html");
    expect(richPreviewKind("public/index.HTM")).toBe("html");
  });

  it("opens ordinary files directly", () => {
    expect(richPreviewKind("src/main.ts")).toBeUndefined();
    expect(richPreviewKind("assets/screenshot.png")).toBeUndefined();
  });

  it("sorts the initial list by total changed lines and preserves ties", () => {
    const files = [
      { path: "unchanged.ts" },
      { path: "small.ts" },
      { path: "also-small.ts" },
    ];
    const diffs = new Map([
      ["small.ts", { additions: 2, deletions: 1 }],
      ["large.ts", { additions: 8, deletions: 4 }],
      ["also-small.ts", { additions: 1, deletions: 2 }],
    ]);

    expect(sortFilesByChangedLines(files, diffs).map((file) => file.path)).toEqual([
      "large.ts",
      "small.ts",
      "also-small.ts",
      "unchanged.ts",
    ]);
  });
});
