import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SpeechPlaybackState } from "../lib/speechPlayback";

type SliderCallbacks = {
  onValueChange?(value: number[]): void;
  onValueCommit?(value: number[]): void;
};

type ButtonCallbacks = {
  "aria-label"?: string;
  onClick?(): void;
  children?: ReactNode;
};

const sliderCapture = vi.hoisted(() => ({ props: undefined as SliderCallbacks | undefined }));
const buttonCapture = vi.hoisted(() => ({ stop: undefined as (() => void) | undefined }));

vi.mock("@/components/ui/slider", () => ({
  Slider: (props: SliderCallbacks) => {
    sliderCapture.props = props;
    return null;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonCallbacks) => {
    if (props["aria-label"] === "Stop audio") buttonCapture.stop = props.onClick;
    return <button aria-label={props["aria-label"]}>{children}</button>;
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
}));

import { HeaderAudioPlayerView } from "./HeaderAudioPlayer";

const playback: SpeechPlaybackState = {
  status: "playing",
  playbackRate: 1,
  progress: 0.1,
  currentTime: 2,
  duration: 20,
  desiredPaused: false,
  messageId: "message-1",
  chunkIndex: 0,
  chunkCount: 2,
};

describe("HeaderAudioPlayer seek commits", () => {
  it("previews many drag values but commits one paid cross-chunk seek", () => {
    const paidFetch = vi.fn();
    const seek = vi.fn(() => paidFetch());
    renderToStaticMarkup(
      <HeaderAudioPlayerView
        playback={playback}
        onTogglePaused={vi.fn()}
        onStop={vi.fn()}
        onSkip={vi.fn()}
        onSeek={seek}
        onPlaybackRateChange={vi.fn()}
      />,
    );

    const slider = sliderCapture.props;
    expect(slider?.onValueChange).toBeTypeOf("function");
    expect(slider?.onValueCommit).toBeTypeOf("function");
    for (let index = 1; index <= 100; index += 1) {
      slider?.onValueChange?.([index / 100]);
    }
    expect(seek).not.toHaveBeenCalled();

    slider?.onValueCommit?.([0.75]);
    expect(seek).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledWith(0.75);
    expect(paidFetch).toHaveBeenCalledOnce();
  });

  it("calls the dedicated stop callback", () => {
    const stop = vi.fn();
    renderToStaticMarkup(
      <HeaderAudioPlayerView
        playback={playback}
        onTogglePaused={vi.fn()}
        onStop={stop}
        onSkip={vi.fn()}
        onSeek={vi.fn()}
        onPlaybackRateChange={vi.fn()}
      />,
    );

    expect(buttonCapture.stop).toBeTypeOf("function");
    buttonCapture.stop?.();
    expect(stop).toHaveBeenCalledOnce();
  });
});
