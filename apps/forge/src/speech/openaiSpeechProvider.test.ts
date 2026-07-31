import { describe, expect, it, vi } from "vitest";

import { OpenAiSpeechProvider, OPENAI_SPEECH_CAPABILITIES } from "./openaiSpeechProvider.ts";
import type { SpeechProviderRequest } from "./types.ts";

const request: SpeechProviderRequest = {
  text: "Read this response",
  voice: "marin" as const,
  style: "warm" as const,
};
const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);

describe("OpenAiSpeechProvider", () => {
  it("requests a complete MP3 with the fixed model and server-owned style instructions", async () => {
    let fetchedUrl: string | undefined;
    let fetchedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      fetchedUrl = String(input);
      fetchedInit = init;
      return new Response(mp3, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as unknown as typeof fetch;
    const provider = new OpenAiSpeechProvider("secret-key", fetchMock);

    expect(provider.capabilities).toMatchObject({
      providerId: "openai",
      cacheVersion: "gpt-4o-mini-tts",
      outputMediaType: "audio/mpeg",
      maxInputCharacters: 3_500,
      defaultVoice: "marin",
      defaultStyle: "natural",
    });
    expect(OPENAI_SPEECH_CAPABILITIES.voices).toContainEqual(expect.objectContaining({ id: "cedar" }));
    expect(OPENAI_SPEECH_CAPABILITIES.styles).toContainEqual(expect.objectContaining({ id: "gentle" }));
    expect(JSON.stringify(provider.capabilities)).not.toContain("instructions");
    await expect(provider.generate(request)).resolves.toEqual({ bytes: mp3, mediaType: "audio/mpeg" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchedUrl).toBe("https://api.openai.com/v1/audio/speech");
    expect(fetchedInit).toMatchObject({ method: "POST", headers: { authorization: "Bearer secret-key" } });
    expect(JSON.parse(String(fetchedInit?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: request.text,
      voice: "marin",
      response_format: "mp3",
      instructions: expect.stringContaining("warm"),
    });
  });

  it("rejects provider failures without exposing their response body", async () => {
    const provider = new OpenAiSpeechProvider("secret", (async () => new Response("sensitive provider details", {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
    const error = await provider.generate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "speech_upstream_failed", status: 502, retryable: true });
    expect(String(error)).not.toContain("sensitive provider details");
  });

  it("allowlists the upstream MIME type and validates MP3 bytes", async () => {
    const wrongType = new OpenAiSpeechProvider("secret", (async () => new Response(mp3, {
      headers: { "content-type": "text/html" },
    })) as typeof fetch);
    await expect(wrongType.generate(request)).rejects.toMatchObject({ code: "speech_upstream_invalid" });

    const wrongBytes = new OpenAiSpeechProvider("secret", (async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: { "content-type": "audio/mpeg" },
    })) as typeof fetch);
    await expect(wrongBytes.generate(request)).rejects.toMatchObject({ code: "speech_upstream_invalid" });
  });

  it("rejects an upstream body declared above 12 MiB", async () => {
    const provider = new OpenAiSpeechProvider("secret", (async () => new Response(mp3, {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(12 * 1024 * 1024 + 1),
      },
    })) as typeof fetch);
    await expect(provider.generate(request)).rejects.toMatchObject({ code: "speech_upstream_too_large", status: 502 });
  });

  it("stops a streamed response that exceeds 12 MiB without a declared length", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 13) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const provider = new OpenAiSpeechProvider("secret", (async () => new Response(body, {
      headers: { "content-type": "audio/mpeg" },
    })) as typeof fetch);
    await expect(provider.generate(request)).rejects.toMatchObject({ code: "speech_upstream_too_large", status: 502 });
  });

  it("distinguishes its 90-second timeout from caller cancellation", async () => {
    const pendingFetch = ((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    const provider = new OpenAiSpeechProvider("secret", pendingFetch, 5);
    await expect(provider.generate(request)).rejects.toMatchObject({ code: "speech_upstream_timeout", status: 504 });

    const controller = new AbortController();
    const cancelled = new OpenAiSpeechProvider("secret", pendingFetch).generate(request, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "speech_aborted", status: 499 });
  });
});
