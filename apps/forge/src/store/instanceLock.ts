import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";

// Keep the specifier indirect until tsup's esbuild recognizes node:sqlite as a built-in.
const sqliteModuleName = "node:sqlite";
const { DatabaseSync } = await import(sqliteModuleName) as typeof import("node:sqlite");

function canonicalDatabasePath(databasePath: string): string {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  return existsSync(databasePath)
    ? realpathSync(databasePath)
    : join(realpathSync(dirname(databasePath)), basename(databasePath));
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

export class ForgeInstanceLockedError extends Error {
  constructor(databasePath: string) {
    super(`Another Anvil Forge process already owns the database: ${databasePath}`);
    this.name = "ForgeInstanceLockedError";
  }
}

/**
 * A dedicated SQLite database provides a kernel-backed process-lifetime lock.
 * SQLite releases the exclusive lock automatically if Forge crashes or is killed.
 */
export class ForgeInstanceLock {
  private released = false;

  constructor(private readonly database: DatabaseSyncInstance) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}

export function databaseLockPath(databasePath: string): string {
  return `${canonicalDatabasePath(databasePath)}.instance-lock.sqlite`;
}

export function acquireForgeInstanceLock(databasePath: string): ForgeInstanceLock {
  const canonicalPath = canonicalDatabasePath(databasePath);
  const lockPath = `${canonicalPath}.instance-lock.sqlite`;
  const database = new DatabaseSync(lockPath);
  chmodSync(lockPath, 0o600);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return new ForgeInstanceLock(database);
  } catch (error) {
    database.close();
    if (isBusy(error)) throw new ForgeInstanceLockedError(canonicalPath);
    throw error;
  }
}
