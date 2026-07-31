import {
  GoBackward10SecIcon,
  GoForward10SecIcon,
  Loading03Icon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SpeechPlaybackState } from "@/lib/speechPlayback";
import { useSpeech } from "./SpeechProvider";

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

function rateLabel(rate: number): string {
  return `${rate}×`;
}

type HeaderAudioPlayerViewProps = {
  playback: SpeechPlaybackState;
  onTogglePaused(): void;
  onStop(): void;
  onSkip(seconds: number): void;
  onSeek(progress: number): void;
  onPlaybackRateChange(rate: number): void;
};

export function HeaderAudioPlayerView({
  playback,
  onTogglePaused,
  onStop,
  onSkip,
  onSeek,
  onPlaybackRateChange,
}: HeaderAudioPlayerViewProps) {
  const [dragProgress, setDragProgress] = useState<number | null>(null);

  if (playback.status !== "loading" && playback.status !== "playing" && playback.status !== "paused") {
    return null;
  }

  const loading = playback.status === "loading";
  const paused = playback.desiredPaused;
  const canSkip = Number.isFinite(playback.duration) && playback.duration > 0;
  const centralLabel = loading
    ? paused ? "Resume audio when ready" : "Pause audio while loading"
    : paused ? "Resume audio" : "Pause audio";
  const loadingLabel = paused ? "Response audio paused while loading" : "Preparing response audio";

  return (
    <TooltipProvider delayDuration={350}>
      <div
        className={`header-audio-player${loading && paused ? " header-audio-player--paused-loading" : ""}`}
        role="group"
        aria-label="Response audio controls"
        aria-busy={loading}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="header-audio-segment"
              aria-label="Skip back 10 seconds"
              disabled={!canSkip}
              onClick={() => onSkip(-10)}
            >
              <HugeiconsIcon icon={GoBackward10SecIcon} strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back 10 seconds</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="header-audio-segment header-audio-toggle"
              aria-label={centralLabel}
              aria-pressed={paused}
              onClick={onTogglePaused}
            >
              <HugeiconsIcon
                icon={loading && !paused ? Loading03Icon : paused ? PlayIcon : PauseIcon}
                strokeWidth={2}
                className={loading && !paused ? "spin" : undefined}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{centralLabel}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="header-audio-segment"
              aria-label="Stop audio"
              onClick={onStop}
            >
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Stop audio</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="header-audio-segment"
              aria-label="Skip forward 10 seconds"
              disabled={!canSkip}
              onClick={() => onSkip(10)}
            >
              <HugeiconsIcon icon={GoForward10SecIcon} strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Forward 10 seconds</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="header-audio-segment header-audio-speed"
                  aria-label={`Playback speed, ${rateLabel(playback.playbackRate)}`}
                >
                  {rateLabel(playback.playbackRate)}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Playback speed</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-24">
            <DropdownMenuRadioGroup
              value={String(playback.playbackRate)}
              onValueChange={(value) => onPlaybackRateChange(Number(value))}
            >
              {PLAYBACK_RATES.map((rate) => (
                <DropdownMenuRadioItem key={rate} value={String(rate)}>{rateLabel(rate)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {loading ? (
          <div
            className="header-audio-progress header-audio-progress--loading"
            role="progressbar"
            aria-label={loadingLabel}
          ><span /></div>
        ) : (
          <Slider
            className="header-audio-progress"
            min={0}
            max={1}
            step={0.001}
            value={[dragProgress ?? playback.progress]}
            aria-label="Seek response audio"
            aria-valuetext={`${Math.round((dragProgress ?? playback.progress) * 100)}%`}
            onValueChange={([value]) => {
              if (value !== undefined) setDragProgress(value);
            }}
            onValueCommit={([value]) => {
              setDragProgress(null);
              if (value !== undefined) onSeek(value);
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

export function HeaderAudioPlayer() {
  const { playback, togglePaused, stop, skip, seek, setPlaybackRate } = useSpeech();
  return (
    <HeaderAudioPlayerView
      playback={playback}
      onTogglePaused={togglePaused}
      onStop={stop}
      onSkip={skip}
      onSeek={seek}
      onPlaybackRateChange={setPlaybackRate}
    />
  );
}
