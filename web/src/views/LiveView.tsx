import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CarPos, RaceState, SessionMeta, TrackInfo } from '@shared/types';
import { Dashboard } from '../components/Dashboard';
import { fetchCircuit, fetchSessions } from '../lib/api';
import { fmtClock, parseGap } from '../lib/format';
import { TrackPath } from '../lib/track';
import { useLive } from '../lib/useLive';

const EMPTY: RaceState = {
  now: Date.now(),
  lap: null,
  totalLaps: null,
  trackStatus: 'NONE',
  yellowSectors: [],
  rows: [],
  raceControl: [],
  weather: null,
  stints: {},
  fastest: null,
};

export function LiveView({ onBack }: { onBack: () => void }) {
  const live = useLive(true);
  const msg = live.msg;
  const session = msg?.session ?? null;
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [next, setNext] = useState<SessionMeta | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!session?.circuitKey) return;
    let cancelled = false;
    fetchCircuit(session.circuitKey, session.year).then((t) => !cancelled && setTrack(t));
    return () => {
      cancelled = true;
    };
  }, [session?.circuitKey, session?.year]);

  useEffect(() => {
    const y = new Date().getFullYear();
    Promise.all([fetchSessions(y), fetchSessions(y + 1).catch(() => [])])
      .then(([a, b]) => setNext([...a, ...b].find((s) => Date.parse(s.dateStart) > Date.now()) ?? null))
      .catch(() => undefined);
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const running = msg?.sessionStatus === 'Started';
  const isRace = session?.type === 'Race';
  const path = useMemo(() => (track ? new TrackPath(track) : null), [track]);

  // Latest state for the map loop, without re-creating the callback.
  const latest = useRef({ msg, running, isRace, path });
  latest.current = { msg, running, isRace, path };

  const getCars = useCallback((): CarPos[] | null => {
    const { msg, running, isRace, path } = latest.current;
    const real = live.positionsAt(Date.now());
    if (real) return real;
    if (!msg || !running || !isRace || !path) return null;
    return estimate(msg.state, msg.lapStartedAt, path);
  }, [live]);

  const hasReal = !!msg?.hasPositions;
  const estimating = running && isRace && !hasReal && !!track;

  let banner: React.ReactNode = null;
  if (!live.connected) {
    banner = <div className="banner warn">{live.status}…</div>;
  } else if (!running) {
    const finished = msg?.sessionStatus === 'Finished' || msg?.sessionStatus === 'Finalised' || msg?.sessionStatus === 'Ends';
    banner = (
      <div className="banner">
        <strong>No session running.</strong>{' '}
        {finished && session ? `Showing the final timing from ${session.meeting} ${session.name}. ` : ''}
        {next && (
          <>
            Next up: {next.meeting} · {next.name} in <span className="mono">{countdown(Date.parse(next.dateStart) - Date.now())}</span>
          </>
        )}
      </div>
    );
  }

  const remaining = msg?.state.remaining;
  return (
    <Dashboard
      mode="live"
      session={session}
      drivers={msg?.drivers ?? []}
      state={msg?.state ?? EMPTY}
      track={track}
      getCars={getCars}
      isRace={!!isRace}
      totalLaps={msg?.state.totalLaps ?? null}
      clock={remaining ? remaining.replace(/^00:/, '') : fmtClock(0)}
      mapBadge={estimating ? 'Estimated positions · from timing gaps' : null}
      mapNote={
        !track
          ? session
            ? 'Loading track…'
            : 'Waiting for live timing…'
          : running && !hasReal && !isRace
            ? 'Car positions need an F1 TV token outside races (see README)'
            : null
      }
      banner={banner}
      onBack={onBack}
    />
  );
}

/**
 * Without GPS data, place cars along the outline using the timing:
 * the leader moves by elapsed lap time, and each car sits one interval behind
 * the car ahead.
 */
function estimate(state: RaceState, lapStartedAt: Record<string, number>, path: TrackPath): CarPos[] {
  const rows = state.rows.filter((r) => r.position != null && !r.out);
  if (!rows.length) return [];
  const leader = rows[0];
  const ref = leader.lastLap ?? leader.bestLap ?? 95;
  const started = lapStartedAt[leader.num];
  let f = started ? Math.min(0.995, (Date.now() - started) / 1000 / ref) : 0;
  const out: CarPos[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i > 0) {
      const iv = parseGap(r.interval);
      f -= iv != null ? iv / ref : 0.01;
    }
    if (r.inPit) continue;
    const p = path.pointAt(f);
    out.push({ num: r.num, x: p.x, y: p.y });
  }
  return out;
}

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}
