import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForgeEventService } from "../events/eventService.ts";
import { type SpeechController, SpeechRuntime } from "../speech/speechRuntime.ts";
import {
  SpeechError,
  type SpeechConfig,
  type SpeechProvider,
  type SpeechProviderCapabilities,
  type SpeechProviderRequest,
} from "../speech/types.ts";
import { ForgeDatabase } from "../store/database.ts";
import { ForgeHttpServer } from "./server.ts";

const ownerHeaders = { "tailscale-user-login": "owner@example.com" };
const speechConfig: SpeechConfig = {
  provider: "openai",
  voice: "marin",
  style: "natural",
  dailyCharacterLimit: 100_000,
  dailyRequestLimit: 250,
};

const providerCapabilities: SpeechProviderCapabilities = {
  providerId: "openai",
  cacheVersion: "openai-test-model-v1",
  outputMediaType: "audio/mpeg",
  maxInputCharacters: 3_500,
  defaultVoice: "marin",
  defaultStyle: "natural",
  voices: [
    { id: "alloy", label: "Alloy", description: "Test voice." },
    { id: "marin", label: "Marin", description: "Test voice." },
    { id: "cedar", label: "Cedar", description: "Test voice." },
  ],
  styles: [
    { id: "natural", label: "Natural", description: "Test style." },
    { id: "warm", label: "Warm", description: "Test style." },
    { id: "gentle", label: "Gentle", description: "Test style." },
  ],
};

class TestProvider implements SpeechProvider {
  readonly capabilities = providerCapabilities;
  requests: SpeechProviderRequest[] = [];
  signals: Array<AbortSignal | undefined> = [];
  error?: unknown;
  block = false;
  upstreamAborted = false;

  async generate(request: SpeechProviderRequest, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: "audio/mpeg" }> {
    this.requests.push(request);
    this.signals.push(signal);
    if (this.error) throw this.error;
    if (this.block) {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => {
        this.upstreamAborted = true;
        reject(new SpeechError("speech_aborted", "cancelled", 499));
      }, { once: true }));
    }
    return { bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x04]), mediaType: "audio/mpeg" };
  }
}

let database: ForgeDatabase;
let events: ForgeEventService;
let provider: TestProvider;
let speech: SpeechRuntime;
let server: ForgeHttpServer;
let baseUrl: string;
let secretsDirectory: string;

async function start(speechController?: SpeechController): Promise<void> {
  server = new ForgeHttpServer({ events, ownerLogin: "owner@example.com", speech: speechController });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  database = new ForgeDatabase(":memory:");
  events = new ForgeEventService(database, []);
  provider = new TestProvider();
  secretsDirectory = mkdtempSync(join(tmpdir(), "ocode-speech-http-"));
  speech = new SpeechRuntime({
    secretsDirectory,
    database,
    config: speechConfig,
    environmentApiKey: "environment-secret",
    providerFactory: () => provider,
  });
  await start(speech);
});

afterEach(async () => {
  await server.close();
  await speech.close();
  database.close();
  rmSync(secretsDirectory, { recursive: true, force: true });
});

describe("speech HTTP routes", () => {
  it("requires owner authentication and returns safe enabled status", async () => {
    expect((await fetch(`${baseUrl}/api/v1/speech/status`)).status).toBe(403);
    const response = await fetch(`${baseUrl}/api/v1/speech/status`, { headers: ownerHeaders });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({
      enabled: true,
      provider: "openai",
      defaultVoice: "marin",
      defaultStyle: "natural",
      maxChunkCharacters: 3_500,
      voices: expect.arrayContaining([{ id: "alloy", label: "Alloy", description: expect.any(String) }]),
      styles: expect.arrayContaining([{ id: "warm", label: "Warm", description: expect.any(String) }]),
    });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("advertises the allowed method on speech route 405 responses", async () => {
    const status = await fetch(`${baseUrl}/api/v1/speech/status`, {
      method: "POST",
      headers: ownerHeaders,
    });
    expect(status.status).toBe(405);
    expect(status.headers.get("allow")).toBe("GET");

    const generate = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "GET",
      headers: ownerHeaders,
    });
    expect(generate.status).toBe(405);
    expect(generate.headers.get("allow")).toBe("POST");
  });

  it("returns disabled status and a JSON disabled error when no service is configured", async () => {
    await server.close();
    await start();
    const status = await fetch(`${baseUrl}/api/v1/speech/status`, { headers: ownerHeaders });
    expect(await status.json()).toEqual({ enabled: false });
    const generated = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(generated.status).toBe(503);
    expect(await generated.json()).toMatchObject({ code: "speech_disabled" });
  });

  it("configures and removes a stored key immediately without exposing it", async () => {
    await server.close();
    await speech.close();
    speech = new SpeechRuntime({
      secretsDirectory,
      database,
      config: speechConfig,
      providerFactory: () => provider,
    });
    await start(speech);

    expect((await fetch(`${baseUrl}/api/v1/settings/speech`)).status).toBe(403);
    const initial = await fetch(`${baseUrl}/api/v1/settings/speech`, { headers: ownerHeaders });
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect(await initial.json()).toMatchObject({
      enabled: false,
      hasStoredKey: false,
      keySource: null,
      provider: "openai",
      defaultVoice: "marin",
      dailyCharacterLimit: 100_000,
      dailyRequestLimit: 250,
      voices: expect.any(Array),
      styles: expect.any(Array),
    });

    const crossOrigin = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "cross-origin-secret" }),
    });
    expect(crossOrigin.status).toBe(403);
    const strict = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "stored-secret", other: true }),
    });
    expect(strict.status).toBe(400);

    const updated = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-UNIQUE9876" }),
    });
    const updatedText = await updated.text();
    expect(updated.status).toBe(200);
    expect(updatedText).not.toContain("sk-test-UNIQUE9876");
    expect(updatedText).not.toContain("9876");
    expect(JSON.parse(updatedText)).toMatchObject({ enabled: true, hasStoredKey: true, keySource: "settings" });
    expect(await (await fetch(`${baseUrl}/api/v1/speech/status`, { headers: ownerHeaders })).json()).toMatchObject({ enabled: true });

    const rejectedDelete = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "DELETE",
      headers: { ...ownerHeaders, origin: "https://attacker.example" },
    });
    expect(rejectedDelete.status).toBe(403);
    const removed = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "DELETE",
      headers: { ...ownerHeaders, origin: baseUrl },
    });
    expect(await removed.json()).toMatchObject({ enabled: false, hasStoredKey: false, keySource: null });
    expect(await (await fetch(`${baseUrl}/api/v1/speech/status`, { headers: ownerHeaders })).json()).toEqual({ enabled: false });
  });

  it("strictly bounds settings bodies and advertises settings methods", async () => {
    const method = await fetch(`${baseUrl}/api/v1/settings/speech`, { method: "PATCH", headers: ownerHeaders });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, PUT, DELETE");

    const malformed = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${baseUrl}/api/v1/settings/speech`, {
      method: "PUT",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "x".repeat(17_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain("xxxx");
  });

  it("requires same-origin JSON and returns a private validated MP3", async () => {
    const crossOrigin = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(crossOrigin.status).toBe(403);
    const wrongType = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "text/plain" },
      body: "hello",
    });
    expect(wrongType.status).toBe(415);

    const response = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: "hello", voice: "cedar", style: "gentle" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0x49, 0x44, 0x33, 0x04]));
    expect(provider.requests[0]).toMatchObject({ text: "hello", voice: "cedar", style: "gentle" });
    expect(provider.signals[0]?.aborted).toBe(false);
  });

  it("cancels upstream when the client disconnects after completing its request", async () => {
    provider.block = true;
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ text: "cancel this" }),
      signal: controller.signal,
    });
    while (provider.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    while (!provider.upstreamAborted) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("returns JSON errors for malformed input, allowlists, and body/text limits", async () => {
    const post = (body: string) => fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body,
    });
    const malformed = await post("{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_json" });
    const invalidVoice = await post(JSON.stringify({ text: "hello", voice: "robot" }));
    expect(invalidVoice.status).toBe(400);
    expect(await invalidVoice.json()).toMatchObject({ code: "invalid_speech_voice" });
    const longText = await post(JSON.stringify({ text: "x".repeat(3_501) }));
    expect(longText.status).toBe(413);
    expect(await longText.json()).toMatchObject({ code: "speech_text_too_long" });
    const largeBody = await post(JSON.stringify({ text: "x", padding: "x".repeat(17_000) }));
    expect(largeBody.status).toBe(413);
    expect(await largeBody.json()).toMatchObject({ code: "speech_request_too_large" });
  });

  it("maps provider failures safely and sends Retry-After for paid limits", async () => {
    provider.error = new SpeechError("speech_upstream_failed", "Speech provider could not generate audio", 502, true);
    const failed = await fetch(`${baseUrl}/api/v1/speech`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ text: "fail" }),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "speech_upstream_failed", retryable: true });

    await server.close();
    await speech.close();
    provider.error = undefined;
    speech = new SpeechRuntime({
      secretsDirectory,
      database,
      config: { ...speechConfig, dailyRequestLimit: 2 },
      environmentApiKey: "environment-secret",
      providerFactory: () => provider,
    });
    await start(speech);
    const headers = { ...ownerHeaders, origin: baseUrl, "content-type": "application/json" };
    expect((await fetch(`${baseUrl}/api/v1/speech`, { method: "POST", headers, body: JSON.stringify({ text: "one" }) })).status).toBe(200);
    const limited = await fetch(`${baseUrl}/api/v1/speech`, { method: "POST", headers, body: JSON.stringify({ text: "two" }) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ code: "speech_daily_request_limit" });
  });
});
