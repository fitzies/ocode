import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPEECH_SECRETS_FILENAME, SpeechSecretsStore } from "./speechSecretsStore.ts";

let directory: string;
let secretsDirectory: string;
let store: SpeechSecretsStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocode-speech-secrets-"));
  chmodSync(directory, 0o751);
  secretsDirectory = join(directory, "secrets");
  store = new SpeechSecretsStore(secretsDirectory);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("SpeechSecretsStore", () => {
  it("atomically saves, replaces, loads, and deletes owner-only plaintext", () => {
    expect(store.load()).toBeUndefined();
    expect(lstatSync(secretsDirectory).mode & 0o777).toBe(0o700);

    store.save("  first-secret  ");
    expect(store.load()).toBe("first-secret");
    expect(lstatSync(store.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ apiKey: "first-secret" });

    store.save("second-secret");
    expect(store.load()).toBe("second-secret");
    expect(readdirSync(secretsDirectory)).toEqual([SPEECH_SECRETS_FILENAME]);
    store.delete();
    expect(store.load()).toBeUndefined();
    expect(() => store.delete()).not.toThrow();
  });

  it("does not change the mode of its root-managed parent directory", () => {
    store.save("stored-secret");
    expect(lstatSync(directory).mode & 0o777).toBe(0o751);
    expect(lstatSync(secretsDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked secrets directory without following it", () => {
    const managedDirectory = join(directory, "managed-secrets");
    mkdirSync(managedDirectory, { mode: 0o755 });
    chmodSync(managedDirectory, 0o755);
    const managedFile = join(managedDirectory, SPEECH_SECRETS_FILENAME);
    writeFileSync(managedFile, JSON.stringify({ apiKey: "managed-secret" }), { mode: 0o640 });
    chmodSync(managedFile, 0o640);
    symlinkSync(managedDirectory, secretsDirectory, "dir");

    expect(() => store.load()).toThrow("real directory");
    expect(() => store.save("replacement-secret")).toThrow("real directory");
    expect(() => store.delete()).toThrow("real directory");
    expect(lstatSync(managedDirectory).mode & 0o777).toBe(0o755);
    expect(lstatSync(managedFile).mode & 0o777).toBe(0o640);
    expect(readFileSync(managedFile, "utf8")).toContain("managed-secret");
  });

  it("rejects malformed, oversized, and non-strict files without including contents in errors", () => {
    expect(store.load()).toBeUndefined();
    for (const content of [
      "{",
      JSON.stringify({ apiKey: "secret-value", extra: true }),
      JSON.stringify({ apiKey: "" }),
      "x".repeat(17_000),
    ]) {
      writeFileSync(store.path, content, { mode: 0o600 });
      let message = "";
      try {
        store.load();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("Speech secrets file is malformed");
      expect(message).not.toContain("secret-value");
    }
  });

  it("rejects symlink targets for load, save, and delete", () => {
    expect(store.load()).toBeUndefined();
    const outside = join(directory, "outside.json");
    writeFileSync(outside, JSON.stringify({ apiKey: "outside-secret" }), { mode: 0o600 });
    symlinkSync(outside, store.path);
    expect(() => store.load()).toThrow("symbolic link");
    expect(() => store.save("replacement-secret")).toThrow("symbolic link");
    expect(() => store.delete()).toThrow("symbolic link");
    expect(readFileSync(outside, "utf8")).toContain("outside-secret");
  });
});
