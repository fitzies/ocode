import {
  ANVIL_PROTOCOL_VERSION,
  isAnvilSessionDetail,
  isAnvilSummaryBootstrap,
  type AnvilClientCommand,
  type AnvilSessionDetail,
  type AnvilSummaryBootstrap,
} from "@anvil/protocol";

import type { WorkspaceLocation } from "./workspace";

const DATABASE_NAME = "ocode-thread-cache";
const LEGACY_DATABASE_NAME = "anvil-thread-cache";
const DATABASE_VERSION = 1;
const DETAIL_STORE = "details";
const META_STORE = "meta";
const MAX_MEMORY_THREADS = 8;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MEMORY_TTL_MS = 5 * 60_000;
const MAX_PERSISTED_THREADS = 50;
const MAX_PERSISTED_BYTES = 200 * 1024 * 1024;

interface DetailRecord {
  sessionId: string;
  detail: AnvilSessionDetail;
  persistedAt: number;
  lastAccessedAt: number;
  bytes: number;
}

interface ShellRecord {
  key: "shell";
  bootstrap: AnvilSummaryBootstrap;
  activeSessionId: string | null;
  workspaceLocation?: WorkspaceLocation | null;
  persistedAt: number;
}

export interface PersistedQueuedPrompt {
  command: Extract<AnvilClientCommand, { type: "prompt.send" }>;
  content: string;
}

interface OutboxRecord {
  key: "prompt-outbox";
  prompts: PersistedQueuedPrompt[];
}

interface MemoryRecord {
  detail: AnvilSessionDetail;
  lastAccessedAt: number;
  bytes: number;
}

function estimateBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function databaseIsEmpty(database: IDBDatabase): Promise<boolean> {
  const transaction = database.transaction([DETAIL_STORE, META_STORE], "readonly");
  const [details, metadata] = await Promise.all([
    requestValue(transaction.objectStore(DETAIL_STORE).count()),
    requestValue(transaction.objectStore(META_STORE).count()),
  ]);
  return details === 0 && metadata === 0;
}

async function legacyDatabaseExists(): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true;
  try {
    return (await indexedDB.databases()).some((database) => database.name === LEGACY_DATABASE_NAME);
  } catch {
    return true;
  }
}

function openLegacyDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

async function migrateLegacyDatabase(database: IDBDatabase): Promise<void> {
  if (!await databaseIsEmpty(database) || !await legacyDatabaseExists()) return;
  const legacy = await openLegacyDatabase();
  if (!legacy) return;
  try {
    if (!legacy.objectStoreNames.contains(DETAIL_STORE) || !legacy.objectStoreNames.contains(META_STORE)) return;
    const legacyTransaction = legacy.transaction([DETAIL_STORE, META_STORE], "readonly");
    const [details, metadata] = await Promise.all([
      requestValue(legacyTransaction.objectStore(DETAIL_STORE).getAll()),
      requestValue(legacyTransaction.objectStore(META_STORE).getAll()),
    ]);
    if (details.length === 0 && metadata.length === 0) return;
    // A second emptiness check prevents migration from overwriting data written
    // by another tab while the legacy database was being read.
    if (!await databaseIsEmpty(database)) return;
    const copy = database.transaction([DETAIL_STORE, META_STORE], "readwrite");
    const detailStore = copy.objectStore(DETAIL_STORE);
    const metaStore = copy.objectStore(META_STORE);
    for (const record of details) detailStore.put(record);
    for (const record of metadata) metaStore.put(record);
    await transactionDone(copy);
  } finally {
    legacy.close();
  }
}

export class ThreadCache {
  private databasePromise?: Promise<IDBDatabase | undefined>;
  private readonly memory = new Map<string, MemoryRecord>();

  async readShell(): Promise<{
    bootstrap: AnvilSummaryBootstrap;
    activeSessionId: string | null;
    workspaceLocation?: WorkspaceLocation | null;
  } | undefined> {
    const database = await this.database();
    if (!database) return undefined;
    try {
      const transaction = database.transaction(META_STORE, "readonly");
      const record = await requestValue(transaction.objectStore(META_STORE).get("shell")) as ShellRecord | undefined;
      if (!record || !isAnvilSummaryBootstrap(record.bootstrap)) return undefined;
      return {
        bootstrap: record.bootstrap,
        activeSessionId: record.activeSessionId,
        workspaceLocation: record.workspaceLocation,
      };
    } catch {
      return undefined;
    }
  }

  async writeShell(
    bootstrap: AnvilSummaryBootstrap,
    activeSessionId: string | null,
    workspaceLocation?: WorkspaceLocation | null,
  ): Promise<void> {
    if (!isAnvilSummaryBootstrap(bootstrap)) return;
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction(META_STORE, "readwrite");
      transaction.objectStore(META_STORE).put({
        key: "shell",
        bootstrap,
        activeSessionId,
        workspaceLocation,
        persistedAt: Date.now(),
      } satisfies ShellRecord);
      await transactionDone(transaction);
    } catch {
      // Cache persistence must never block Forge.
    }
  }

  async readDetail(sessionId: string): Promise<AnvilSessionDetail | undefined> {
    const now = Date.now();
    const memory = this.memory.get(sessionId);
    if (memory && now - memory.lastAccessedAt <= MEMORY_TTL_MS) {
      memory.lastAccessedAt = now;
      this.memory.delete(sessionId);
      this.memory.set(sessionId, memory);
      return structuredClone(memory.detail);
    }
    if (memory) this.memory.delete(sessionId);

    const database = await this.database();
    if (!database) return undefined;
    try {
      const transaction = database.transaction(DETAIL_STORE, "readwrite");
      const store = transaction.objectStore(DETAIL_STORE);
      const record = await requestValue(store.get(sessionId)) as DetailRecord | undefined;
      if (!record || !isAnvilSessionDetail(record.detail)) {
        if (record) store.delete(sessionId);
        await transactionDone(transaction);
        return undefined;
      }
      record.lastAccessedAt = now;
      store.put(record);
      await transactionDone(transaction);
      this.remember(record.detail, record.bytes, now);
      return structuredClone(record.detail);
    } catch {
      return undefined;
    }
  }

  async writeDetail(detail: AnvilSessionDetail): Promise<void> {
    if (!isAnvilSessionDetail(detail) || detail.runState === "running") return;
    const now = Date.now();
    const bytes = estimateBytes(detail);
    this.remember(detail, bytes, now);
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction(DETAIL_STORE, "readwrite");
      transaction.objectStore(DETAIL_STORE).put({
        sessionId: detail.sessionId,
        detail,
        persistedAt: now,
        lastAccessedAt: now,
        bytes,
      } satisfies DetailRecord);
      await transactionDone(transaction);
      await this.prunePersistent(database);
    } catch {
      // Quota/private-mode failures fall back to the bounded memory cache.
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.memory.delete(sessionId);
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction(DETAIL_STORE, "readwrite");
      transaction.objectStore(DETAIL_STORE).delete(sessionId);
      await transactionDone(transaction);
    } catch {
      // Best-effort invalidation.
    }
  }

  async readPromptOutbox(): Promise<PersistedQueuedPrompt[]> {
    const database = await this.database();
    if (!database) return [];
    try {
      const transaction = database.transaction(META_STORE, "readonly");
      const record = await requestValue(transaction.objectStore(META_STORE).get("prompt-outbox")) as OutboxRecord | undefined;
      return record?.prompts ?? [];
    } catch {
      return [];
    }
  }

  async writePromptOutbox(prompts: PersistedQueuedPrompt[]): Promise<void> {
    const database = await this.database();
    if (!database) return;
    try {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      if (prompts.length > 0) store.put({ key: "prompt-outbox", prompts } satisfies OutboxRecord);
      else store.delete("prompt-outbox");
      await transactionDone(transaction);
    } catch {
      // The in-memory outbox remains available for this tab.
    }
  }

  private remember(detail: AnvilSessionDetail, bytes: number, now: number): void {
    this.memory.delete(detail.sessionId);
    this.memory.set(detail.sessionId, { detail: structuredClone(detail), bytes, lastAccessedAt: now });
    for (const [sessionId, record] of this.memory) {
      if (now - record.lastAccessedAt > MEMORY_TTL_MS) this.memory.delete(sessionId);
    }
    let totalBytes = [...this.memory.values()].reduce((total, record) => total + record.bytes, 0);
    while (this.memory.size > MAX_MEMORY_THREADS || totalBytes > MAX_MEMORY_BYTES) {
      const oldest = this.memory.entries().next().value as [string, MemoryRecord] | undefined;
      if (!oldest) break;
      this.memory.delete(oldest[0]);
      totalBytes -= oldest[1].bytes;
    }
  }

  private async database(): Promise<IDBDatabase | undefined> {
    if (typeof indexedDB === "undefined") return undefined;
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(DETAIL_STORE)) {
            database.createObjectStore(DETAIL_STORE, { keyPath: "sessionId" });
          }
          if (!database.objectStoreNames.contains(META_STORE)) {
            database.createObjectStore(META_STORE, { keyPath: "key" });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          void migrateLegacyDatabase(database).then(
            () => resolve(database),
            () => resolve(database),
          );
        };
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
      });
    }
    return this.databasePromise;
  }

  private async prunePersistent(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction(DETAIL_STORE, "readwrite");
    const store = transaction.objectStore(DETAIL_STORE);
    const records = await requestValue(store.getAll()) as DetailRecord[];
    records.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
    let retainedBytes = 0;
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      retainedBytes += record.bytes;
      if (index >= MAX_PERSISTED_THREADS || retainedBytes > MAX_PERSISTED_BYTES) {
        store.delete(record.sessionId);
      }
    }
    await transactionDone(transaction);
  }
}

export function summaryBootstrapFromSnapshot(
  capturedAt: string,
  connection: AnvilSummaryBootstrap["connection"],
  projects: AnvilSummaryBootstrap["projects"],
  sessions: AnvilSummaryBootstrap["sessions"],
  cursor: number,
): AnvilSummaryBootstrap {
  return {
    protocolVersion: ANVIL_PROTOCOL_VERSION,
    capturedAt,
    connection,
    projects,
    sessions,
    cursor,
  };
}
