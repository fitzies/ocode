import { describe, expect, it, vi } from "vitest";
import { speechTextForMessage } from "./MessageActions";
import { buildSpeechPlaybackRequest } from "./SpeechProvider";

describe("MessageActions speech text", () => {
  it("does not serialize Markdown while speech is disabled", () => {
    const serialize = vi.fn(() => "plain text");

    expect(speechTextForMessage(false, "**response**", serialize)).toBe("");
    expect(serialize).not.toHaveBeenCalled();
  });

  it("serializes once and passes the precomputed text through to playback", () => {
    const serialize = vi.fn(() => "Precomputed plain response");
    const plainText = speechTextForMessage(true, "**response**", serialize);
    const request = buildSpeechPlaybackRequest(
      "message-1",
      plainText,
      12,
      { voice: "voice-default", style: "style-default" },
    );

    expect(serialize).toHaveBeenCalledOnce();
    expect(serialize).toHaveBeenCalledWith("**response**");
    expect(request).toEqual({
      messageId: "message-1",
      chunks: ["Precomputed", "plain", "response"],
      voice: "voice-default",
      style: "style-default",
    });
  });
});
