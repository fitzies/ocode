export interface NavigableThread {
  id: string;
  projectId: string;
  settled?: boolean;
}

export function numberedThreadTarget<T extends NavigableThread>(
  orderedThreads: readonly T[],
  index: number,
): T | undefined {
  return orderedThreads.filter((thread) => !thread.settled)[index];
}

export function cycledThreadTarget<T extends NavigableThread>(
  orderedThreads: readonly T[],
  projectId: string | undefined,
  activeThreadId: string | null | undefined,
  direction: "next" | "previous",
): T | undefined {
  if (!projectId) return undefined;

  const candidates = orderedThreads.filter(
    (thread) => !thread.settled && thread.projectId === projectId,
  );
  if (!candidates.length) return undefined;

  const activeIndex = candidates.findIndex((thread) => thread.id === activeThreadId);
  if (activeIndex === -1) return direction === "next" ? candidates[0] : candidates.at(-1);

  const offset = direction === "next" ? 1 : -1;
  return candidates[(activeIndex + offset + candidates.length) % candidates.length];
}
