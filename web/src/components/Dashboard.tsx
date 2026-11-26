import { useEffect, useState, type ReactNode } from 'react';
import type { CarPos, DriverInfo, RaceState, ReplayLap, SessionMeta, TrackInfo } from '@shared/types';
import { STATUS_LABEL } from '../lib/format';
import { useOnboard, useReplayFollow, type ReplayClock } from '../lib/onboard';
import { CamIcon, OnboardDrawer, Toaster } from './OnboardDrawer';
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
  /** replay position, so onboard windows can follow it */
  replayClock?: ReplayClock;
  onBack: () => void;
}

export function Dashboard(p: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hideBlue, setHideBlue] = useState(true);
  const s = p.state;
  const selDriver = selected ? p.drivers.find((d) => d.num === selected) : undefined;
  const selRow = selected ? s.rows.find((r) => r.num === selected) : undefined;

  // ?onboards opens the drawer straight away, handy for a bookmark on the TV machine
  const [obOpen, setObOpen] = useState(() => new URLSearchParams(location.search).has('onboards'));
  const [follow, setFollow] = useState(true);
  const onboard = useOnboard(p.session, obOpen);
  const obPlayers = onboard.status?.players.length ?? 0;
  const playerKey = (onboard.status?.players ?? []).map((x) => x.id).sort().join(',');
  const followActive = useReplayFollow(follow && p.mode === 'replay', p.replayClock, onboard.video, playerKey, onboard.control);

  // one car's onboard in its own window; without MultiViewer, show the setup steps instead
  const watch = (num: string) => {
    if (!onboard.status?.available) return setObOpen(true);
    onboard.open([{ kind: 'driver', num: Number(num) }]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'o' || e.key === 'O') setObOpen((v) => !v);
      else if (e.key === 'Escape') setObOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          <button
            className={`ob-btn${obOpen ? ' active' : ''}${onboard.status?.available ? ' ready' : ''}`}
            onClick={() => setObOpen((v) => !v)}
            title="Onboard cameras (O)"
          >
            <CamIcon />
            <span>Onboards</span>
            {obPlayers > 0 && (
              <span key={obPlayers} className="ob-count mono">
                {obPlayers}
              </span>
            )}
          </button>
          <span className={`mode-chip ${p.mode}`}>{p.mode === 'live' ? '● Live' : 'Replay'}</span>
        </div>
      </header>

      {p.banner}

      <main className="grid">
        <TimingTower state={s} drivers={p.drivers} selected={selected} onSelect={setSelected} isRace={p.isRace} onWatch={watch} />

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
              key={selDriver.num}
              driver={selDriver}
              row={selRow}
              history={p.lapHistory ? p.lapHistory(selDriver.num) : null}
              onClose={() => setSelected(null)}
              onWatch={() => watch(selDriver.num)}
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

      <OnboardDrawer
        open={obOpen}
        onClose={() => setObOpen(false)}
        mode={p.mode}
        drivers={p.drivers}
        rows={s.rows}
        selected={selected}
        onboard={onboard}
        follow={follow}
        onFollow={setFollow}
        followActive={followActive}
      />
      <Toaster toasts={onboard.toasts} />
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
