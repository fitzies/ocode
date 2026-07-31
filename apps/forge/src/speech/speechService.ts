import { createHash } from "node:crypto";

import type { SpeechUsageStore } from "./speechUsageStore.ts";
import {
  SpeechError,
  type SpeechClip,
  type SpeechConfig,
  type SpeechOption,
  type SpeechProvider,
  type SpeechProviderCapabilities,
  type SpeechStatus,
} from "./types.ts";

const MAX_CONCURRENT_GENERATIONS = 2;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  clip: SpeechClip;
  byteLength: number;
  expiresAt: number;
}

interface InflightEntry {
  controller: AbortController;
  promise: Promise<SpeechClip>;
  subscribers: number;
}

export interface SpeechRequest {
  text: string;
  voice?: unknown;
  style?: unknown;
}

export class SpeechService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly capabilities: SpeechProviderCapabilities;
  private readonly defaultStyle: string;
  private readonly defaultVoice: string;
  private cacheBytes = 0;
  private activeGenerations = 0;
  private closed = false;

  constructor(
    private readonly config: SpeechConfig,
    private readonly provider: SpeechProvider,
    private readonly usage: SpeechUsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.capabilities = provider.capabilities;
    this.validateCapabilities(this.capabilities);
    if (config.provider !== this.capabilities.providerId) {
      throw new Error(`Speech provider ${this.capabilities.providerId} does not match configured provider ${config.provider}`);
    }
    this.defaultVoice = this.configuredOption("voice", config.voice, this.capabilities.defaultVoice, this.capabilities.voices);
    this.defaultStyle = this.configuredOption("style", config.style, this.capabilities.defaultStyle, this.capabilities.styles);
  }

  status(): SpeechStatus {
    return {
      enabled: true,
      provider: this.capabilities.providerId,
      defaultVoice: this.defaultVoice,
      defaultStyle: this.defaultStyle,
      maxChunkCharacters: this.capabilities.maxInputCharacters,
      voices: this.publicOptions(this.capabilities.voices),
      styles: this.publicOptions(this.capabilities.styles),
    };
  }

  async generate(input: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    if (this.closed) throw new SpeechError("speech_unavailable", "Speech service is shutting down", 503, true);
    if (signal?.aborted) throw new SpeechError("speech_aborted", "Speech generation was cancelled", 499);
    if (typeof input.text !== "string") {
      throw new SpeechError("invalid_speech_text", "Speech text must be a string", 400);
    }

    if (Array.from(input.text).length > this.capabilities.maxInputCharacters) {
      throw new SpeechError(
        "speech_text_too_long",
        `Speech text exceeds ${this.capabilities.maxInputCharacters} characters`,
        413,
      );
    }
    const text = input.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
    const characters = Array.from(text).length;
    if (characters === 0) throw new SpeechError("invalid_speech_text", "Speech text must not be empty", 400);
    const voice = this.voice(input.voice);
    const style = this.style(input.style);
    const key = createHash("sha256")
      .update(this.capabilities.providerId).update("\0")
      .update(this.capabilities.cacheVersion).update("\0")
      .update(voice).update("\0")
      .update(style).update("\0")
      .update(text)
      .digest("hex");

    const cached = this.cached(key);
    if (cached) return cached;
    const existing = this.inflight.get(key);
    if (existing) return this.subscribe(existing, signal);
    if (this.activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      throw new SpeechError("speech_concurrency_limit", "Too many speech generations are already running", 429, true, 1);
    }

    const date = this.now().toISOString().slice(0, 10);
    const reservation = this.usage.reserve(date, characters, {
      characters: this.config.dailyCharacterLimit,
      requests: this.config.dailyRequestLimit,
    });
    if (!reservation.accepted) {
      throw new SpeechError(
        reservation.limit === "characters" ? "speech_daily_character_limit" : "speech_daily_request_limit",
        reservation.limit === "characters"
          ? "Daily speech character limit reached"
          : "Daily speech request limit reached",
        429,
        false,
        this.secondsUntilNextUtcDay(),
      );
    }

    const controller = new AbortController();
    this.activeGenerations += 1;
    let generation: Promise<SpeechClip>;
    try {
      generation = this.provider.generate({ text, voice, style }, controller.signal);
    } catch (error) {
      this.activeGenerations -= 1;
      throw error;
    }
    const promise = generation.then((clip) => {
      if (clip.mediaType !== this.capabilities.outputMediaType || clip.bytes.byteLength === 0) {
        throw new SpeechError("speech_upstream_invalid", "Speech provider returned invalid audio", 502, true);
      }
      const stable = { bytes: Uint8Array.from(clip.bytes), mediaType: this.capabilities.outputMediaType };
      this.storeCache(key, stable);
      return stable;
    }).finally(() => {
      this.activeGenerations -= 1;
      this.inflight.delete(key);
    });
    const entry: InflightEntry = { controller, promise, subscribers: 0 };
    // A disconnected sole subscriber may leave the provider settling after its
    // waiter has gone away. Keep that rejection handled without changing it.
    void entry.promise.catch(() => undefined);
    this.inflight.set(key, entry);
    return this.subscribe(entry, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.inflight.values()) entry.controller.abort();
    await Promise.allSettled([...this.inflight.values()].map(({ promise }) => promise));
    this.inflight.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private voice(value: unknown): string {
    if (value === undefined) return this.defaultVoice;
    if (typeof value !== "string" || !this.capabilities.voices.some(({ id }) => id === value)) {
      throw new SpeechError("invalid_speech_voice", "Speech voice is not supported", 400);
    }
    return value;
  }

  private style(value: unknown): string {
    if (value === undefined) return this.defaultStyle;
    if (typeof value !== "string" || !this.capabilities.styles.some(({ id }) => id === value)) {
      throw new SpeechError("invalid_speech_style", "Speech style is not supported", 400);
    }
    return value;
  }

  private configuredOption(
    kind: "voice" | "style",
    configured: string | undefined,
    fallback: string,
    options: readonly SpeechOption[],
  ): string {
    const value = configured ?? fallback;
    if (!options.some(({ id }) => id === value)) {
      throw new Error(`Configured speech ${kind} is not supported by provider ${this.capabilities.providerId}: ${value}`);
    }
    return value;
  }

  private publicOptions(options: readonly SpeechOption[]): SpeechOption[] {
    return options.map(({ id, label, description }) => ({ id, label, description }));
  }

  private validateCapabilities(capabilities: SpeechProviderCapabilities): void {
    for (const [name, value] of [
      ["providerId", capabilities.providerId],
      ["cacheVersion", capabilities.cacheVersion],
      ["outputMediaType", capabilities.outputMediaType],
    ] as const) {
      if (!value) throw new Error(`Speech provider capability ${name} must not be empty`);
    }
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(capabilities.outputMediaType)) {
      throw new Error("Speech provider outputMediaType must be a valid fixed media type");
    }
    if (!Number.isSafeInteger(capabilities.maxInputCharacters) || capabilities.maxInputCharacters < 1) {
      throw new Error("Speech provider maxInputCharacters must be a positive safe integer");
    }
    for (const [kind, options, fallback] of [
      ["voice", capabilities.voices, capabilities.defaultVoice],
      ["style", capabilities.styles, capabilities.defaultStyle],
    ] as const) {
      if (!options.some(({ id }) => id === fallback)) {
        throw new Error(`Speech provider default ${kind} is not present in its options: ${fallback}`);
      }
      const ids = new Set<string>();
      for (const option of options) {
        if (!option.id || !option.label || !option.description || ids.has(option.id)) {
          throw new Error(`Speech provider has an invalid ${kind} option: ${option.id}`);
        }
        ids.add(option.id);
      }
    }
  }

  private subscribe(entry: InflightEntry, signal?: AbortSignal): Promise<SpeechClip> {
    if (signal?.aborted) return Promise.reject(new SpeechError("speech_aborted", "Speech generation was cancelled", 499));
    entry.subscribers += 1;
    return new Promise<SpeechClip>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers -= 1;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        if (entry.subscribers === 0) entry.controller.abort();
        reject(new SpeechError("speech_aborted", "Speech generation was cancelled", 499));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (clip) => { if (finish()) resolve(clip); },
        (error: unknown) => { if (finish()) reject(error); },
      );
    });
  }

  private cached(key: string): SpeechClip | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now().getTime()) {
      this.cache.delete(key);
      this.cacheBytes -= entry.byteLength;
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.clip;
  }

  private storeCache(key: string, clip: SpeechClip): void {
    const byteLength = clip.bytes.byteLength;
    if (byteLength > CACHE_MAX_BYTES) return;
    const timestamp = this.now().getTime();
    for (const [candidate, entry] of this.cache) {
      if (entry.expiresAt <= timestamp) {
        this.cache.delete(candidate);
        this.cacheBytes -= entry.byteLength;
      }
    }
    while (this.cacheBytes + byteLength > CACHE_MAX_BYTES) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cacheBytes -= oldest[1].byteLength;
    }
    this.cache.set(key, { clip, byteLength, expiresAt: timestamp + CACHE_TTL_MS });
    this.cacheBytes += byteLength;
  }

  private secondsUntilNextUtcDay(): number {
    const now = this.now();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1, Math.ceil((next - now.getTime()) / 1_000));
  }
}
