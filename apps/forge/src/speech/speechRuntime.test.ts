import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeDatabase } from "../store/database.ts";
import { OPENAI_SPEECH_CAPABILITIES } from "./openaiSpeechProvider.ts";
import { SpeechRuntime } from "./speechRuntime.ts";
import { SpeechSecretsStore } from "./speechSecretsStore.ts";
import { SpeechService } from "./speechService.ts";
import type { SpeechProvider, SpeechProviderRequest } from "./types.ts";

class ImmediateProvider implements SpeechProvider {
  readonly capabilities = OPENAI_SPEECH_CAPABILITIES;
  readonly requests: SpeechProviderRequest[] = [];

  async generate(request: SpeechProviderRequest) {
    this.requests.push(request);
    return { bytes: Uint8Array.from([1, 2, 3]), mediaType: "audio/mpeg" };
  }
}

let directory: string;
let database: ForgeDatabase;
let runtimes: SpeechRuntime[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocode-speech-runtime-"));
  database = new ForgeDatabase(":memory:");
  runtimes = [];
});

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function runtime(options: Partial<ConstructorParameters<typeof SpeechRuntime>[0]> = {}): SpeechRuntime {
  const value = new SpeechRuntime({ secretsDirectory: directory, database, ...options });
  runtimes.push(value);
  return value;
}

describe("SpeechRuntime", () => {
  it("starts disabled without a key while still exposing default setup options", () => {
    const speech = runtime();
    expect(speech.status()).toEqual({ enabled: false });
    expect(speech.settingsStatus()).toMatchObject({
      enabled: false,
      hasStoredKey: false,
      keySource: null,
      provider: "openai",
      defaultVoice: "marin",
      defaultStyle: "natural",
      dailyCharacterLimit: 100_000,
      dailyRequestLimit: 250,
      voices: expect.any(Array),
      styles: expect.any(Array),
    });
  });

  it("loads environment and stored keys with stored settings taking precedence", async () => {
    const environmentKeys: string[] = [];
    const environment = runtime({
      environmentApiKey: "environment-key",
      providerFactory: (key) => {
        environmentKeys.push(key);
        return new ImmediateProvider();
      },
    });
    expect(environment.settingsStatus()).toMatchObject({ enabled: true, keySource: "environment", hasStoredKey: false });
    expect(environmentKeys).toEqual(["environment-key"]);
    await environment.close();

    new SpeechSecretsStore(directory).save("stored-key");
    const storedKeys: string[] = [];
    const stored = runtime({
      environmentApiKey: "environment-key",
      providerFactory: (key) => {
        storedKeys.push(key);
        return new ImmediateProvider();
      },
    });
    expect(stored.settingsStatus()).toMatchObject({ enabled: true, keySource: "settings", hasStoredKey: true });
    expect(storedKeys).toEqual(["stored-key"]);
  });

  it("updates and removes the key immediately, closes replaced services, and falls back to the environment", async () => {
    const keys: string[] = [];
    let closeCount = 0;
    const speech = runtime({
      environmentApiKey: "environment-key",
      providerFactory: (key) => {
        keys.push(key);
        return new ImmediateProvider();
      },
      serviceFactory: (config, provider, usage) => {
        const service = new SpeechService(config, provider, usage);
        return {
          status: () => service.status(),
          generate: (input, signal) => service.generate(input, signal),
          close: async () => {
            closeCount += 1;
            await service.close();
          },
        };
      },
    });

    expect((await speech.updateKey("  stored-key  ")).keySource).toBe("settings");
    expect(keys).toEqual(["environment-key", "stored-key"]);
    expect(closeCount).toBe(1);
    expect(new SpeechSecretsStore(directory).load()).toBe("stored-key");

    expect(await speech.removeStoredKey()).toMatchObject({ enabled: true, keySource: "environment", hasStoredKey: false });
    expect(keys).toEqual(["environment-key", "stored-key", "environment-key"]);
    expect(closeCount).toBe(2);
    expect(new SpeechSecretsStore(directory).load()).toBeUndefined();
    await speech.close();
    expect(closeCount).toBe(3);
    await expect(speech.generate({ text: "after close" })).rejects.toMatchObject({ code: "speech_unavailable" });
  });

  it("shares durable aggregate budgets across service swaps", async () => {
    const providers: ImmediateProvider[] = [];
    const speech = runtime({
      environmentApiKey: "environment-key",
      config: {
        provider: "openai",
        dailyCharacterLimit: 100,
        dailyRequestLimit: 2,
      },
      providerFactory: () => {
        const provider = new ImmediateProvider();
        providers.push(provider);
        return provider;
      },
    });
    const today = new Date().toISOString().slice(0, 10);
    await speech.generate({ text: "first" });
    await speech.updateKey("stored-key");
    await speech.generate({ text: "second" });
    await speech.updateKey("another-key");
    await expect(speech.generate({ text: "third" })).rejects.toMatchObject({ code: "speech_daily_request_limit" });
    expect(database.speechUsage(today)).toMatchObject({ requests: 2, characters: 11 });
    expect(providers).toHaveLength(3);
  });

  it("deleting the only stored key disables generation immediately", async () => {
    new SpeechSecretsStore(directory).save("stored-key");
    const speech = runtime({ providerFactory: () => new ImmediateProvider() });
    expect(speech.status()).toMatchObject({ enabled: true });
    expect(await speech.removeStoredKey()).toMatchObject({ enabled: false, keySource: null });
    await expect(speech.generate({ text: "disabled" })).rejects.toMatchObject({ code: "speech_disabled" });
  });
});
