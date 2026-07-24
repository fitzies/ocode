import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_INDEXED_FILES = 20_000;
const MAX_QUERY_CANDIDATES = 2_000;
const CACHE_MS = 5_000;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fuzzyPattern(query: string): string {
  return [...query.replace(/\\/g, "/")].map(escapeRegex).join(".*");
}

function fuzzyScore(path: string, query: string): number {
  if (!query) return 1;
  const target = path.toLowerCase();
  const needle = query.toLowerCase();
  const basename = target.slice(target.lastIndexOf("/") + 1);
  if (basename.startsWith(needle)) return 2_000 - path.length;
  const substring = target.indexOf(needle);
  if (substring >= 0) return 1_200 - substring - path.length / 100;
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const index = target.indexOf(character, cursor);
    if (index < 0) return -1;
    score += index === previous + 1 ? 9 : 3;
    if (index === 0 || target[index - 1] === "/" || target[index - 1] === "-" || target[index - 1] === "_") score += 7;
    previous = index;
    cursor = index + 1;
  }
  return score - path.length / 100;
}

async function listWithFd(root: string, query: string): Promise<string[] | undefined> {
  const args = [
    "--base-directory", root,
    "--max-results", String(query ? MAX_QUERY_CANDIDATES : MAX_INDEXED_FILES),
    "--type", "f",
    "--hidden",
    "--exclude", ".git",
    "--exclude", ".git/*",
    "--exclude", ".git/**",
  ];
  if (query) args.push("--full-path", fuzzyPattern(query));
  for (const executable of ["fd", "fdfind"]) {
    try {
      const { stdout } = await execFileAsync(executable, args, { maxBuffer: 8 * 1024 * 1024 });
      return stdout.split("\n").map((line) => line.trim().replace(/\\/g, "/")).filter(Boolean);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return [];
    }
  }
  return undefined;
}

async function listWithGit(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\n").map((line) => line.trim().replace(/\\/g, "/")).filter(Boolean);
  } catch {
    return undefined;
  }
}

async function listWithNode(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_INDEXED_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) break;
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return files;
}

export class WorkspaceFileIndex {
  private readonly cache = new Map<string, { expiresAt: number; files: string[] }>();

  async search(root: string, query: string, limit: number): Promise<string[]> {
    const cacheKey = `${root}\0${query.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    let files: string[];
    if (cached && cached.expiresAt > Date.now()) {
      files = cached.files;
    } else {
      files = await listWithFd(root, query) ?? await listWithGit(root) ?? await listWithNode(root);
      this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, files });
    }
    return files
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((candidate) => candidate.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((candidate) => candidate.path);
  }
}
