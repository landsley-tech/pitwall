import { useState, type ReactNode } from 'react';
import type { CarPos, DriverInfo, RaceState, ReplayLap, SessionMeta, TrackInfo } from '@shared/types';
import { STATUS_LABEL } from '../lib/format';
import { DriverCard, RaceControl, WeatherCard } from './SidePanels';
import { StrategyChart } from './StrategyChart';
import { TimingTower } from './TimingTower';
import { TrackMap } from './TrackMap';

interface Props {
  mode: 'replay' | 'live';
  session: SessionMeta | null;
  drivers: DriverInfo[];
  state: RaceState;
  track: TrackInfo | null;
  getCars: () => CarPos[] | null;
  startFinish?: { x: number; y: number } | null;
  mapBadge?: string | null;
  mapNote?: string | null;
  isRace: boolean;
  totalLaps: number | null;
  clock: ReactNode;
  lapHistory?: (num: string) => ReplayLap[];
  footer?: ReactNode;
  banner?: ReactNode;
  onBack: () => void;
}

export function Dashboard(p: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hideBlue, setHideBlue] = useState(true);
  const s = p.state;
  const selDriver = selected ? p.drivers.find((d) => d.num === selected) : undefined;
  const selRow = selected ? s.rows.find((r) => r.num === selected) : undefined;

  return (
    <div className={`dash status-${s.trackStatus.toLowerCase()}`}>
      <header className="topbar">
        <button className="brand" onClick={p.onBack} title="Back to sessions">
          <Logo />
          <span>PITWALL</span>
        </button>
        <div className="session-title">
          <div className="st-main">
            {p.session ? `${p.session.meeting}` : 'Live timing'}
            {p.session && <span className="st-sub"> · {p.session.name}</span>}
          </div>
          <div className="st-meta muted">
            {p.session ? `${p.session.circuit} · ${new Date(p.session.dateStart).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          </div>
        </div>

        <div className="top-center">
          <div className="lap-counter">
            <span className="label">{p.isRace ? 'Lap' : 'Session'}</span>
            <span className="mono lap-big">
              {p.isRace ? (
                <>
                  {s.lap ?? '—'}
                  {s.totalLaps ? <span className="muted">/{s.totalLaps}</span> : null}
                </>
              ) : (
                p.clock
              )}
            </span>
          </div>
          <div className={`status-pill sp-${s.trackStatus.toLowerCase()}`}>
            <i />
            {STATUS_LABEL[s.trackStatus]}
          </div>
        </div>

        <div className="top-right">
          {p.isRace && <div className="clock mono">{p.clock}</div>}
          <span className={`mode-chip ${p.mode}`}>{p.mode === 'live' ? '● Live' : 'Replay'}</span>
        </div>
      </header>

      {p.banner}

      <main className="grid">
        <TimingTower state={s} drivers={p.drivers} selected={selected} onSelect={setSelected} isRace={p.isRace} />

        <section className="panel map-panel">
          <TrackMap
            track={p.track}
            drivers={p.drivers}
            getCars={p.getCars}
            yellowSectors={s.yellowSectors}
            selected={selected}
            onSelect={setSelected}
            startFinish={p.startFinish}
            badge={p.mapBadge}
            emptyMessage={p.mapNote}
          />
        </section>

        <aside className="side">
          {selDriver && (
            <DriverCard
              driver={selDriver}
              row={selRow}
              history={p.lapHistory ? p.lapHistory(selDriver.num) : null}
              onClose={() => setSelected(null)}
            />
          )}
          <WeatherCard weather={s.weather} />
          <div className="rc-wrap">
            <RaceControl messages={s.raceControl} hideBlue={hideBlue} />
            <label className="rc-filter small muted">
              <input type="checkbox" checked={hideBlue} onChange={(e) => setHideBlue(e.target.checked)} /> Hide blue flags
            </label>
          </div>
        </aside>

        <StrategyChart state={s} drivers={p.drivers} totalLaps={p.totalLaps} selected={selected} onSelect={setSelected} />
      </main>

      {p.footer}
    </div>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <path d="M8 21.5 14 10.5h3.2l-6 11zM14.5 21.5l6-11h3.2l-6 11z" fill="#0b0d10" />
    </svg>
  );
}
