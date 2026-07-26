import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function pathIsInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export type SecureOpenedPath = {
  handle: FileHandle;
  canonicalPath: string;
  file: Awaited<ReturnType<FileHandle["stat"]>>;
};

/**
 * Opens one already-normalized relative path without blocking on FIFOs, then
 * binds containment to the opened descriptor. Forge's file service fails
 * closed outside Linux because pathname-based portable fallbacks cannot close
 * parent-directory symlink races without openat-style descriptor traversal.
 */
export async function secureOpenProjectPath(
  canonicalRoot: string,
  relativePath: string,
): Promise<SecureOpenedPath> {
  if (process.platform !== "linux") throw new Error("secure_open_unsupported");
  const lexicalPath = relativePath ? resolve(canonicalRoot, ...relativePath.split("/")) : canonicalRoot;
  if (!pathIsInside(canonicalRoot, lexicalPath)) throw new Error("path_outside_project");

  let handle: FileHandle | undefined;
  try {
    handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const canonicalPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!pathIsInside(canonicalRoot, canonicalPath)) throw new Error("path_outside_project");
    return { handle, canonicalPath, file: await handle.stat() };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}
