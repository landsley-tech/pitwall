import { useRef } from 'react';
import type { StatusBand } from '../lib/replay';
import { fmtClock } from '../lib/format';

interface Props {
  t: number;
  duration: number;
  startAt: number;
  playing: boolean;
  speed: number;
  bands: StatusBand[];
  lapMarks: { lap: number; t: number }[];
  onPlayPause: () => void;
  onSeek: (t: number) => void;
  onSpeed: (s: number) => void;
}

const SPEEDS = [1, 2, 5, 10, 25];

const BAND_CLASS: Record<string, string> = {
  SC: 'band-sc',
  SC_ENDING: 'band-sc',
  VSC: 'band-vsc',
  VSC_ENDING: 'band-vsc',
  RED: 'band-red',
  YELLOW: 'band-yellow',
};

export function ReplayControls(p: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const pct = (v: number) => `${(Math.max(0, Math.min(p.duration, v)) / p.duration) * 100}%`;

  const seekFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    p.onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * p.duration);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons === 1) seekFromEvent(e.clientX);
  };

  const labelEvery = p.lapMarks.length > 40 ? 10 : 5;

  return (
    <div className="controls">
      <div className="ctl-buttons">
        <button className="icon-btn" onClick={() => p.onSeek(p.t - 30_000)} title="Back 30 s (←)">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11 6v12l-8.5-6L11 6zm.5 6 8.5 6V6l-8.5 6z" /></svg>
        </button>
        <button className="play-btn" onClick={p.onPlayPause} title="Play / pause (space)">
          {p.playing ? (
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 4.5v15l13-7.5z" /></svg>
          )}
        </button>
        <button className="icon-btn" onClick={() => p.onSeek(p.t + 30_000)} title="Forward 30 s (→)">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z" /></svg>
        </button>
      </div>

      <div className="ctl-time mono">
        <span>{fmtClock(p.t - p.startAt)}</span>
        <span className="muted"> / {fmtClock(p.duration - p.startAt)}</span>
      </div>

      <div className="scrub" ref={barRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
        <div className="scrub-rail">
          {p.bands.map((b, i) => (
            <span key={i} className={`band ${BAND_CLASS[b.status] ?? ''}`} style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }} />
          ))}
          <span className="scrub-fill" style={{ width: pct(p.t) }} />
        </div>
        {p.lapMarks.map((m) =>
          m.lap % labelEvery === 0 ? (
            <span key={m.lap} className="lap-mark mono" style={{ left: pct(m.t) }}>
              L{m.lap}
            </span>
          ) : null,
        )}
        <span className="scrub-thumb" style={{ left: pct(p.t) }} />
      </div>

      <div className="speed-group" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} className={s === p.speed ? 'active' : ''} onClick={() => p.onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
