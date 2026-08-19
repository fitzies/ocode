import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import type { PiCatalog, PiCatalogItem } from "@anvil/protocol";

const MAX_SKILL_HEADER_BYTES = 16 * 1024;
const EXTENSION_SUFFIXES = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);

function displayPath(agentRoot: string, path: string): string {
  return `~/.pi/agent/${path.slice(agentRoot.length + 1).replaceAll("\\", "/")}`;
}

async function skillMetadata(path: string): Promise<{ name?: string; description?: string }> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_SKILL_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text)?.[1];
    if (!frontmatter) return {};
    const name = /^name:\s*["']?([^\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
    const description = /^description:\s*["']?([^\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
    return { name, description };
  } catch {
    return {};
  } finally {
    await handle?.close();
  }
}

async function discoverSkills(root: string, agentRoot: string): Promise<PiCatalogItem[]> {
  const items: PiCatalogItem[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || items.length >= 500) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || items.length >= 500) continue;
      const path = join(directory, entry.name);
      const isSkill = entry.isFile() && (entry.name === "SKILL.md" || (depth === 0 && extname(entry.name) === ".md"));
      if (isSkill) {
        const [metadata, fileStat] = await Promise.all([skillMetadata(path), stat(path)]);
        items.push({
          kind: "skill",
          name: metadata.name ?? (entry.name === "SKILL.md" ? basename(directory) : basename(entry.name, ".md")),
          description: metadata.description,
          path: displayPath(agentRoot, path),
          modifiedAt: fileStat.mtime.toISOString(),
        });
      } else if (entry.isDirectory()) {
        await walk(path, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverExtensions(root: string, agentRoot: string): Promise<PiCatalogItem[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const items: PiCatalogItem[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || items.length >= 500) continue;
    let path: string | undefined;
    if (entry.isFile() && EXTENSION_SUFFIXES.has(extname(entry.name))) path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const filename of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
        const candidate = join(root, entry.name, filename);
        try { if ((await lstat(candidate)).isFile()) { path = candidate; break; } } catch { /* keep looking */ }
      }
    }
    if (!path) continue;
    const fileStat = await stat(path);
    items.push({
      kind: "extension",
      name: entry.isDirectory() ? entry.name : basename(entry.name, extname(entry.name)),
      path: displayPath(agentRoot, path),
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export class PiCatalogService {
  private readonly agentRoot: string;

  constructor(options: { agentRoot?: string; environment?: NodeJS.ProcessEnv } = {}) {
    const environment = options.environment ?? process.env;
    this.agentRoot = resolve(options.agentRoot ?? environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  }

  async catalog(): Promise<PiCatalog> {
    const skillsRoot = join(this.agentRoot, "skills");
    const extensionsRoot = join(this.agentRoot, "extensions");
    const [skills, extensions] = await Promise.all([
      discoverSkills(skillsRoot, this.agentRoot),
      discoverExtensions(extensionsRoot, this.agentRoot),
    ]);
    return {
      skillsRoot: "~/.pi/agent/skills",
      extensionsRoot: "~/.pi/agent/extensions",
      skills,
      extensions,
    };
  }
}
