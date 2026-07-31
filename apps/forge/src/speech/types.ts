export const MAX_SPEECH_REQUEST_BYTES = 16 * 1024;
export const DEFAULT_DAILY_CHARACTER_LIMIT = 100_000;
export const DEFAULT_DAILY_REQUEST_LIMIT = 250;

export interface SpeechConfig {
  provider: string;
  voice?: string;
  style?: string;
  dailyCharacterLimit: number;
  dailyRequestLimit: number;
}

export interface SpeechOption {
  id: string;
  label: string;
  description: string;
}

export interface SpeechProviderCapabilities {
  /** Changes whenever output-affecting provider configuration, such as its model, changes. */
  cacheVersion: string;
  defaultStyle: string;
  defaultVoice: string;
  maxInputCharacters: number;
  outputMediaType: string;
  providerId: string;
  styles: readonly SpeechOption[];
  voices: readonly SpeechOption[];
}

export interface SpeechClip {
  bytes: Uint8Array;
  mediaType: string;
}

export interface SpeechProviderRequest {
  text: string;
  voice: string;
  style: string;
}

export interface SpeechProvider {
  readonly capabilities: SpeechProviderCapabilities;
  generate(request: SpeechProviderRequest, signal?: AbortSignal): Promise<SpeechClip>;
}

export interface SpeechStatus {
  enabled: true;
  provider: string;
  defaultVoice: string;
  defaultStyle: string;
  maxChunkCharacters: number;
  voices: SpeechOption[];
  styles: SpeechOption[];
}

export interface SpeechDisabledStatus {
  enabled: false;
}

export interface SpeechSettingsStatus extends Omit<SpeechStatus, "enabled"> {
  enabled: boolean;
  hasStoredKey: boolean;
  keySource: "settings" | "environment" | null;
  dailyCharacterLimit: number;
  dailyRequestLimit: number;
}

export const DEFAULT_SPEECH_CONFIG: Readonly<SpeechConfig> = {
  provider: "openai",
  voice: "marin",
  style: "natural",
  dailyCharacterLimit: DEFAULT_DAILY_CHARACTER_LIMIT,
  dailyRequestLimit: DEFAULT_DAILY_REQUEST_LIMIT,
};

export class SpeechError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}
