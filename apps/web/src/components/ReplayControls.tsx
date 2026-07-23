import { Icon } from "@iconify/react";
import altArrowDownIcon from "@iconify-icons/solar/alt-arrow-down-linear";
import closeCircleIcon from "@iconify-icons/solar/close-circle-linear";
import pauseIcon from "@iconify-icons/solar/pause-bold";
import playIcon from "@iconify-icons/solar/play-bold";
import refreshIcon from "@iconify-icons/solar/restart-linear";
import { useEffect, useRef, useState } from "react";

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
  const panelRef = useRef<HTMLDivElement>(null);
  const fixture = fixtures.find((candidate) => candidate.id === replay.fixtureId);
  const progress = replay.total ? Math.round((replay.cursor / replay.total) * 100) : 0;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="replay-controls" ref={panelRef}>
      <button className="replay-chip" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog">
        <span className={replay.playing ? "replay-dot replay-dot--active" : "replay-dot"} />
        <span>Fixture</span>
        <strong>{replay.cursor}/{replay.total}</strong>
        <Icon icon={altArrowDownIcon} width={12} />
      </button>
      {open && (
        <div className="replay-panel" role="dialog" aria-label="Developer fixture replay">
          <header><span><small>Developer mode</small><strong>Pi RPC replay</strong></span><button className="icon-button" type="button" aria-label="Close replay controls" onClick={() => setOpen(false)}><Icon icon={closeCircleIcon} width={17} /></button></header>
          <label className="replay-field"><span>Fixture</span><select value={replay.fixtureId} onChange={(event) => onFixtureChange(event.target.value)}>{fixtures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <p>{fixture?.description}</p>
          <div className="replay-progress" aria-label={`${progress}% replayed`}><span style={{ width: `${progress}%` }} /></div>
          <div className="replay-transport">
            <button type="button" onClick={onRestart} title="Restart and play"><Icon icon={refreshIcon} width={15} /><span>Restart</span></button>
            <button className="replay-play" type="button" onClick={onToggle}><Icon icon={replay.playing ? pauseIcon : playIcon} width={15} /><span>{replay.playing ? "Pause" : "Play"}</span></button>
            <button type="button" onClick={onInstant} title="Restore final state"><span>Instant</span></button>
          </div>
          <label className="replay-speed"><span>Playback speed</span><select value={replay.speed} onChange={(event) => onSpeedChange(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
        </div>
      )}
    </div>
  );
}
