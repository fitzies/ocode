import { describe, expect, it } from "vitest";

import { normalizeCommitMessage } from "./commitMessageGenerator.ts";

describe("normalizeCommitMessage", () => {
  it("extracts a single plain subject and enforces the Git subject limit", () => {
    expect(normalizeCommitMessage("```text\nAdd project Git push action\n```"))
      .toBe("Add project Git push action");
    expect(normalizeCommitMessage(`Commit message: ${"x".repeat(90)}`)).toHaveLength(72);
  });

  it("rejects empty output", () => {
    expect(() => normalizeCommitMessage("  \n ")).toThrow("valid commit subject");
  });
});
