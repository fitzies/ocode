import type { IncomingMessage, ServerResponse } from "node:http";

import { ANVIL_PROTOCOL_VERSION, type AnvilApiError } from "@anvil/protocol";

import { OPENAI_SPEECH_CAPABILITIES } from "../speech/openaiSpeechProvider.ts";
import type { SpeechController } from "../speech/speechRuntime.ts";
import { normalizeSpeechApiKey } from "../speech/speechSecretsStore.ts";
import {
  DEFAULT_SPEECH_CONFIG,
  MAX_SPEECH_REQUEST_BYTES,
  SpeechError,
  type SpeechSettingsStatus,
} from "../speech/types.ts";
import { sameOrigin } from "./security.ts";

function apiError(code: string, message: string, retryable = false): AnvilApiError {
  return { protocolVersion: ANVIL_PROTOCOL_VERSION, code, message, retryable };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  retryAfterSeconds?: number,
): void {
  if (response.destroyed || response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  const declaredLength = typeof declared === "string" ? Number(declared) : 0;
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SPEECH_REQUEST_BYTES) {
    request.resume();
    throw new SpeechError("speech_request_too_large", "Speech request body exceeds 16 KiB", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_SPEECH_REQUEST_BYTES) {
      throw new SpeechError("speech_request_too_large", "Speech request body exceeds 16 KiB", 413);
    }
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new SpeechError("invalid_json", "Speech request body is not valid JSON", 400);
  }
}

function disabledSettingsStatus(): SpeechSettingsStatus {
  return {
    enabled: false,
    hasStoredKey: false,
    keySource: null,
    provider: OPENAI_SPEECH_CAPABILITIES.providerId,
    defaultVoice: DEFAULT_SPEECH_CONFIG.voice!,
    defaultStyle: DEFAULT_SPEECH_CONFIG.style!,
    maxChunkCharacters: OPENAI_SPEECH_CAPABILITIES.maxInputCharacters,
    voices: OPENAI_SPEECH_CAPABILITIES.voices.map((option) => ({ ...option })),
    styles: OPENAI_SPEECH_CAPABILITIES.styles.map((option) => ({ ...option })),
    dailyCharacterLimit: DEFAULT_SPEECH_CONFIG.dailyCharacterLimit,
    dailyRequestLimit: DEFAULT_SPEECH_CONFIG.dailyRequestLimit,
  };
}

export class SpeechRoutes {
  constructor(private readonly speech?: SpeechController) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/api/v1/speech/status") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendJson(response, 405, apiError("method_not_allowed", "Method not allowed"));
      } else {
        sendJson(response, 200, this.speech?.status() ?? { enabled: false });
      }
      return true;
    }
    if (url.pathname === "/api/v1/settings/speech") {
      await this.settings(request, response);
      return true;
    }
    if (url.pathname !== "/api/v1/speech") return false;
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, apiError("method_not_allowed", "Method not allowed"));
      return true;
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return true;
    }
    if (!this.isJson(request)) {
      sendJson(response, 415, apiError("unsupported_media_type", "Speech requests require application/json"));
      return true;
    }
    if (!this.speech || !this.speech.status().enabled) {
      request.resume();
      sendJson(response, 503, apiError("speech_disabled", "Text-to-speech is not enabled"));
      return true;
    }

    try {
      const body = await readBody(request);
      const unsupported = Object.keys(body).find((key) => !["text", "voice", "style"].includes(key));
      if (unsupported) throw new SpeechError("invalid_speech_request", `Unsupported speech request property: ${unsupported}`, 400);
      if (typeof body.text !== "string") throw new SpeechError("invalid_speech_text", "Speech text must be a string", 400);

      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      const abortResponse = () => {
        if (!response.writableEnded) controller.abort();
      };
      request.once("aborted", abortRequest);
      response.once("close", abortResponse);
      try {
        const clip = await this.speech.generate({
          text: body.text,
          voice: body.voice,
          style: body.style,
        }, controller.signal);
        if (response.destroyed || controller.signal.aborted) return true;
        response.writeHead(200, {
          "content-type": clip.mediaType,
          "content-length": clip.bytes.byteLength,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        });
        response.end(clip.bytes);
      } finally {
        request.off("aborted", abortRequest);
        response.off("close", abortResponse);
      }
    } catch (error) {
      if (request.aborted || response.destroyed) return true;
      if (error instanceof SpeechError) {
        sendJson(response, error.status, apiError(error.code, error.message, error.retryable), error.retryAfterSeconds);
      } else {
        sendJson(response, 502, apiError("speech_upstream_failed", "Speech provider could not generate audio", true));
      }
    }
    return true;
  }

  private async settings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!request.method || !["GET", "PUT", "DELETE"].includes(request.method)) {
      response.setHeader("allow", "GET, PUT, DELETE");
      sendJson(response, 405, apiError("method_not_allowed", "Method not allowed"));
      return;
    }
    if (request.method === "GET") {
      sendJson(response, 200, this.speech?.settingsStatus() ?? disabledSettingsStatus());
      return;
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, apiError("origin_rejected", "Request origin is not allowed"));
      return;
    }
    if (!this.speech) {
      request.resume();
      sendJson(response, 503, apiError("speech_settings_unavailable", "Speech settings are unavailable"));
      return;
    }

    try {
      if (request.method === "PUT") {
        if (!this.isJson(request)) {
          sendJson(response, 415, apiError("unsupported_media_type", "Speech settings require application/json"));
          return;
        }
        const body = await readBody(request);
        if (Object.keys(body).length !== 1 || !("apiKey" in body)) {
          throw new SpeechError("invalid_speech_settings", "Speech settings must contain only apiKey", 400);
        }
        let apiKey: string;
        try {
          apiKey = normalizeSpeechApiKey(body.apiKey);
        } catch {
          throw new SpeechError("invalid_speech_api_key", "OpenAI API key is invalid", 400);
        }
        sendJson(response, 200, await this.speech.updateKey(apiKey));
      } else {
        sendJson(response, 200, await this.speech.removeStoredKey());
      }
    } catch (error) {
      if (error instanceof SpeechError) {
        sendJson(response, error.status, apiError(error.code, error.message, error.retryable));
      } else {
        sendJson(response, 500, apiError("speech_settings_failed", "Forge could not update speech settings", true));
      }
    }
  }

  private isJson(request: IncomingMessage): boolean {
    const contentType = request.headers["content-type"];
    return typeof contentType === "string" &&
      contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  }
}
