import { describe, expect, it } from "vitest";

import { DEFAULT_THREAD_CLOSE_ACTION } from "./SettleOrDeleteThreadDialog";

describe("Cmd+W thread action", () => {
  it("defaults to settling rather than destructive deletion", () => {
    expect(DEFAULT_THREAD_CLOSE_ACTION).toBe("settle");
  });
});
