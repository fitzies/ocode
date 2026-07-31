import { describe, expect, it } from "vitest";

import { ForgeDatabase } from "../store/database.ts";
import { SpeechService } from "./speechService.ts";
import { SpeechUsageStore } from "./speechUsageStore.ts";
import {
  SpeechError,
  type SpeechConfig,
  type SpeechProvider,
  type SpeechProviderCapabilities,
  type SpeechProviderRequest,
} from "./types.ts";

const config: SpeechConfig = {
  provider: "openai",
  voice: "marin",
  style: "natural",
  dailyCharacterLimit: 100_000,
  dailyRequestLimit: 250,
};
const clip = { bytes: Uint8Array.from([1, 2, 3]), mediaType: "audio/mpeg" };
const capabilities: SpeechProviderCapabilities = {
  providerId: "openai",
  cacheVersion: "openai-test-model-v1",
  outputMediaType: "audio/mpeg",
  maxInputCharacters: 3_500,
  defaultVoice: "marin",
  defaultStyle: "natural",
  voices: [
    { id: "marin", label: "Marin", description: "Test voice." },
    { id: "cedar", label: "Cedar", description: "Test voice." },
  ],
  styles: [
    { id: "natural", label: "Natural", description: "Test style." },
    { id: "focused", label: "Focused", description: "Test style." },
    { id: "warm", label: "Warm", description: "Test style." },
    { id: "gentle", label: "Gentle", description: "Test style." },
  ],
};

class DeferredProvider implements SpeechProvider {
  readonly capabilities = capabilities;
  readonly calls: Array<{
    request: SpeechProviderRequest;
    signal?: AbortSignal;
    resolve: (value: typeof clip) => void;
    reject: (error: unknown) => void;
  }> = [];

  generate(request: SpeechProviderRequest, signal?: AbortSignal): Promise<typeof clip> {
    return new Promise((resolve, reject) => this.calls.push({ request, signal, resolve, reject }));
  }
}

function setup(overrides: Partial<SpeechConfig> = {}, now?: () => Date) {
  const database = new ForgeDatabase(":memory:");
  const provider = new DeferredProvider();
  const service = new SpeechService({ ...config, ...overrides }, provider, new SpeechUsageStore(database), now);
  return { database, provider, service };
}

describe("SpeechService", () => {
  it("reports safe options and validates per-request voice, style, and Unicode length", async () => {
    const { database, provider, service } = setup();
    expect(service.status()).toMatchObject({
      enabled: true,
      provider: "openai",
      defaultVoice: "marin",
      defaultStyle: "natural",
      maxChunkCharacters: 3_500,
      voices: expect.arrayContaining([{ id: "cedar", label: "Cedar", description: expect.any(String) }]),
      styles: expect.arrayContaining([{ id: "gentle", label: "Gentle", description: expect.any(String) }]),
    });

    const generated = service.generate({ text: " Hello \r\n world ", voice: "cedar", style: "focused" });
    expect(provider.calls[0]?.request).toEqual({
      text: "Hello \n world",
      voice: "cedar",
      style: "focused",
    });
    provider.calls[0]!.resolve(clip);
    await expect(generated).resolves.toEqual(clip);
    await expect(service.generate({ text: "hello", voice: "unknown" })).rejects.toMatchObject({ code: "invalid_speech_voice" });
    await expect(service.generate({ text: "hello", style: "unknown" })).rejects.toMatchObject({ code: "invalid_speech_style" });
    await expect(service.generate({ text: "😀".repeat(3_501) })).rejects.toMatchObject({ code: "speech_text_too_long" });
    database.close();
  });

  it("uses a second provider's model version, options, media type, limits, and defaults without service changes", async () => {
    const database = new ForgeDatabase(":memory:");
    const alternateCapabilities: SpeechProviderCapabilities = {
      providerId: "alternate",
      cacheVersion: "alternate-model-v2",
      outputMediaType: "audio/wav",
      maxInputCharacters: 4,
      defaultVoice: "reader",
      defaultStyle: "plain",
      voices: [{ id: "reader", label: "Reader", description: "Alternate reader." }],
      styles: [{ id: "plain", label: "Plain", description: "Alternate style." }],
    };
    const requests: SpeechProviderRequest[] = [];
    const alternate: SpeechProvider = {
      capabilities: alternateCapabilities,
      async generate(request) {
        requests.push(request);
        return { bytes: Uint8Array.from([4, 5, 6]), mediaType: alternateCapabilities.outputMediaType };
      },
    };
    const service = new SpeechService({
      provider: "alternate",
      dailyCharacterLimit: 10,
      dailyRequestLimit: 2,
    }, alternate, new SpeechUsageStore(database));

    expect(service.status()).toEqual({
      enabled: true,
      provider: "alternate",
      defaultVoice: "reader",
      defaultStyle: "plain",
      maxChunkCharacters: 4,
      voices: alternateCapabilities.voices,
      styles: alternateCapabilities.styles,
    });
    await expect(service.generate({ text: "four" })).resolves.toEqual({
      bytes: Uint8Array.from([4, 5, 6]),
      mediaType: "audio/wav",
    });
    expect(requests).toEqual([{ text: "four", voice: "reader", style: "plain" }]);
    await expect(service.generate({ text: "12345" })).rejects.toMatchObject({ code: "speech_text_too_long" });
    expect(() => new SpeechService({
      provider: "alternate",
      voice: "missing",
      dailyCharacterLimit: 10,
      dailyRequestLimit: 2,
    }, alternate, new SpeechUsageStore(database))).toThrow("Configured speech voice");
    database.close();
  });

  it("deduplicates normalized in-flight requests and caches them without spending budget again", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const { database, provider, service } = setup({}, () => now);
    const first = service.generate({ text: "cafe\u0301" });
    const second = service.generate({ text: "café" });
    expect(provider.calls).toHaveLength(1);
    expect(database.speechUsage("2026-07-23")).toEqual({ date: "2026-07-23", requests: 1, characters: 4 });
    provider.calls[0]!.resolve(clip);
    await expect(Promise.all([first, second])).resolves.toEqual([clip, clip]);

    await expect(service.generate({ text: "café" })).resolves.toEqual(clip);
    expect(provider.calls).toHaveLength(1);
    expect(database.speechUsage("2026-07-23").requests).toBe(1);
    database.close();
  });

  it("expires cached clips after one hour", async () => {
    let now = new Date("2026-07-23T12:00:00.000Z");
    const { database, provider, service } = setup({}, () => now);
    const first = service.generate({ text: "expire me" });
    provider.calls[0]!.resolve(clip);
    await first;
    now = new Date("2026-07-23T13:00:00.001Z");
    const second = service.generate({ text: "expire me" });
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]!.resolve(clip);
    await second;
    expect(database.speechUsage("2026-07-23").requests).toBe(2);
    database.close();
  });

  it("rejects a third distinct paid generation immediately without queueing or charging it", async () => {
    const { database, provider, service } = setup();
    const first = service.generate({ text: "first" });
    const second = service.generate({ text: "second" });
    await expect(service.generate({ text: "third" })).rejects.toMatchObject({
      code: "speech_concurrency_limit",
      status: 429,
      retryAfterSeconds: 1,
    });
    expect(provider.calls).toHaveLength(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(database.speechUsage(today).requests).toBe(2);
    provider.calls.forEach((call) => call.resolve(clip));
    await Promise.all([first, second]);
    database.close();
  });

  it("atomically enforces daily request and character budgets before provider work", async () => {
    const fixed = () => new Date("2026-07-23T23:59:00.000Z");
    const requestLimited = setup({ dailyRequestLimit: 1 }, fixed);
    const first = requestLimited.service.generate({ text: "paid" });
    requestLimited.provider.calls[0]!.resolve(clip);
    await first;
    await expect(requestLimited.service.generate({ text: "different" })).rejects.toMatchObject({
      code: "speech_daily_request_limit",
      status: 429,
      retryAfterSeconds: 60,
    });
    requestLimited.database.close();

    const characterLimited = setup({ dailyCharacterLimit: 5 }, fixed);
    const allowed = characterLimited.service.generate({ text: "1234" });
    characterLimited.provider.calls[0]!.resolve(clip);
    await allowed;
    await expect(characterLimited.service.generate({ text: "12" })).rejects.toMatchObject({
      code: "speech_daily_character_limit",
    });
    expect(characterLimited.provider.calls).toHaveLength(1);
    characterLimited.database.close();
  });

  it("cancels upstream only when the last subscriber aborts", async () => {
    const { database, provider, service } = setup();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = service.generate({ text: "shared", style: "warm" }, firstAbort.signal);
    const second = service.generate({ text: "shared", style: "warm" }, secondAbort.signal);
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ code: "speech_aborted" });
    expect(provider.calls[0]?.signal?.aborted).toBe(false);
    provider.calls[0]!.resolve(clip);
    await expect(second).resolves.toEqual(clip);

    const soleAbort = new AbortController();
    const sole = service.generate({ text: "only subscriber" }, soleAbort.signal);
    soleAbort.abort();
    await expect(sole).rejects.toMatchObject({ code: "speech_aborted" });
    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    provider.calls[1]!.reject(new SpeechError("speech_aborted", "cancelled", 499));
    await new Promise((resolve) => setTimeout(resolve, 0));
    database.close();
  });

  it("aborts all paid work during shutdown", async () => {
    const { database, provider, service } = setup();
    const generation = service.generate({ text: "shutdown" });
    const closing = service.close();
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
    provider.calls[0]!.reject(new SpeechError("speech_aborted", "cancelled", 499));
    await closing;
    await expect(generation).rejects.toMatchObject({ code: "speech_aborted" });
    await expect(service.generate({ text: "later" })).rejects.toMatchObject({ code: "speech_unavailable" });
    database.close();
  });
});
