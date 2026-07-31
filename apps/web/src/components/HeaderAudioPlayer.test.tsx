import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { idleSpeechPlaybackState, type SpeechPlaybackState } from "../lib/speechPlayback";
import { HeaderAudioPlayerView } from "./HeaderAudioPlayer";

const nodeFsSpecifier = "node:fs";
const { readFileSync } = await import(nodeFsSpecifier);
const responsiveStyles = readFileSync(new URL("../styles/responsive.css", import.meta.url), "utf8");
const shellStyles = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");

function render(playback: SpeechPlaybackState): string {
  return renderToStaticMarkup(
    <HeaderAudioPlayerView
      playback={playback}
      onTogglePaused={vi.fn()}
      onStop={vi.fn()}
      onSkip={vi.fn()}
      onSeek={vi.fn()}
      onPlaybackRateChange={vi.fn()}
    />,
  );
}

const active = (status: "loading" | "playing" | "paused"): SpeechPlaybackState => ({
  status,
  playbackRate: 1.25,
  progress: 0.42,
  currentTime: status === "loading" ? 0 : 8,
  duration: status === "loading" ? 0 : 20,
  desiredPaused: status === "paused",
  messageId: "message-1",
  chunkIndex: 0,
  chunkCount: 2,
});

describe("HeaderAudioPlayer", () => {
  it("does not exist before playback is attempted or after errors", () => {
    expect(render(idleSpeechPlaybackState())).toBe("");
    expect(render({ ...idleSpeechPlaybackState(), status: "error", error: "failed" })).toBe("");
  });

  it("renders the compact loading transport without a close control or time text", () => {
    const html = render(active("loading"));
    expect(html).toContain('aria-label="Response audio controls"');
    expect(html).toContain('aria-label="Skip back 10 seconds"');
    expect(html).toContain('aria-label="Pause audio while loading"');
    expect(html).toContain('aria-label="Stop audio"');
    expect(html).toContain('aria-label="Skip forward 10 seconds"');
    expect(html).toContain('aria-label="Playback speed, 1.25×"');
    expect(html).toContain('aria-label="Preparing response audio"');
    expect(html).not.toContain("Close");
    expect(html).not.toContain("Dismiss");
    expect(html).not.toMatch(/\d+:\d+/);
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("tabular-nums");
    expect(html.match(/<button(?=[^>]*aria-label="Skip)[^>]*\sdisabled(?:=|\s|>)[^>]*>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button(?=[^>]*aria-label="Stop audio")[^>]*\sdisabled(?:=|\s|>)[^>]*>/);

    const labels = [
      "Skip back 10 seconds",
      "Pause audio while loading",
      "Stop audio",
      "Skip forward 10 seconds",
      "Playback speed, 1.25×",
    ];
    const positions = labels.map((label) => html.indexOf(`aria-label="${label}"`));
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true);
  });

  it("keeps pause intent actionable and accessible while loading", () => {
    const html = render({ ...active("loading"), desiredPaused: true });
    expect(html).toContain('aria-label="Resume audio when ready"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Response audio paused while loading"');
    expect(html).toContain("header-audio-player--paused-loading");
  });

  it("exposes pause, resume, enabled skips, and an accessible interactive seek track", () => {
    const playing = render(active("playing"));
    const paused = render(active("paused"));
    expect(playing).toContain('aria-label="Pause audio"');
    expect(paused).toContain('aria-label="Resume audio"');
    expect(playing).toContain('aria-label="Stop audio"');
    expect(paused).toContain('aria-label="Stop audio"');
    expect(playing).toContain('aria-label="Seek response audio"');
    expect(playing).toContain('role="slider"');
    expect(playing).not.toMatch(/<button(?=[^>]*aria-label="Skip)[^>]*\sdisabled(?:=|\s|>)[^>]*>/);
    expect(playing).not.toMatch(/<button(?=[^>]*aria-label="Stop audio")[^>]*\sdisabled(?:=|\s|>)[^>]*>/);
    expect(paused).not.toMatch(/<button(?=[^>]*aria-label="Stop audio")[^>]*\sdisabled(?:=|\s|>)[^>]*>/);
  });

  it("keeps progress hit areas separate from transport controls on fine and coarse pointers", () => {
    expect(shellStyles).toMatch(/\.header-audio-player\s*\{[^}]*width: 167px;[^}]*height: 32px;[^}]*flex: 0 0 167px;[^}]*align-items: center;[^}]*overflow: hidden;[^}]*background: transparent;[^}]*border: 1px solid var\(--border\);[^}]*border-radius: 8px;/s);
    expect(shellStyles).toMatch(/\.header-audio-segment\s*\{[^}]*height: 30px;[^}]*min-height: 30px;/s);
    expect(shellStyles).toMatch(/\.repository-status-trigger\s*\{[^}]*height: 32px;[^}]*background: transparent;[^}]*border: 1px solid var\(--border\);[^}]*border-radius: 8px;/s);
    expect(shellStyles).toMatch(/\.header-audio-progress\s*\{[^}]*bottom: 0;[^}]*height: 4px;/s);
    expect(shellStyles).toMatch(/\.header-audio-progress \[data-slot="slider-track"\]\s*\{[^}]*height: 2px;/s);
    expect(shellStyles).toMatch(/\.header-audio-progress--loading::before\s*\{[^}]*height: 2px;/s);
    expect(shellStyles).toMatch(/\.header-audio-progress--loading span\s*\{[^}]*height: 2px;/s);

    expect(shellStyles).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.header-audio-player\s*\{[^}]*height: 56px;[^}]*align-items: flex-start;[\s\S]*?\.header-audio-segment\s*\{[^}]*height: 30px;[^}]*min-height: 30px;[\s\S]*?\.header-audio-progress\s*\{[^}]*height: 24px;/);
    expect(responsiveStyles).toMatch(/@media \(max-width: 640px\)\s*\{[\s\S]*?\.session-header:has\(\.header-audio-player\) \.repository-status-trigger\s*\{[^}]*max-width: 65px;/);
    expect(responsiveStyles).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.session-header:has\(\.header-audio-player\)\s*\{[^}]*min-height: 72px;/);
  });
});
