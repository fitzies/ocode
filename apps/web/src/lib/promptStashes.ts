export const PROMPT_STASH_STORAGE_KEY = "ocode.prompt-stashes";
export const MAX_PROMPT_STASHES = 20;

export type PromptStash = {
  id: string;
  text: string;
  createdAt: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type PersistedPromptStashes = {
  version: 1;
  stashes: PromptStash[];
};

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function validStash(value: unknown): value is PromptStash {
  if (!value || typeof value !== "object") return false;
  const stash = value as Partial<PromptStash>;
  return typeof stash.id === "string"
    && typeof stash.text === "string"
    && typeof stash.createdAt === "string";
}

export function loadPromptStashes(storage = browserStorage()): PromptStash[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PROMPT_STASH_STORAGE_KEY) ?? "null") as Partial<PersistedPromptStashes> | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.stashes)) return [];
    return parsed.stashes.filter(validStash).slice(0, MAX_PROMPT_STASHES);
  } catch {
    return [];
  }
}

export function savePromptStashes(stashes: readonly PromptStash[], storage = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const payload: PersistedPromptStashes = {
      version: 1,
      stashes: stashes.slice(0, MAX_PROMPT_STASHES),
    };
    storage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function prependPromptStash(
  stashes: readonly PromptStash[],
  text: string,
  options: { id?: string; createdAt?: string } = {},
): PromptStash[] {
  const id = options.id ?? crypto.randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  return [{ id, text, createdAt }, ...stashes].slice(0, MAX_PROMPT_STASHES);
}
