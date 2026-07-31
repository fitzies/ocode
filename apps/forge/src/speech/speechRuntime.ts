import type { ForgeDatabase } from "../store/database.ts";
import { OpenAiSpeechProvider, OPENAI_SPEECH_CAPABILITIES } from "./openaiSpeechProvider.ts";
import { SpeechSecretsStore, normalizeSpeechApiKey } from "./speechSecretsStore.ts";
import { SpeechService, type SpeechRequest } from "./speechService.ts";
import { SpeechUsageStore } from "./speechUsageStore.ts";
import {
  DEFAULT_SPEECH_CONFIG,
  SpeechError,
  type SpeechClip,
  type SpeechConfig,
  type SpeechDisabledStatus,
  type SpeechProvider,
  type SpeechSettingsStatus,
  type SpeechStatus,
} from "./types.ts";

export interface SpeechController {
  status(): SpeechStatus | SpeechDisabledStatus;
  settingsStatus(): SpeechSettingsStatus;
  generate(input: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip>;
  updateKey(apiKey: string): Promise<SpeechSettingsStatus>;
  removeStoredKey(): Promise<SpeechSettingsStatus>;
  close(): Promise<void>;
}

interface ManagedSpeechService {
  status(): SpeechStatus;
  generate(input: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip>;
  close(): Promise<void>;
}

export interface SpeechRuntimeOptions {
  secretsDirectory: string;
  database: ForgeDatabase;
  config?: SpeechConfig;
  environmentApiKey?: string;
  providerFactory?: (apiKey: string) => SpeechProvider;
  serviceFactory?: (
    config: SpeechConfig,
    provider: SpeechProvider,
    usage: SpeechUsageStore,
  ) => ManagedSpeechService;
  secretsStore?: SpeechSecretsStore;
}

/** Owns mutable speech credentials and atomically swaps the active service. */
export class SpeechRuntime implements SpeechController {
  private readonly config: SpeechConfig;
  private readonly environmentApiKey?: string;
  private readonly providerFactory: (apiKey: string) => SpeechProvider;
  private readonly serviceFactory: NonNullable<SpeechRuntimeOptions["serviceFactory"]>;
  private readonly secrets: SpeechSecretsStore;
  private readonly usage: SpeechUsageStore;
  private service?: ManagedSpeechService;
  private storedKey?: string;
  private mutations: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: SpeechRuntimeOptions) {
    this.config = { ...DEFAULT_SPEECH_CONFIG, ...options.config };
    this.validateConfig();
    this.environmentApiKey = options.environmentApiKey?.trim() || undefined;
    this.providerFactory = options.providerFactory ?? ((apiKey) => new OpenAiSpeechProvider(apiKey));
    this.serviceFactory = options.serviceFactory ?? ((config, provider, usage) => new SpeechService(config, provider, usage));
    this.secrets = options.secretsStore ?? new SpeechSecretsStore(options.secretsDirectory);
    this.usage = new SpeechUsageStore(options.database);
    this.storedKey = this.secrets.load();
    const key = this.storedKey ?? this.environmentApiKey;
    if (key) this.service = this.createService(key);
  }

  status(): SpeechStatus | SpeechDisabledStatus {
    if (this.closed || !this.service) return { enabled: false };
    return this.service.status();
  }

  settingsStatus(): SpeechSettingsStatus {
    const active = !this.closed && Boolean(this.service);
    return {
      enabled: active,
      hasStoredKey: Boolean(this.storedKey),
      keySource: active ? (this.storedKey ? "settings" : "environment") : null,
      provider: OPENAI_SPEECH_CAPABILITIES.providerId,
      defaultVoice: this.config.voice ?? OPENAI_SPEECH_CAPABILITIES.defaultVoice,
      defaultStyle: this.config.style ?? OPENAI_SPEECH_CAPABILITIES.defaultStyle,
      maxChunkCharacters: OPENAI_SPEECH_CAPABILITIES.maxInputCharacters,
      voices: OPENAI_SPEECH_CAPABILITIES.voices.map((option) => ({ ...option })),
      styles: OPENAI_SPEECH_CAPABILITIES.styles.map((option) => ({ ...option })),
      dailyCharacterLimit: this.config.dailyCharacterLimit,
      dailyRequestLimit: this.config.dailyRequestLimit,
    };
  }

  generate(input: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    if (this.closed) {
      return Promise.reject(new SpeechError("speech_unavailable", "Speech service is shutting down", 503, true));
    }
    const service = this.service;
    if (!service) {
      return Promise.reject(new SpeechError("speech_disabled", "Text-to-speech is not enabled", 503));
    }
    return service.generate(input, signal);
  }

  updateKey(apiKey: string): Promise<SpeechSettingsStatus> {
    return this.mutate(async () => {
      this.ensureOpen();
      const key = normalizeSpeechApiKey(apiKey);
      const replacement = this.createService(key);
      try {
        this.secrets.save(key);
      } catch (error) {
        await replacement.close();
        throw error;
      }
      const previous = this.service;
      this.storedKey = key;
      this.service = replacement;
      await previous?.close();
      return this.settingsStatus();
    });
  }

  removeStoredKey(): Promise<SpeechSettingsStatus> {
    return this.mutate(async () => {
      this.ensureOpen();
      const replacement = this.environmentApiKey ? this.createService(this.environmentApiKey) : undefined;
      try {
        this.secrets.delete();
      } catch (error) {
        await replacement?.close();
        throw error;
      }
      const previous = this.service;
      this.storedKey = undefined;
      this.service = replacement;
      await previous?.close();
      return this.settingsStatus();
    });
  }

  close(): Promise<void> {
    if (this.closed) return this.mutations;
    this.closed = true;
    return this.mutate(async () => {
      const service = this.service;
      this.service = undefined;
      await service?.close();
    });
  }

  private createService(apiKey: string): ManagedSpeechService {
    return this.serviceFactory(this.config, this.providerFactory(apiKey), this.usage);
  }

  private validateConfig(): void {
    if (this.config.provider !== OPENAI_SPEECH_CAPABILITIES.providerId) {
      throw new Error(`Unsupported speech provider: ${this.config.provider}`);
    }
    for (const [kind, value, options] of [
      ["voice", this.config.voice, OPENAI_SPEECH_CAPABILITIES.voices],
      ["style", this.config.style, OPENAI_SPEECH_CAPABILITIES.styles],
    ] as const) {
      if (value !== undefined && !options.some(({ id }) => id === value)) {
        throw new Error(`Configured speech ${kind} is not supported by provider openai: ${value}`);
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Speech runtime is closed");
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}
