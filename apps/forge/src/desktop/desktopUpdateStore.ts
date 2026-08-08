import { randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TARGET_PATTERN = /^(darwin|linux|windows)$/;
const ARCH_PATTERN = /^(aarch64|armv7|i686|x86_64)$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;

export interface DesktopReleaseMetadata {
  schemaVersion: 1;
  version: string;
  target: string;
  arch: string;
  artifact: string;
  signature: string;
  byteLength: number;
  pubDate: string;
  notes?: string;
}

export interface PublishDesktopReleaseInput {
  version: string;
  target: string;
  arch: string;
  artifactPath: string;
  signaturePath: string;
  notes?: string;
  pubDate?: string;
}

function validPlatform(target: string, arch: string): boolean {
  return TARGET_PATTERN.test(target) && ARCH_PATTERN.test(arch);
}

function channelDirectory(root: string, target: string, arch: string): string {
  if (!validPlatform(target, arch)) throw new Error("Desktop update target or architecture is invalid");
  return join(root, "channels", "stable", `${target}-${arch}`);
}

function versionDirectoryName(version: string): string {
  return version.replace(/\+/g, "_");
}

function parseVersion(version: string): { core: bigint[]; prerelease?: string[] } {
  const match = VERSION_PATTERN.exec(version);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("Desktop update version must be valid SemVer");
  }
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    ...(match[4] ? { prerelease: match[4].split(".") } : {}),
  };
}

export function compareDesktopVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseMetadata(value: unknown, target: string, arch: string): DesktopReleaseMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.version !== "string" || !VERSION_PATTERN.test(record.version) ||
    record.target !== target || record.arch !== arch ||
    typeof record.artifact !== "string" || basename(record.artifact) !== record.artifact ||
    !/^ocode-[0-9A-Za-z.+_-]+-(darwin|linux|windows)-(aarch64|armv7|i686|x86_64)-[0-9a-f-]{36}\.app\.tar\.gz$/.test(record.artifact) ||
    typeof record.signature !== "string" || record.signature.length > 16_384 || !SIGNATURE_PATTERN.test(record.signature) ||
    typeof record.byteLength !== "number" || !Number.isSafeInteger(record.byteLength) || record.byteLength < 1 || record.byteLength > MAX_UPDATE_BYTES ||
    typeof record.pubDate !== "string" || !Number.isFinite(Date.parse(record.pubDate)) ||
    (record.notes !== undefined && (typeof record.notes !== "string" || record.notes.length > 20_000))
  ) return undefined;
  return record as unknown as DesktopReleaseMetadata;
}

function atomicWrite(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  renameSync(temporary, path);
}

function latestMetadataSync(root: string, target: string, arch: string): DesktopReleaseMetadata | undefined {
  let entries;
  try {
    entries = readdirSync(channelDirectory(root, target, arch), { withFileTypes: true });
  } catch {
    return undefined;
  }
  let latest: DesktopReleaseMetadata | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const value = JSON.parse(readFileSync(join(channelDirectory(root, target, arch), entry.name, "release.json"), "utf8")) as unknown;
      const metadata = parseMetadata(value, target, arch);
      if (metadata && (!latest || compareDesktopVersions(metadata.version, latest.version) > 0)) latest = metadata;
    } catch {
      // Ignore incomplete or corrupt release directories. Publication claims are fail-closed.
    }
  }
  return latest;
}

export function publishDesktopRelease(root: string, input: PublishDesktopReleaseInput): DesktopReleaseMetadata {
  parseVersion(input.version);
  if (input.version.includes("+")) throw new Error("Published desktop update versions may not contain build metadata");
  if (!validPlatform(input.target, input.arch)) throw new Error("Desktop update target or architecture is invalid");
  if (input.notes !== undefined && input.notes.length > 20_000) throw new Error("Desktop update notes are too long");

  const source = statSync(input.artifactPath);
  if (!source.isFile() || source.size < 1 || source.size > MAX_UPDATE_BYTES) {
    throw new Error("Desktop update artifact must be a non-empty file no larger than 512 MB");
  }
  const signature = readFileSync(input.signaturePath, "utf8").trim();
  if (!SIGNATURE_PATTERN.test(signature) || signature.length > 16_384) {
    throw new Error("Desktop update signature is invalid");
  }

  const releases = join(root, "releases", input.target, input.arch);
  const channel = channelDirectory(root, input.target, input.arch);
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  mkdirSync(channel, { recursive: true, mode: 0o700 });
  const current = latestMetadataSync(root, input.target, input.arch);
  if (current && compareDesktopVersions(input.version, current.version) <= 0) {
    throw new Error(`Desktop update version must be newer than published version ${current.version}`);
  }

  const releaseDirectory = join(channel, versionDirectoryName(input.version));
  try {
    mkdirSync(releaseDirectory, { mode: 0o700 });
  } catch {
    throw new Error(`Desktop update ${input.version} is already published or being published for ${input.target}-${input.arch}`);
  }

  const safeVersion = versionDirectoryName(input.version);
  const artifact = `ocode-${safeVersion}-${input.target}-${input.arch}-${randomUUID()}.app.tar.gz`;
  const destination = join(releases, artifact);
  let published = false;
  try {
    copyFileSync(input.artifactPath, destination, constants.COPYFILE_EXCL);
    const copied = statSync(destination);
    if (!copied.isFile() || copied.size !== source.size) throw new Error("Desktop update artifact copy failed validation");

    const metadata: DesktopReleaseMetadata = {
      schemaVersion: 1,
      version: input.version,
      target: input.target,
      arch: input.arch,
      artifact,
      signature,
      byteLength: source.size,
      pubDate: input.pubDate ?? new Date().toISOString(),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    };
    atomicWrite(join(releaseDirectory, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    published = true;
    return metadata;
  } finally {
    if (!published) {
      rmSync(destination, { force: true });
      rmSync(releaseDirectory, { recursive: true, force: true });
    }
  }
}

export class DesktopUpdateStore {
  constructor(private readonly root: string) {}

  async latest(target: string, arch: string): Promise<DesktopReleaseMetadata | undefined> {
    let directory: string;
    try {
      directory = channelDirectory(this.root, target, arch);
    } catch {
      return undefined;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let latest: DesktopReleaseMetadata | undefined;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = JSON.parse(await readFile(join(directory, entry.name, "release.json"), "utf8")) as unknown;
        const metadata = parseMetadata(raw, target, arch);
        if (metadata && (!latest || compareDesktopVersions(metadata.version, latest.version) > 0)) latest = metadata;
      } catch {
        // Ignore incomplete or corrupt release directories.
      }
    }
    return latest;
  }

  async openArtifact(target: string, arch: string, artifact: string): Promise<{
    handle: Awaited<ReturnType<typeof open>>;
    artifact: string;
    byteLength: number;
  } | undefined> {
    if (!validPlatform(target, arch) || basename(artifact) !== artifact) return undefined;
    const expected = new RegExp(`^ocode-[0-9A-Za-z.+_-]+-${target}-${arch}-[0-9a-f-]{36}\\.app\\.tar\\.gz$`);
    if (!expected.test(artifact)) return undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(this.root, "releases", target, arch, artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
      const file = await handle.stat();
      if (!file.isFile() || file.size < 1 || file.size > MAX_UPDATE_BYTES) throw new Error("Desktop update artifact is invalid");
      return { handle, artifact, byteLength: file.size };
    } catch {
      await handle?.close().catch(() => undefined);
      return undefined;
    }
  }
}
