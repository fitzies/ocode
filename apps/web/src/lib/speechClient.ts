export const SPEECH_PREFERENCES_KEY = "ocode.speech-preferences";

// Keep malformed metadata from causing excessive client-side allocations while
// allowing providers with substantially larger limits than today's defaults.
const MAX_SPEECH_CHUNK_CHARACTERS = 100_000;

export type SpeechOption = {
  id: string;
  label: string;
  description: string;
};

export type SpeechStatus =
  | { enabled: false }
  | {
      enabled: true;
      provider: string;
      defaultVoice: string;
      defaultStyle: string;
      maxChunkCharacters: number;
      voices: SpeechOption[];
      styles: SpeechOption[];
    };

export type SpeechPreferences = { voice: string; style: string };

export type SpeechKeySource = "settings" | "environment" | null;

export type SpeechSettings = {
  enabled: boolean;
  hasStoredKey: boolean;
  keySource: SpeechKeySource;
  provider: string;
  defaultVoice: string;
  defaultStyle: string;
  maxChunkCharacters: number;
  voices: SpeechOption[];
  styles: SpeechOption[];
  dailyCharacterLimit: number;
  dailyRequestLimit: number;
};

type SpeechMetadata = Pick<
  SpeechSettings,
  "defaultVoice" | "defaultStyle" | "voices" | "styles"
>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type FetchLike = typeof fetch;

function isOption(value: unknown): value is SpeechOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Partial<SpeechOption>;
  return typeof option.id === "string" && Boolean(option.id) &&
    typeof option.label === "string" && Boolean(option.label) &&
    typeof option.description === "string";
}

export function parseSpeechStatus(value: unknown): SpeechStatus {
  if (!value || typeof value !== "object") return { enabled: false };
  const status = value as Partial<Extract<SpeechStatus, { enabled: true }>> & { enabled?: unknown };
  if (status.enabled !== true) return { enabled: false };
  if (
    typeof status.provider !== "string" || !status.provider.trim() ||
    typeof status.defaultVoice !== "string" ||
    typeof status.defaultStyle !== "string" ||
    !Number.isInteger(status.maxChunkCharacters) ||
    (status.maxChunkCharacters ?? 0) < 1 ||
    (status.maxChunkCharacters ?? 0) > MAX_SPEECH_CHUNK_CHARACTERS ||
    !Array.isArray(status.voices) || !status.voices.every(isOption) ||
    !Array.isArray(status.styles) || !status.styles.every(isOption) ||
    !status.voices.some((option) => option.id === status.defaultVoice) ||
    !status.styles.some((option) => option.id === status.defaultStyle)
  ) return { enabled: false };
  return status as Extract<SpeechStatus, { enabled: true }>;
}

export async function getSpeechStatus(fetcher: FetchLike = fetch): Promise<SpeechStatus> {
  try {
    const response = await fetcher("/api/v1/speech/status", { signal: undefined, cache: "no-store" });
    if (!response.ok) return { enabled: false };
    return parseSpeechStatus(await response.json());
  } catch {
    return { enabled: false };
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Parses only the documented settings fields so a provider can never return key material to UI state. */
export function parseSpeechSettings(value: unknown): SpeechSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Forge returned invalid voice settings");
  }
  const settings = value as Record<string, unknown>;
  const keySource = settings.keySource;
  if (
    typeof settings.enabled !== "boolean" ||
    typeof settings.hasStoredKey !== "boolean" ||
    (keySource !== "settings" && keySource !== "environment" && keySource !== null) ||
    typeof settings.provider !== "string" || !settings.provider.trim() ||
    typeof settings.defaultVoice !== "string" ||
    typeof settings.defaultStyle !== "string" ||
    !isPositiveInteger(settings.maxChunkCharacters) ||
    settings.maxChunkCharacters > MAX_SPEECH_CHUNK_CHARACTERS ||
    !Array.isArray(settings.voices) || !settings.voices.every(isOption) ||
    !Array.isArray(settings.styles) || !settings.styles.every(isOption) ||
    !settings.voices.some((option) => option.id === settings.defaultVoice) ||
    !settings.styles.some((option) => option.id === settings.defaultStyle) ||
    !isPositiveInteger(settings.dailyCharacterLimit) ||
    !isPositiveInteger(settings.dailyRequestLimit)
  ) {
    throw new Error("Forge returned invalid voice settings");
  }
  return {
    enabled: settings.enabled,
    hasStoredKey: settings.hasStoredKey,
    keySource,
    provider: settings.provider,
    defaultVoice: settings.defaultVoice,
    defaultStyle: settings.defaultStyle,
    maxChunkCharacters: settings.maxChunkCharacters,
    voices: settings.voices,
    styles: settings.styles,
    dailyCharacterLimit: settings.dailyCharacterLimit,
    dailyRequestLimit: settings.dailyRequestLimit,
  };
}

export function speechApiKeyForSave(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function speechSettingsRequireApiKey(settings: Pick<SpeechSettings, "keySource">, value: string): boolean {
  return settings.keySource === null && speechApiKeyForSave(value) === undefined;
}

export function sanitizeSpeechError(error: unknown, secret?: string): string {
  const fallback = "Voice settings could not be updated";
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  let message = error.message;
  if (secret) message = message.split(secret).join("[hidden]");
  message = message
    .replace(/[\r\n\t\0-\x1f\x7f]+/g, " ")
    .trim()
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[hidden]")
    .slice(0, 240);
  return message || fallback;
}

async function settingsApiError(response: Response, fallback: string, secret?: string): Promise<Error> {
  let message = fallback;
  try {
    const body = await response.json() as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.error === "string") message = body.error;
    else if (body.error && typeof body.error === "object" && "message" in body.error) {
      const nested = (body.error as { message?: unknown }).message;
      if (typeof nested === "string") message = nested;
    }
  } catch {
    // Keep the stable operation-specific fallback.
  }
  return new Error(sanitizeSpeechError(new Error(message), secret));
}

export async function getSpeechSettings(fetcher: FetchLike = fetch): Promise<SpeechSettings> {
  const response = await fetcher("/api/v1/settings/speech", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw await settingsApiError(response, "Voice settings are unavailable");
  return parseSpeechSettings(await response.json());
}

export async function putSpeechApiKey(apiKey: string, fetcher: FetchLike = fetch): Promise<SpeechSettings> {
  const response = await fetcher("/api/v1/settings/speech", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
    credentials: "same-origin",
  });
  if (!response.ok) throw await settingsApiError(response, "The API key could not be saved", apiKey);
  return parseSpeechSettings(await response.json());
}

export async function deleteStoredSpeechApiKey(fetcher: FetchLike = fetch): Promise<SpeechSettings> {
  const response = await fetcher("/api/v1/settings/speech", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) throw await settingsApiError(response, "The saved API key could not be removed");
  return parseSpeechSettings(await response.json());
}

export function parseStoredSpeechPreferences(value: string | null): Partial<SpeechPreferences> {
  if (value === null) return {};
  try {
    const parsed = JSON.parse(value) as Partial<SpeechPreferences> | null;
    return {
      voice: typeof parsed?.voice === "string" ? parsed.voice : undefined,
      style: typeof parsed?.style === "string" ? parsed.style : undefined,
    };
  } catch {
    return {};
  }
}

export function resolveSpeechPreferences(
  metadata: SpeechMetadata,
  stored: Partial<SpeechPreferences>,
): SpeechPreferences {
  return {
    voice: metadata.voices.some((option) => option.id === stored.voice) ? stored.voice! : metadata.defaultVoice,
    style: metadata.styles.some((option) => option.id === stored.style) ? stored.style! : metadata.defaultStyle,
  };
}

export function loadSpeechPreferences(storage?: StorageLike): Partial<SpeechPreferences> {
  try {
    const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!target) return {};
    return parseStoredSpeechPreferences(target.getItem(SPEECH_PREFERENCES_KEY));
  } catch {
    return {};
  }
}

export function saveSpeechPreferences(preferences: SpeechPreferences, storage?: StorageLike): void {
  try {
    const target = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    target?.setItem(SPEECH_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Speech still works when private browsing or device policy blocks storage.
  }
}

async function apiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Fall through to the stable status-based message.
  }
  return response.status === 413 ? "Response is too long for this speech clip" : "Speech is unavailable";
}

export async function fetchSpeechClip(
  request: { text: string; voice: string; style: string },
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<Blob> {
  const response = await fetcher("/api/v1/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await apiError(response));
  return response.blob();
}
