import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SPEECH_SECRETS_FILENAME = "speech-secrets.json";
export const MAX_SPEECH_API_KEY_LENGTH = 8_192;
const MAX_SECRETS_FILE_BYTES = 16 * 1024;

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateTarget(path: string): void {
  const stat = safeLstat(path);
  if (stat?.isSymbolicLink()) throw new Error("Speech secrets file must not be a symbolic link");
  if (stat && !stat.isFile()) throw new Error("Speech secrets path must be a regular file");
}

export function normalizeSpeechApiKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("OpenAI API key must be a string");
  const key = value.trim();
  if (!key) throw new Error("OpenAI API key must not be empty");
  if (key.length > MAX_SPEECH_API_KEY_LENGTH) throw new Error("OpenAI API key is too long");
  return key;
}

/** Stores the owner-entered key as permission-protected plaintext in Forge state. */
export class SpeechSecretsStore {
  readonly path: string;

  constructor(private readonly secretsDirectory: string) {
    this.path = join(secretsDirectory, SPEECH_SECRETS_FILENAME);
  }

  load(): string | undefined {
    this.ensureDirectory();
    validateTarget(this.path);
    if (!safeLstat(this.path)) return undefined;

    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_SECRETS_FILE_BYTES) throw new Error("Speech secrets file is malformed");
      fchmodSync(descriptor, 0o600);
      const raw = readFileSync(descriptor, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      const record = parsed as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || !("apiKey" in record)) throw new Error("invalid");
      return normalizeSpeechApiKey(record.apiKey);
    } catch (error) {
      if (error instanceof Error && error.message.includes("symbolic link")) throw error;
      throw new Error("Speech secrets file is malformed");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  save(apiKey: unknown): void {
    const key = normalizeSpeechApiKey(apiKey);
    this.ensureDirectory();
    validateTarget(this.path);
    const temporaryPath = join(this.secretsDirectory, `.${SPEECH_SECRETS_FILENAME}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ apiKey: key })}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.path);
      this.syncDirectory();
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be renamed.
      }
      throw error;
    }
  }

  delete(): void {
    this.ensureDirectory();
    validateTarget(this.path);
    try {
      unlinkSync(this.path);
      this.syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private ensureDirectory(): void {
    let directoryStat = safeLstat(this.secretsDirectory);
    if (!directoryStat) {
      try {
        mkdirSync(this.secretsDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error("Speech secrets directory must be a real directory");
        }
      }
      directoryStat = safeLstat(this.secretsDirectory);
    }
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Speech secrets directory must be a real directory");
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        this.secretsDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const openedStat = fstatSync(descriptor);
      if (
        !openedStat.isDirectory()
        || openedStat.dev !== directoryStat.dev
        || openedStat.ino !== directoryStat.ino
      ) throw new Error("invalid");
      fchmodSync(descriptor, 0o700);
    } catch {
      throw new Error("Speech secrets directory must be a real directory");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private syncDirectory(): void {
    const descriptor = openSync(
      this.secretsDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
