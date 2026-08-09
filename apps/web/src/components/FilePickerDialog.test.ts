import { describe, expect, it } from "vitest";

import { richPreviewKind } from "./FilePickerDialog";

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
});
