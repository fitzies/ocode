import {
  SpeechError,
  type SpeechClip,
  type SpeechProvider,
  type SpeechProviderCapabilities,
  type SpeechProviderRequest,
} from "./types.ts";

export const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy", description: "OpenAI's Alloy voice." },
  { id: "ash", label: "Ash", description: "OpenAI's Ash voice." },
  { id: "ballad", label: "Ballad", description: "OpenAI's Ballad voice." },
  { id: "coral", label: "Coral", description: "OpenAI's Coral voice." },
  { id: "echo", label: "Echo", description: "OpenAI's Echo voice." },
  { id: "fable", label: "Fable", description: "OpenAI's Fable voice." },
  { id: "nova", label: "Nova", description: "OpenAI's Nova voice." },
  { id: "onyx", label: "Onyx", description: "OpenAI's Onyx voice." },
  { id: "sage", label: "Sage", description: "OpenAI's Sage voice." },
  { id: "shimmer", label: "Shimmer", description: "OpenAI's Shimmer voice." },
  { id: "verse", label: "Verse", description: "OpenAI's Verse voice." },
  { id: "marin", label: "Marin", description: "OpenAI's Marin voice." },
  { id: "cedar", label: "Cedar", description: "OpenAI's Cedar voice." },
] as const;

const OPENAI_STYLES = [
  {
    id: "natural",
    label: "Natural",
    description: "Conversational, clear, and neutrally expressive.",
    instructions: "Speak naturally and conversationally, with clear pacing and neutral expression.",
  },
  {
    id: "warm",
    label: "Warm",
    description: "Friendly, reassuring, and relaxed.",
    instructions: "Speak with a warm, friendly, and reassuring tone at a relaxed pace.",
  },
  {
    id: "focused",
    label: "Focused",
    description: "Concise, precise, and steady.",
    instructions: "Speak in a focused, precise manner with steady pacing and minimal dramatic emphasis.",
  },
  {
    id: "lively",
    label: "Lively",
    description: "Energetic, upbeat, and engaging.",
    instructions: "Speak with lively, upbeat energy and engaging emphasis while remaining clear.",
  },
  {
    id: "gentle",
    label: "Gentle",
    description: "Soft, calm, and unhurried.",
    instructions: "Speak gently and calmly with soft expression and an unhurried pace.",
  },
] as const;

export const OPENAI_SPEECH_CAPABILITIES: SpeechProviderCapabilities = {
  providerId: "openai",
  cacheVersion: OPENAI_SPEECH_MODEL,
  outputMediaType: "audio/mpeg",
  maxInputCharacters: 3_500,
  defaultVoice: "marin",
  defaultStyle: "natural",
  voices: OPENAI_VOICES.map(({ id, label, description }) => ({ id, label, description })),
  styles: OPENAI_STYLES.map(({ id, label, description }) => ({ id, label, description })),
};
const UPSTREAM_TIMEOUT_MS = 90_000;
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024;
const ALLOWED_MP3_MEDIA_TYPES = new Set(["audio/mpeg", "audio/mp3"]);

function hasMpegFrameHeader(bytes: Uint8Array, offset: number): boolean {
  return bytes.length >= offset + 4 &&
    bytes[offset] === 0xff &&
    (bytes[offset + 1]! & 0xe0) === 0xe0 &&
    (bytes[offset + 1]! & 0x06) !== 0 &&
    (bytes[offset + 2]! & 0xf0) !== 0 &&
    (bytes[offset + 2]! & 0xf0) !== 0xf0 &&
    (bytes[offset + 2]! & 0x0c) !== 0x0c;
}

function isMp3(bytes: Uint8Array): boolean {
  if (hasMpegFrameHeader(bytes, 0)) return true;
  if (bytes.length < 14 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return false;
  if (bytes[3] === 0xff || bytes[4] === 0xff || (bytes[5]! & 0x0f) !== 0) return false;
  if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => (value! & 0x80) !== 0)) return false;
  const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
  return hasMpegFrameHeader(bytes, 10 + tagSize);
}

async function readBounded(response: Response, controller: AbortController): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechError("speech_upstream_too_large", "Speech provider returned too much audio", 502, true);
  }
  if (!response.body) throw new SpeechError("speech_upstream_invalid", "Speech provider returned no audio", 502, true);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new SpeechError("speech_upstream_too_large", "Speech provider returned too much audio", 502, true);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class OpenAiSpeechProvider implements SpeechProvider {
  readonly capabilities = OPENAI_SPEECH_CAPABILITIES;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = UPSTREAM_TIMEOUT_MS,
  ) {}

  async generate(request: SpeechProviderRequest, signal?: AbortSignal): Promise<SpeechClip> {
    const voice = OPENAI_VOICES.find(({ id }) => id === request.voice);
    const style = OPENAI_STYLES.find(({ id }) => id === request.style);
    if (!voice || !style) {
      throw new SpeechError("speech_provider_invalid_request", "Unsupported OpenAI speech option", 500);
    }
    if (signal?.aborted) throw new SpeechError("speech_aborted", "Speech generation was cancelled", 499);

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.fetchImplementation(OPENAI_SPEECH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model: OPENAI_SPEECH_MODEL,
          input: request.text,
          voice: voice.id,
          response_format: "mp3",
          instructions: style.instructions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError("speech_upstream_failed", "Speech provider could not generate audio", 502, true);
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!mediaType || !ALLOWED_MP3_MEDIA_TYPES.has(mediaType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError("speech_upstream_invalid", "Speech provider returned an unsupported audio type", 502, true);
      }
      const bytes = await readBounded(response, controller);
      if (!isMp3(bytes)) {
        throw new SpeechError("speech_upstream_invalid", "Speech provider returned invalid MP3 audio", 502, true);
      }
      return { bytes, mediaType: this.capabilities.outputMediaType };
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      if (timedOut) {
        throw new SpeechError("speech_upstream_timeout", "Speech provider timed out", 504, true);
      }
      if (signal?.aborted) {
        throw new SpeechError("speech_aborted", "Speech generation was cancelled", 499);
      }
      throw new SpeechError("speech_upstream_failed", "Speech provider could not generate audio", 502, true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}
