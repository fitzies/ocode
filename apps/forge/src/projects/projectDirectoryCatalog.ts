import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectDirectoryCatalog } from "@anvil/protocol";

export const PROJECT_DIRECTORY_LIMIT = 200;

/** Lists direct, real directory children of an already-canonical projects root. */
export async function listUnregisteredProjectDirectories(
  projectsRoot: string,
  registeredPaths: readonly string[],
): Promise<ProjectDirectoryCatalog> {
  const registered = new Set(registeredPaths);
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const directories: ProjectDirectoryCatalog["directories"] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(projectsRoot, entry.name);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      const canonicalPath = await realpath(candidate);
      if (dirname(canonicalPath) !== projectsRoot || registered.has(canonicalPath)) continue;
      directories.push({ name: entry.name, path: canonicalPath });
    } catch {
      // Entries may disappear or become inaccessible while the root is being read.
    }
  }

  directories.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { directories: directories.slice(0, PROJECT_DIRECTORY_LIMIT) };
}
