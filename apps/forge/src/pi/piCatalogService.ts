import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import type { PiCatalog, PiCatalogItem, PiCatalogItemKind, PiResourceContent } from "@anvil/protocol";

import { pathIsInside, secureOpenProjectPath } from "../files/secureProjectPath.ts";

const MAX_SKILL_HEADER_BYTES = 16 * 1024;
const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_PACKAGE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_PACKAGE_FILES = 256;
const MAX_SKILL_PACKAGE_DEPTH = 8;
const EXTENSION_SUFFIXES = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
const RESOURCE_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export class PiResourceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

function etag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}"`;
}

function validName(name: unknown): string {
  if (typeof name !== "string" || !RESOURCE_NAME.test(name)) {
    throw new PiResourceError("invalid_resource_name", "Names must use lowercase letters, numbers, and single hyphens");
  }
  return name;
}

function validId(id: unknown): string {
  if (typeof id !== "string" || !id || id.length > 500 || id.startsWith("/") || id.includes("\\") || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new PiResourceError("invalid_resource_id", "Resource id is malformed");
  }
  const parts = id.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new PiResourceError("invalid_resource_id", "Resource id is malformed");
  }
  return parts.join("/");
}

function displayPath(kind: PiCatalogItemKind, root: string, path: string): string {
  const directory = kind === "skill" ? "skills" : "extensions";
  return `~/.pi/agent/${directory}/${relative(root, path).replaceAll(sep, "/")}`;
}

function withSkillName(text: string, name: string): string {
  return text.replace(/^(---\s*\n[\s\S]*?^name:\s*)[^\n]+/m, `$1${name}`);
}

function processPath(handle: FileHandle, child?: string): string {
  return child ? `/proc/self/fd/${handle.fd}/${child}` : `/proc/self/fd/${handle.fd}`;
}

function sameFile(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<FileHandle["stat"]>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new PiResourceError("resource_exists", "A skill with this name already exists", 409);
  } catch (error) {
    if (error instanceof PiResourceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readPrefix(handle: FileHandle, maximum: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximum);
  let position = 0;
  while (position < maximum) {
    const { bytesRead } = await handle.read(buffer, position, maximum - position, position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  return buffer.subarray(0, position);
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
  const initial = await handle.stat();
  if (initial.size > maximum) throw new PiResourceError("resource_too_large", `Resource exceeds the ${maximum === MAX_RESOURCE_BYTES ? "512 KiB edit" : "package file"} limit`, 413);
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maximum) {
    const size = Math.min(64 * 1024, maximum + 1 - position);
    if (size <= 0) break;
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position > maximum) throw new PiResourceError("resource_too_large", `Resource exceeds the ${maximum === MAX_RESOURCE_BYTES ? "512 KiB edit" : "package file"} limit`, 413);
  return Buffer.concat(chunks, position);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PiResourceError("invalid_resource_text", "Resource is not valid UTF-8 text", 415);
  }
}

async function openCatalogFile(root: string, id: string, maximum?: number): Promise<{ bytes: Buffer; file: Awaited<ReturnType<FileHandle["stat"]>> } | undefined> {
  let target: Awaited<ReturnType<typeof secureOpenProjectPath>> | undefined;
  try {
    target = await secureOpenProjectPath(root, id);
    const expected = resolve(root, ...id.split("/"));
    if (target.canonicalPath !== expected || !target.file.isFile()) return undefined;
    return { bytes: maximum === undefined ? Buffer.alloc(0) : await readPrefix(target.handle, maximum), file: target.file };
  } catch {
    return undefined;
  } finally {
    await target?.handle.close().catch(() => undefined);
  }
}

function skillMetadata(bytes: Buffer): { name?: string; description?: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(bytes.toString("utf8"))?.[1];
  if (!frontmatter) return {};
  const name = /^name:\s*["']?([^\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
  const rawDescription = /^description:\s*(.+)\s*$/m.exec(frontmatter)?.[1]?.trim();
  let description = rawDescription;
  if (rawDescription?.startsWith("\"") && rawDescription.endsWith("\"")) {
    try {
      description = JSON.parse(rawDescription) as string;
    } catch {
      // Keep an invalid quoted scalar visible instead of hiding the skill.
    }
  } else if (rawDescription?.startsWith("'") && rawDescription.endsWith("'")) {
    description = rawDescription.slice(1, -1);
  }
  return { name, description };
}

async function discoverSkills(root: string): Promise<PiCatalogItem[]> {
  const items: PiCatalogItem[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_PACKAGE_DEPTH || items.length >= 500) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".ocode-") || entry.isSymbolicLink() || items.length >= 500) continue;
      const path = join(directory, entry.name);
      const isSkill = entry.isFile() && (entry.name === "SKILL.md" || (depth === 0 && extname(entry.name) === ".md"));
      if (isSkill) {
        const id = relative(root, path).replaceAll(sep, "/");
        const opened = await openCatalogFile(root, id, MAX_SKILL_HEADER_BYTES);
        if (!opened) continue;
        const metadata = skillMetadata(opened.bytes);
        items.push({
          kind: "skill",
          id,
          name: metadata.name ?? (entry.name === "SKILL.md" ? basename(directory) : basename(entry.name, ".md")),
          description: metadata.description,
          path: displayPath("skill", root, path),
          modifiedAt: opened.file.mtime.toISOString(),
        });
      } else if (entry.isDirectory()) {
        await walk(path, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverExtensions(root: string): Promise<PiCatalogItem[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const items: PiCatalogItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".ocode-") || entry.isSymbolicLink() || items.length >= 500) continue;
    const candidates = entry.isFile() && EXTENSION_SUFFIXES.has(extname(entry.name))
      ? [entry.name]
      : entry.isDirectory()
        ? ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"].map((filename) => `${entry.name}/${filename}`)
        : [];
    for (const id of candidates) {
      const opened = await openCatalogFile(root, id);
      if (!opened) continue;
      const path = join(root, ...id.split("/"));
      items.push({
        kind: "extension",
        id,
        name: entry.isDirectory() ? entry.name : basename(entry.name, extname(entry.name)),
        path: displayPath("extension", root, path),
        modifiedAt: opened.file.mtime.toISOString(),
      });
      break;
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

type OpenedResource = {
  root: string;
  id: string;
  path: string;
  item: PiCatalogItem;
  handle: FileHandle;
  file: Awaited<ReturnType<FileHandle["stat"]>>;
};

type PackageBudget = { files: number; bytes: number };

export class PiCatalogService {
  private readonly agentRoot: string;
  private readonly roots: Record<PiCatalogItemKind, string>;
  private skillMutationTail: Promise<void> = Promise.resolve();

  constructor(options: { agentRoot?: string; environment?: NodeJS.ProcessEnv } = {}) {
    const environment = options.environment ?? process.env;
    this.agentRoot = resolve(options.agentRoot ?? environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
    this.roots = { skill: join(this.agentRoot, "skills"), extension: join(this.agentRoot, "extensions") };
  }

  private async canonicalRoot(kind: PiCatalogItemKind, create = false): Promise<string> {
    if (create) {
      await mkdir(this.agentRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.roots[kind], { recursive: true, mode: 0o700 });
    }
    const canonicalAgentRoot = await realpath(this.agentRoot);
    const root = await realpath(this.roots[kind]);
    if (root !== join(canonicalAgentRoot, kind === "skill" ? "skills" : "extensions")) {
      throw new PiResourceError("unsafe_resource_root", "Pi resource directories cannot be links", 415);
    }
    return root;
  }

  async catalog(): Promise<PiCatalog> {
    const [skillsRoot, extensionsRoot] = await Promise.all([
      this.canonicalRoot("skill").catch(() => undefined),
      this.canonicalRoot("extension").catch(() => undefined),
    ]);
    const [skills, extensions] = await Promise.all([
      skillsRoot ? discoverSkills(skillsRoot) : [],
      extensionsRoot ? discoverExtensions(extensionsRoot) : [],
    ]);
    return { skillsRoot: "~/.pi/agent/skills", extensionsRoot: "~/.pi/agent/extensions", skills, extensions };
  }

  private async openTarget(kind: PiCatalogItemKind, rawId: unknown): Promise<OpenedResource> {
    if (kind !== "skill" && kind !== "extension") throw new PiResourceError("invalid_resource_kind", "Resource kind is invalid");
    const id = validId(rawId);
    let root: string;
    try {
      root = await this.canonicalRoot(kind);
    } catch {
      throw new PiResourceError("resource_not_found", "Resource was not found", 404);
    }

    let target: Awaited<ReturnType<typeof secureOpenProjectPath>>;
    try {
      target = await secureOpenProjectPath(root, id);
    } catch (error) {
      if (error instanceof Error && error.message === "secure_open_unsupported") {
        throw new PiResourceError("secure_open_unsupported", "Secure Pi resource access is unavailable on this Forge host", 501);
      }
      throw new PiResourceError("resource_not_found", "Resource was not found", 404);
    }
    const path = resolve(root, ...id.split("/"));
    if (target.canonicalPath !== path || !target.file.isFile()) {
      await target.handle.close();
      throw new PiResourceError("unsafe_resource", "Resource links and special files are not supported", 415);
    }
    const discovered = kind === "skill" ? await discoverSkills(root) : await discoverExtensions(root);
    const item = discovered.find((entry) => entry.id === id);
    if (!item) {
      await target.handle.close();
      throw new PiResourceError("resource_not_found", "Resource was not found", 404);
    }
    return { root, id, path, item, handle: target.handle, file: target.file };
  }

  async read(kind: PiCatalogItemKind, id: string): Promise<PiResourceContent> {
    const target = await this.openTarget(kind, id);
    try {
      const bytes = await readBounded(target.handle, MAX_RESOURCE_BYTES);
      return { item: target.item, text: decodeText(bytes), etag: etag(bytes) };
    } finally {
      await target.handle.close();
    }
  }

  private async mutateSkill<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.skillMutationTail;
    let release!: () => void;
    this.skillMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureSkillsRoot(): Promise<string> {
    return this.canonicalRoot("skill", true);
  }

  private async openDirectory(root: string, id: string): Promise<Awaited<ReturnType<typeof secureOpenProjectPath>>> {
    const directory = await secureOpenProjectPath(root, id);
    const expected = id ? resolve(root, ...id.split("/")) : root;
    if (directory.canonicalPath !== expected || !directory.file.isDirectory()) {
      await directory.handle.close();
      throw new PiResourceError("unsafe_resource", "Skill package directories and links are not supported", 415);
    }
    return directory;
  }

  private async assertCurrent(root: string, id: string, expected: Awaited<ReturnType<FileHandle["stat"]>>): Promise<void> {
    let current: Awaited<ReturnType<typeof secureOpenProjectPath>> | undefined;
    try {
      current = await secureOpenProjectPath(root, id);
      if (!sameFile(current.file, expected)) throw new PiResourceError("resource_changed", "Resource changed after it was opened", 409);
    } catch (error) {
      if (error instanceof PiResourceError) throw error;
      throw new PiResourceError("resource_changed", "Resource changed after it was opened", 409);
    } finally {
      await current?.handle.close().catch(() => undefined);
    }
  }

  async saveSkill(id: string, text: unknown, expectedEtag: unknown): Promise<PiResourceContent> {
    if (typeof text !== "string") throw new PiResourceError("invalid_resource_text", "Resource text is required");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_RESOURCE_BYTES) throw new PiResourceError("resource_too_large", "Resource exceeds the 512 KiB edit limit", 413);

    return this.mutateSkill(async () => {
      const target = await this.openTarget("skill", id);
      const parentId = dirname(target.id) === "." ? "" : dirname(target.id).replaceAll(sep, "/");
      const parent = await this.openDirectory(target.root, parentId);
      const temporaryName = `.ocode-${randomUUID()}.tmp`;
      const temporaryPath = processPath(parent.handle, temporaryName);
      try {
        const current = await readBounded(target.handle, MAX_RESOURCE_BYTES);
        if (typeof expectedEtag !== "string" || etag(current) !== expectedEtag) {
          throw new PiResourceError("resource_changed", "Resource changed after it was opened", 409);
        }
        let temporary: FileHandle | undefined;
        try {
          temporary = await open(temporaryPath, "wx", 0o600);
          await temporary.writeFile(bytes);
          await temporary.sync();
          await temporary.close();
          temporary = undefined;
          await this.assertCurrent(target.root, target.id, target.file);
          await rename(temporaryPath, processPath(parent.handle, basename(target.id)));
          await parent.handle.sync();
        } finally {
          await temporary?.close().catch(() => undefined);
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      } finally {
        await Promise.all([target.handle.close(), parent.handle.close()]);
      }
      return this.read("skill", id);
    });
  }

  async createSkill(rawName: unknown): Promise<PiResourceContent> {
    const name = validName(rawName);
    return this.mutateSkill(async () => {
      const root = await this.ensureSkillsRoot();
      const rootDirectory = await this.openDirectory(root, "");
      const stageName = `.ocode-${randomUUID()}.tmp`;
      const stagePath = processPath(rootDirectory.handle, stageName);
      const destination = processPath(rootDirectory.handle, name);
      try {
        await assertPathAbsent(destination);
        await mkdir(stagePath, { mode: 0o700 });
        const description = JSON.stringify(`Instructions for ${name}.`);
        await writeFile(join(stagePath, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, { mode: 0o600, flag: "wx" });
        await assertPathAbsent(destination);
        await rename(stagePath, destination);
        await rootDirectory.handle.sync();
      } finally {
        await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
        await rootDirectory.handle.close();
      }
      return this.read("skill", `${name}/SKILL.md`);
    });
  }

  private async openPackageChild(parent: Awaited<ReturnType<typeof secureOpenProjectPath>>, name: string, packageRoot: string): Promise<Awaited<ReturnType<typeof secureOpenProjectPath>>> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(processPath(parent.handle, name), constants.O_RDONLY | constants.O_NONBLOCK);
      const canonicalPath = await realpath(`/proc/self/fd/${handle.fd}`);
      const file = await handle.stat();
      if (!pathIsInside(packageRoot, canonicalPath) || canonicalPath !== resolve(parent.canonicalPath, name)) {
        throw new PiResourceError("unsafe_skill_package", "Skill packages cannot contain links", 415);
      }
      return { handle, canonicalPath, file };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async copyPackageDirectory(
    source: Awaited<ReturnType<typeof secureOpenProjectPath>>,
    packageRoot: string,
    destination: string,
    skillName: string,
    budget: PackageBudget,
    depth = 0,
  ): Promise<void> {
    if (depth > MAX_SKILL_PACKAGE_DEPTH) throw new PiResourceError("skill_package_too_large", "Skill package nesting is too deep", 413);
    const entries = await readdir(processPath(source.handle), { withFileTypes: true });
    for (const entry of entries) {
      budget.files += 1;
      if (budget.files > MAX_SKILL_PACKAGE_FILES) throw new PiResourceError("skill_package_too_large", "Skill package contains too many files", 413);
      if (entry.isSymbolicLink()) throw new PiResourceError("unsafe_skill_package", "Skill packages cannot contain links", 415);
      const opened = await this.openPackageChild(source, entry.name, packageRoot);
      try {
        const target = join(destination, entry.name);
        if (opened.file.isDirectory()) {
          await mkdir(target, { mode: 0o700 });
          await this.copyPackageDirectory(opened, packageRoot, target, skillName, budget, depth + 1);
        } else if (opened.file.isFile()) {
          const entryFile = depth === 0 && entry.name === "SKILL.md";
          let bytes = await readBounded(opened.handle, entryFile ? MAX_RESOURCE_BYTES : MAX_SKILL_PACKAGE_FILE_BYTES);
          if (entryFile) {
            bytes = Buffer.from(withSkillName(decodeText(bytes), skillName), "utf8");
            if (bytes.length > MAX_RESOURCE_BYTES) throw new PiResourceError("resource_too_large", "Resource exceeds the 512 KiB edit limit", 413);
          }
          budget.bytes += bytes.length;
          if (budget.bytes > MAX_SKILL_PACKAGE_BYTES) throw new PiResourceError("skill_package_too_large", "Skill package exceeds the 16 MiB copy limit", 413);
          await writeFile(target, bytes, { mode: (Number(opened.file.mode) & 0o700) || 0o600, flag: "wx" });
        } else {
          throw new PiResourceError("unsafe_skill_package", "Skill packages can contain only regular files and directories", 415);
        }
      } finally {
        await opened.handle.close();
      }
    }
  }

  async duplicateSkill(id: string, rawName: unknown): Promise<PiResourceContent> {
    const name = validName(rawName);
    return this.mutateSkill(async () => {
      const source = await this.openTarget("skill", id);
      const rootDirectory = await this.openDirectory(source.root, "");
      const directorySkill = basename(source.id) === "SKILL.md" && dirname(source.id) !== ".";
      const destinationName = directorySkill ? name : `${name}.md`;
      const destination = processPath(rootDirectory.handle, destinationName);
      const stageName = `.ocode-${randomUUID()}.tmp`;
      const stagePath = processPath(rootDirectory.handle, stageName);
      let packageDirectory: Awaited<ReturnType<typeof secureOpenProjectPath>> | undefined;
      try {
        await assertPathAbsent(destination);
        if (directorySkill) {
          const packageId = dirname(source.id).replaceAll(sep, "/");
          packageDirectory = await this.openDirectory(source.root, packageId);
          await mkdir(stagePath, { mode: 0o700 });
          await this.copyPackageDirectory(packageDirectory, packageDirectory.canonicalPath, stagePath, name, { files: 0, bytes: 0 });
        } else {
          const bytes = Buffer.from(withSkillName(decodeText(await readBounded(source.handle, MAX_RESOURCE_BYTES)), name), "utf8");
          await writeFile(stagePath, bytes, { mode: 0o600, flag: "wx" });
        }
        await assertPathAbsent(destination);
        await rename(stagePath, destination);
        await rootDirectory.handle.sync();
      } finally {
        await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
        await Promise.all([
          source.handle.close(),
          rootDirectory.handle.close(),
          packageDirectory?.handle.close() ?? Promise.resolve(),
        ]);
      }
      return this.read("skill", directorySkill ? `${name}/SKILL.md` : `${name}.md`);
    });
  }

  async renameSkill(id: string, rawName: unknown, expectedEtag: unknown): Promise<PiResourceContent> {
    const name = validName(rawName);
    return this.mutateSkill(async () => {
      const source = await this.openTarget("skill", id);
      const current = await readBounded(source.handle, MAX_RESOURCE_BYTES);
      if (typeof expectedEtag !== "string" || etag(current) !== expectedEtag) {
        await source.handle.close();
        throw new PiResourceError("resource_changed", "Resource changed after it was opened", 409);
      }
      const rootDirectory = await this.openDirectory(source.root, "");
      const directorySkill = basename(source.id) === "SKILL.md" && dirname(source.id) !== ".";
      const sourcePackageId = directorySkill ? dirname(source.id).replaceAll(sep, "/") : source.id;
      const destinationId = directorySkill ? name : `${name}.md`;
      const sourcePath = processPath(rootDirectory.handle, sourcePackageId);
      const destinationPath = processPath(rootDirectory.handle, destinationId);
      const updated = Buffer.from(withSkillName(decodeText(current), name), "utf8");
      let packageDirectory: Awaited<ReturnType<typeof secureOpenProjectPath>> | undefined;
      const stageName = `.ocode-${randomUUID()}.tmp`;
      try {
        await assertPathAbsent(destinationPath);
        if (directorySkill) {
          packageDirectory = await this.openDirectory(source.root, sourcePackageId);
          const stagePath = processPath(packageDirectory.handle, stageName);
          await writeFile(stagePath, updated, { mode: 0o600, flag: "wx" });
          await this.assertCurrent(source.root, source.id, source.file);
          await assertPathAbsent(destinationPath);
          await rename(sourcePath, destinationPath);
          try {
            await rename(stagePath, processPath(packageDirectory.handle, "SKILL.md"));
          } catch (error) {
            await rename(destinationPath, sourcePath).catch(() => {
              throw new PiResourceError("rename_rollback_failed", "Skill rename failed and could not be rolled back", 500);
            });
            throw error;
          }
        } else {
          const stagePath = processPath(rootDirectory.handle, stageName);
          await writeFile(stagePath, updated, { mode: 0o600, flag: "wx" });
          await this.assertCurrent(source.root, source.id, source.file);
          await assertPathAbsent(destinationPath);
          await rename(sourcePath, destinationPath);
          try {
            await rename(stagePath, destinationPath);
          } catch (error) {
            await rename(destinationPath, sourcePath).catch(() => {
              throw new PiResourceError("rename_rollback_failed", "Skill rename failed and could not be rolled back", 500);
            });
            throw error;
          }
        }
        await rootDirectory.handle.sync();
      } finally {
        const stageParent = packageDirectory?.handle ?? rootDirectory.handle;
        await rm(processPath(stageParent, stageName), { force: true }).catch(() => undefined);
        await Promise.all([
          source.handle.close(),
          rootDirectory.handle.close(),
          packageDirectory?.handle.close() ?? Promise.resolve(),
        ]);
      }
      return this.read("skill", directorySkill ? `${name}/SKILL.md` : `${name}.md`);
    });
  }

  async deleteSkill(id: string, expectedEtag: unknown): Promise<void> {
    await this.mutateSkill(async () => {
      const source = await this.openTarget("skill", id);
      const rootDirectory = await this.openDirectory(source.root, "");
      try {
        const current = await readBounded(source.handle, MAX_RESOURCE_BYTES);
        if (typeof expectedEtag !== "string" || etag(current) !== expectedEtag) {
          throw new PiResourceError("resource_changed", "Resource changed after it was opened", 409);
        }
        await this.assertCurrent(source.root, source.id, source.file);
        const directorySkill = basename(source.id) === "SKILL.md" && dirname(source.id) !== ".";
        const packageId = directorySkill ? dirname(source.id).replaceAll(sep, "/") : source.id;
        if (!packageId) throw new PiResourceError("unsafe_resource", "Resource root cannot be deleted");
        await rm(processPath(rootDirectory.handle, packageId), { recursive: directorySkill, force: false });
        await rootDirectory.handle.sync();
      } finally {
        await Promise.all([source.handle.close(), rootDirectory.handle.close()]);
      }
    });
  }
}
