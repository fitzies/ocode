import { describe, expect, it, vi } from "vitest";
import {
  deleteStoredSpeechApiKey,
  getSpeechSettings,
  parseSpeechSettings,
  parseSpeechStatus,
  parseStoredSpeechPreferences,
  putSpeechApiKey,
  resolveSpeechPreferences,
  sanitizeSpeechError,
  speechApiKeyForSave,
  speechSettingsRequireApiKey,
  SPEECH_PREFERENCES_KEY,
} from "./speechClient";

const enabledStatusPayload = {
  enabled: true,
  provider: "custom-speech-provider",
  defaultVoice: "voice-default",
  defaultStyle: "style-default",
  maxChunkCharacters: 12_000,
  voices: [
    { id: "voice-default", label: "Default voice", description: "General purpose" },
    { id: "voice-alternate", label: "Alternate voice", description: "Alternate delivery" },
  ],
  styles: [
    { id: "style-default", label: "Default style", description: "General purpose" },
    { id: "style-brief", label: "Brief style", description: "Short delivery" },
  ],
};
const enabled = parseSpeechStatus(enabledStatusPayload);
const disabledSettingsPayload = {
  ...enabledStatusPayload,
  enabled: false,
  hasStoredKey: false,
  keySource: null,
  dailyCharacterLimit: 100_000,
  dailyRequestLimit: 250,
};

describe("speech status and preferences", () => {
  it("accepts provider-neutral metadata and rejects malformed status", () => {
    expect(enabled).toEqual(enabledStatusPayload);
    expect(parseSpeechStatus({ ...enabledStatusPayload, provider: "   " })).toEqual({ enabled: false });
    expect(parseSpeechStatus({ ...enabledStatusPayload, maxChunkCharacters: 100_001 })).toEqual({ enabled: false });
    expect(parseSpeechStatus({ enabled: false })).toEqual({ enabled: false });
  });

  it("validates persisted options against the current status", () => {
    if (!enabled.enabled) throw new Error("fixture disabled");
    expect(resolveSpeechPreferences(enabled, { voice: "voice-alternate", style: "style-brief" })).toEqual({ voice: "voice-alternate", style: "style-brief" });
    expect(resolveSpeechPreferences(enabled, { voice: "retired", style: "unknown" })).toEqual({ voice: "voice-default", style: "style-default" });
  });

  it("resolves available settings options even while speech is disabled", () => {
    const settings = parseSpeechSettings(disabledSettingsPayload);
    expect(resolveSpeechPreferences(settings, { voice: "voice-alternate", style: "style-brief" })).toEqual({
      voice: "voice-alternate",
      style: "style-brief",
    });
  });

  it("ignores malformed storage and uses the canonical key", () => {
    expect(SPEECH_PREFERENCES_KEY).toBe("ocode.speech-preferences");
    expect(parseStoredSpeechPreferences("not-json")).toEqual({});
    expect(parseStoredSpeechPreferences('{"voice":4,"style":"style-brief"}')).toEqual({ voice: undefined, style: "style-brief" });
  });
});

describe("speech settings client", () => {
  it("strictly parses metadata without retaining unexpected key material", () => {
    const settings = parseSpeechSettings({ ...disabledSettingsPayload, apiKey: "sk-never-return-this" });
    expect(settings).toEqual(disabledSettingsPayload);
    expect(JSON.stringify(settings)).not.toContain("sk-never-return-this");
    expect(() => parseSpeechSettings({ ...disabledSettingsPayload, keySource: "file" })).toThrow("invalid voice settings");
    expect(() => parseSpeechSettings({ ...disabledSettingsPayload, voices: [] })).toThrow("invalid voice settings");
  });

  it("uses safe same-origin GET, PUT, and DELETE requests", async () => {
    const getFetcher = vi.fn(async () => new Response(JSON.stringify(disabledSettingsPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    await expect(getSpeechSettings(getFetcher)).resolves.toEqual(disabledSettingsPayload);
    expect(getFetcher).toHaveBeenCalledWith("/api/v1/settings/speech", expect.objectContaining({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    }));

    const storedPayload = { ...disabledSettingsPayload, enabled: true, hasStoredKey: true, keySource: "settings" };
    const putFetcher = vi.fn(async () => new Response(JSON.stringify(storedPayload), { status: 200 })) as unknown as typeof fetch;
    await expect(putSpeechApiKey("sk-test-secret", putFetcher)).resolves.toEqual(storedPayload);
    expect(putFetcher).toHaveBeenCalledWith("/api/v1/settings/speech", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ apiKey: "sk-test-secret" }),
      credentials: "same-origin",
    }));

    const deleteFetcher = vi.fn(async () => new Response(JSON.stringify(disabledSettingsPayload), { status: 200 })) as unknown as typeof fetch;
    await expect(deleteStoredSpeechApiKey(deleteFetcher)).resolves.toEqual(disabledSettingsPayload);
    expect(deleteFetcher).toHaveBeenCalledWith("/api/v1/settings/speech", expect.objectContaining({
      method: "DELETE",
      credentials: "same-origin",
    }));
  });

  it("treats blank key input as keep, requires a key only when none is effective, and sanitizes errors", async () => {
    expect(speechApiKeyForSave("   ")).toBeUndefined();
    expect(speechApiKeyForSave("  sk-new  ")).toBe("sk-new");
    expect(speechSettingsRequireApiKey({ keySource: null }, " ")).toBe(true);
    expect(speechSettingsRequireApiKey({ keySource: "environment" }, " ")).toBe(false);

    const secret = "sk-super-secret-value";
    const failedFetcher = vi.fn(async () => new Response(JSON.stringify({ message: `Rejected ${secret}` }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    let message = "";
    try {
      await putSpeechApiKey(secret, failedFetcher);
    } catch (error) {
      message = sanitizeSpeechError(error, secret);
    }
    expect(message).toContain("Rejected");
    expect(message).not.toContain(secret);
  });
});
