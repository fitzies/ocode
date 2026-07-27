import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireForgeInstanceLock,
  databaseLockPath,
  ForgeInstanceLockedError,
} from "./instanceLock.ts";

const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "anvil-instance-lock-"));
  directories.push(directory);
  return join(directory, "forge.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Forge instance lock", () => {
  it("prevents two Forge instances from owning one database", () => {
    const databasePath = temporaryDatabase();
    const first = acquireForgeInstanceLock(databasePath);

    expect(() => acquireForgeInstanceLock(databasePath)).toThrow(ForgeInstanceLockedError);

    first.release();
    const replacement = acquireForgeInstanceLock(databasePath);
    replacement.release();
  });

  it("leaves a reusable sidecar after releasing the kernel lock", () => {
    const databasePath = temporaryDatabase();
    const first = acquireForgeInstanceLock(databasePath);
    first.release();

    expect(existsSync(databaseLockPath(databasePath))).toBe(true);
    const replacement = acquireForgeInstanceLock(databasePath);
    replacement.release();
  });
});
