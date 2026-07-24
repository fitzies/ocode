import type { AnvilClientCommand, AnvilCommandResponse } from "@anvil/protocol";

import type { ThreadCache } from "./threadCache";

export interface QueuedPrompt {
  command: Extract<AnvilClientCommand, { type: "prompt.send" }>;
  content: string;
}

export interface PromptOutboxOptions {
  cache: ThreadCache;
  send(command: QueuedPrompt["command"]): Promise<AnvilCommandResponse | undefined>;
  onRejected(sessionId: string, prompt: QueuedPrompt, response: AnvilCommandResponse): void;
}

/** Durable, per-session FIFO for prompts. Unknown outcomes are rejected, never replayed blindly. */
export class PromptOutbox {
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly drainingSessions = new Set<string>();
  private readonly completions = new Map<string, (accepted: boolean) => void>();

  constructor(private readonly options: PromptOutboxOptions) {}

  async restore(): Promise<void> {
    for (const prompt of await this.options.cache.readPromptOutbox()) {
      const sessionId = prompt.command.sessionId;
      if (!sessionId) continue;
      const existing = this.queues.get(sessionId) ?? [];
      if (!existing.some((candidate) => candidate.command.id === prompt.command.id)) {
        this.queues.set(sessionId, [...existing, prompt]);
      }
    }
  }

  enqueue(prompt: QueuedPrompt): Promise<boolean> {
    const sessionId = prompt.command.sessionId;
    if (!sessionId) return Promise.resolve(false);
    this.queues.set(sessionId, [...(this.queues.get(sessionId) ?? []), prompt]);
    void this.persist();
    return new Promise<boolean>((resolve) => this.completions.set(prompt.command.id, resolve));
  }

  drain(sessionId: string): void {
    if (this.drainingSessions.has(sessionId) || !(this.queues.get(sessionId)?.length)) return;
    this.drainingSessions.add(sessionId);
    void this.drainQueue(sessionId);
  }

  rejectSession(sessionId: string): string | undefined {
    const queued = this.queues.get(sessionId);
    this.queues.delete(sessionId);
    for (const prompt of queued ?? []) {
      this.completions.get(prompt.command.id)?.(false);
      this.completions.delete(prompt.command.id);
    }
    void this.persist();
    const content = queued?.map((item) => item.content).join("\n\n");
    return content || undefined;
  }

  has(sessionId: string): boolean {
    return Boolean(this.queues.get(sessionId)?.length);
  }

  queued(): QueuedPrompt[] {
    return [...this.queues.values()].flat();
  }

  private async drainQueue(sessionId: string): Promise<void> {
    let retry = false;
    try {
      while (true) {
        const prompt = this.queues.get(sessionId)?.[0];
        if (!prompt) break;
        const response = await this.options.send(prompt.command);
        if (!response) {
          retry = true;
          break;
        }
        const remaining = (this.queues.get(sessionId) ?? []).filter(
          (candidate) => candidate.command.id !== prompt.command.id,
        );
        if (remaining.length > 0) this.queues.set(sessionId, remaining);
        else this.queues.delete(sessionId);
        if (!response.success) this.options.onRejected(sessionId, prompt, response);
        this.completions.get(prompt.command.id)?.(response.success);
        this.completions.delete(prompt.command.id);
        await this.persist();
      }
    } finally {
      this.drainingSessions.delete(sessionId);
      if (retry) setTimeout(() => this.drain(sessionId), 1_000);
      else if (this.queues.get(sessionId)?.length) this.drain(sessionId);
    }
  }

  private async persist(): Promise<void> {
    await this.options.cache.writePromptOutbox([...this.queues.values()].flat());
  }
}
