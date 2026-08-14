import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_STASHES,
  PROMPT_STASH_STORAGE_KEY,
  loadPromptStashes,
  prependPromptStash,
  savePromptStashes,
} from "./promptStashes";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(PROMPT_STASH_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("prompt stashes", () => {
  it("keeps exact message text and puts the newest stash first", () => {
    const first = prependPromptStash([], "first", { id: "first", createdAt: "2026-01-01T00:00:00.000Z" });
    const stashes = prependPromptStash(first, "  second\nline  ", { id: "second", createdAt: "2026-01-02T00:00:00.000Z" });

    expect(stashes.map((stash) => stash.id)).toEqual(["second", "first"]);
    expect(stashes[0]?.text).toBe("  second\nline  ");
  });

  it("persists a bounded, versioned list", () => {
    const storage = memoryStorage();
    const stashes = Array.from({ length: MAX_PROMPT_STASHES + 3 }, (_, index) => ({
      id: String(index),
      text: `message ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    expect(savePromptStashes(stashes, storage)).toBe(true);
    expect(loadPromptStashes(storage)).toHaveLength(MAX_PROMPT_STASHES);
    expect(loadPromptStashes(storage).at(-1)?.id).toBe(String(MAX_PROMPT_STASHES - 1));
  });

  it("fails closed for malformed data or rejected writes", () => {
    expect(loadPromptStashes(memoryStorage("not-json"))).toEqual([]);
    expect(savePromptStashes([], {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    })).toBe(false);
  });
});
