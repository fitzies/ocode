import { Cancel01Icon, PauseIcon, PlayIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fixtures } from "../fixtures";
import type { ReplayStatus } from "../lib/anvilClient";

interface ReplayControlsProps {
  replay: ReplayStatus;
  onFixtureChange: (fixtureId: string) => void;
  onInstant: () => void;
  onRestart: () => void;
  onSpeedChange: (speed: number) => void;
  onToggle: () => void;
}

export function ReplayControls({ replay, onFixtureChange, onInstant, onRestart, onSpeedChange, onToggle }: ReplayControlsProps) {
  const [open, setOpen] = useState(false);
  const fixture = fixtures.find((candidate) => candidate.id === replay.fixtureId);
  const progress = replay.total ? Math.round((replay.cursor / replay.total) * 100) : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Open developer fixture replay">
          <span className={`size-1.5 rounded-full ${replay.playing ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
          Fixture
          <span className="font-mono text-[0.625rem] text-muted-foreground">{replay.cursor}/{replay.total}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3">
        <header className="flex items-start justify-between">
          <span className="grid">
            <small className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">Developer mode</small>
            <strong className="text-sm font-medium">Pi RPC replay</strong>
          </span>
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Close replay controls" onClick={() => setOpen(false)}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </header>
        <Field>
          <FieldLabel>Fixture</FieldLabel>
          <Select value={replay.fixtureId} onValueChange={onFixtureChange}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {fixtures.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <p className="m-0 text-xs/relaxed text-muted-foreground">{fixture?.description}</p>
        <Progress value={progress} aria-label={`${progress}% replayed`} />
        <div className="grid grid-cols-3 gap-1.5">
          <Button variant="outline" type="button" onClick={onRestart} title="Restart and play">
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />Restart
          </Button>
          <Button type="button" onClick={onToggle}>
            <HugeiconsIcon icon={replay.playing ? PauseIcon : PlayIcon} strokeWidth={2} />
            {replay.playing ? "Pause" : "Play"}
          </Button>
          <Button variant="outline" type="button" onClick={onInstant} title="Restore final state">Instant</Button>
        </div>
        <Field orientation="horizontal" className="items-center justify-between">
          <FieldLabel>Playback speed</FieldLabel>
          <Select value={String(replay.speed)} onValueChange={(value) => onSpeedChange(Number(value))}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[0.5, 1, 2, 4].map((speed) => <SelectItem key={speed} value={String(speed)}>{speed}×</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </PopoverContent>
    </Popover>
  );
}
