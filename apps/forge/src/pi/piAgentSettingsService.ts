import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PiAgentDefinition, PiAgentSettings, PiModelAlias, PiModelAliasSettings } from "@anvil/protocol";
import { agentDocument, updateAgentDocument } from "./agentFrontmatter.ts";
import { PiResourceError } from "./piCatalogService.ts";

const MAX_BYTES = 64 * 1024;
const MAX_AGENTS = 100;
const ALIASES_FILE = "ocode-model-aliases.json";
const AGENT_DIRECTORY = ["extensions", "subagents", "agents"];
const THINKING = new Set(["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const hash = (bytes: Uint8Array): string => `"${createHash("sha256").update(bytes).digest("hex")}"`;
const descriptor = (handle: FileHandle, name = ""): string => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function scalar(value: unknown, field: string, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) {
    throw new PiResourceError("invalid_agent_settings", `${field} is invalid`);
  }
  return value.trim();
}

function modelAliases(value: unknown): PiModelAlias[] {
  if (!Array.isArray(value) || value.length > 100) throw new PiResourceError("invalid_models", "Choose at most 100 models");
  const aliases = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new PiResourceError("invalid_models", "Model is invalid");
    const model = entry as Record<string, unknown>;
    const alias = scalar(model.alias, "Alias", 100, true);
    const modelId = scalar(model.modelId, "Model ID", 300, true);
    if (/\s/.test(modelId)) throw new PiResourceError("invalid_models", "Model IDs cannot contain whitespace");
    if (aliases.has(alias.toLowerCase()) || ids.has(modelId)) throw new PiResourceError("duplicate_model", "Model IDs and aliases must be unique");
    aliases.add(alias.toLowerCase()); ids.add(modelId);
    return { alias, modelId };
  });
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) throw new PiResourceError("unsafe_agent_settings", "Links and special files are not supported", 415);
  if (stat.size > MAX_BYTES) throw new PiResourceError("settings_too_large", "Settings file exceeds 64 KiB", 413);
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let position = 0;
  while (position < buffer.length) {
    const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
    if (!bytesRead) break;
    position += bytesRead;
  }
  if (position > MAX_BYTES) throw new PiResourceError("settings_too_large", "Settings file exceeds 64 KiB", 413);
  return buffer.subarray(0, position);
}

function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PiResourceError("invalid_settings_text", "Settings must contain valid UTF-8 text", 415); }
}

async function readChild(directory: FileHandle, id: string): Promise<Buffer> {
  const handle = await open(descriptor(directory, id), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try { return await readBounded(handle); } finally { await handle.close(); }
}

function definition(id: string, bytes: Buffer): PiAgentDefinition {
  const { fields, text } = agentDocument(decode(bytes));
  return { id, name: fields.name || id.slice(0, -3), description: fields.description ?? "", model: fields.model ?? "", thinking: fields.thinking ?? "", text, etag: hash(bytes) };
}

export class PiAgentSettingsService {
  private readonly root: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(options: { agentRoot?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.root = resolve(options.agentRoot ?? (options.environment ?? process.env).PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => { release = done; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async directory(parts: string[]): Promise<FileHandle> {
    if (process.platform !== "linux") throw new PiResourceError("secure_open_unsupported", "Secure Pi settings access requires Linux", 501);
    const canonical = await realpath(this.root);
    let current = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let expected = canonical;
    try {
      for (const part of parts) {
        const child = await open(descriptor(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await current.close(); current = child;
        expected = join(expected, part);
      }
      if (await realpath(descriptor(current)) !== expected) throw new PiResourceError("unsafe_agent_settings", "Pi settings directory changed", 409);
      return current;
    } catch (error) { await current.close(); throw error; }
  }

  private async modelsFrom(directory: FileHandle): Promise<PiModelAliasSettings> {
    let bytes: Buffer;
    try { bytes = await readChild(directory, ALIASES_FILE); }
    catch (error) { if (missing(error)) return { models: [], etag: hash(Buffer.alloc(0)) }; throw error; }
    let value: unknown;
    try { value = JSON.parse(decode(bytes)); }
    catch { throw new PiResourceError("invalid_models", "Saved model aliases are not valid JSON", 415); }
    return { models: modelAliases(value), etag: hash(bytes) };
  }

  async models(): Promise<PiModelAliasSettings> {
    return this.serial(async () => {
      let directory: FileHandle;
      try { directory = await this.directory([]); }
      catch (error) { if (missing(error)) return { models: [], etag: hash(Buffer.alloc(0)) }; throw error; }
      try { return await this.modelsFrom(directory); } finally { await directory.close(); }
    });
  }

  async settings(): Promise<PiAgentSettings> {
    const models = await this.models();
    const agents = await this.serial(async () => {
      let directory: FileHandle;
      try { directory = await this.directory(AGENT_DIRECTORY); }
      catch (error) { if (missing(error)) return []; throw error; }
      try {
        const agents: PiAgentDefinition[] = [];
        const entries = await opendir(descriptor(directory));
        let inspected = 0;
        for await (const entry of entries) {
          if (++inspected > 500) throw new PiResourceError("too_many_agents", "Subagent directory contains too many entries", 413);
          if (!entry.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\.md$/.test(entry.name)) continue;
          if (agents.length >= MAX_AGENTS) throw new PiResourceError("too_many_agents", "At most 100 subagents are supported", 413);
          agents.push(definition(entry.name, await readChild(directory, entry.name)));
        }
        return agents.sort((a, b) => a.name.localeCompare(b.name));
      } finally { await directory.close(); }
    });
    return { agents, models: models.models, modelsEtag: models.etag };
  }

  private async write(directory: FileHandle, id: string, bytes: Buffer, expected: string, absentAllowed = false): Promise<void> {
    if (bytes.length > MAX_BYTES) throw new PiResourceError("settings_too_large", "Settings file exceeds 64 KiB", 413);
    const current = async (): Promise<Buffer> => {
      try { return await readChild(directory, id); }
      catch (error) { if (absentAllowed && missing(error)) return Buffer.alloc(0); throw error; }
    };
    const assertCurrent = async (): Promise<void> => {
      if (hash(await current()) !== expected) throw new PiResourceError("settings_changed", "Settings changed. Reload before saving again", 409);
    };
    await assertCurrent();
    const temporaryPath = descriptor(directory, `.ocode-${randomUUID()}.tmp`);
    try {
      const temporary = await open(temporaryPath, "wx", 0o600);
      try { await temporary.writeFile(bytes); await temporary.sync(); } finally { await temporary.close(); }
      await assertCurrent();
      await rename(temporaryPath, descriptor(directory, id));
      await directory.sync();
    } finally { await rm(temporaryPath, { force: true }); }
  }

  async saveAgent(input: Record<string, unknown>): Promise<PiAgentDefinition> {
    const id = scalar(input.id, "Agent ID", 103, true);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\.md$/.test(id)) throw new PiResourceError("invalid_agent_id", "Agent ID is invalid");
    const fields = {
      name: scalar(input.name, "Name", 100, true), description: scalar(input.description, "Description", 2000),
      model: scalar(input.model, "Model", 300), thinking: scalar(input.thinking, "Reasoning", 20),
    };
    if (!THINKING.has(fields.thinking) || /\s/.test(fields.model)) throw new PiResourceError("invalid_agent_settings", "Model or reasoning is invalid");
    if (typeof input.text !== "string" || input.text.includes("\0")) throw new PiResourceError("invalid_agent_text", "Agent instructions must be text");
    const text = input.text;
    const etag = scalar(input.etag, "ETag", 100, true);
    return this.serial(async () => {
      const directory = await this.directory(AGENT_DIRECTORY);
      try {
        const before = await readChild(directory, id);
        if (hash(before) !== etag) throw new PiResourceError("settings_changed", "Settings changed. Reload before saving again", 409);
        const bytes = Buffer.from(updateAgentDocument(decode(before), fields, text));
        await this.write(directory, id, bytes, etag);
        return definition(id, bytes);
      } finally { await directory.close(); }
    });
  }

  async saveModels(input: Record<string, unknown>): Promise<PiModelAliasSettings> {
    const models = modelAliases(input.models);
    const etag = scalar(input.etag, "ETag", 100, true);
    return this.serial(async () => {
      const directory = await this.directory([]);
      try {
        const bytes = Buffer.from(`${JSON.stringify(models, null, 2)}\n`);
        await this.write(directory, ALIASES_FILE, bytes, etag, true);
        return { models, etag: hash(bytes) };
      } finally { await directory.close(); }
    });
  }
}
