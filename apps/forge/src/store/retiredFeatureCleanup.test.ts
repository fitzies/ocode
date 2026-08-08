import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeRetiredSpeechCredential } from "./retiredFeatureCleanup.ts";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("retired feature cleanup", () => {
  it("removes only the retired credential and keeps shared secrets directories", () => {
    const state = temporaryDirectory("ocode-retired-feature-");
    const secrets = join(state, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "speech-secrets.json"), "legacy-key");
    writeFileSync(join(secrets, "other.json"), "keep-me");

    removeRetiredSpeechCredential(state);

    expect(existsSync(join(secrets, "speech-secrets.json"))).toBe(false);
    expect(readFileSync(join(secrets, "other.json"), "utf8")).toBe("keep-me");
  });

  it("refuses to follow a symlinked secrets directory", () => {
    const state = temporaryDirectory("ocode-retired-feature-");
    const external = temporaryDirectory("ocode-external-secrets-");
    writeFileSync(join(external, "speech-secrets.json"), "keep-me");
    symlinkSync(external, join(state, "secrets"), "dir");

    expect(() => removeRetiredSpeechCredential(state)).toThrow("Refusing to follow");
    expect(readFileSync(join(external, "speech-secrets.json"), "utf8")).toBe("keep-me");
  });
});
