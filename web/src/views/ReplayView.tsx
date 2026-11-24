import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuildStatus, ReplayData, SessionMeta } from '@shared/types';
import { Dashboard, Logo } from '../components/Dashboard';
import { ReplayControls } from '../components/ReplayControls';
import { loadReplay } from '../lib/api';
import { fmtClock } from '../lib/format';
import { ReplayEngine } from '../lib/replay';

export function ReplayView({ session, onBack }: { session: SessionMeta; onBack: () => void }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [status, setStatus] = useState<BuildStatus>({ state: 'building', progress: 0, message: 'Connecting' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    loadReplay(session.key, setStatus, ctrl.signal)
      .then(setData)
      .catch((e) => e.name !== 'AbortError' && setError(e.message));
    return () => ctrl.abort();
  }, [session.key]);

  if (error || !data) {
    return (
      <div className="loading">
        <div className="loading-card">
          <Logo />
          <h2>
            {session.meeting} · {session.name}
          </h2>
          {error ? (
            <>
              <p className="error-text">{error}</p>
              <button className="btn" onClick={onBack}>
                Back to sessions
              </button>
            </>
          ) : (
            <>
              <div className="progress">
                <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
              </div>
              <p className="muted small">{status.message}…</p>
              <p className="muted small">The first load of a session downloads it from OpenF1 and takes about a minute. After that it opens instantly.</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return <ReplayPlayer data={data} onBack={onBack} />;
}

function ReplayPlayer({ data, onBack }: { data: ReplayData; onBack: () => void }) {
  const engine = useMemo(() => new ReplayEngine(data), [data]);
  const tRef = useRef(data.startAt);
  const [t, setT] = useState(data.startAt);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Playback clock. The map reads tRef every frame; React state updates ~8×/s.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const loop = (now: number) => {
      tRef.current = Math.min(data.duration, tRef.current + (now - last) * speedRef.current);
      last = now;
      if (now - lastUi > 120) {
        lastUi = now;
        setT(tRef.current);
      }
      if (tRef.current >= data.duration) {
        setPlaying(false);
        setT(tRef.current);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, data.duration]);

  const seek = useCallback(
    (v: number) => {
      tRef.current = Math.max(0, Math.min(data.duration, v));
      setT(tRef.current);
    },
    [data.duration],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') seek(tRef.current - (e.shiftKey ? 120_000 : 10_000));
      else if (e.code === 'ArrowRight') seek(tRef.current + (e.shiftKey ? 120_000 : 10_000));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seek]);

  const state = useMemo(() => engine.stateAt(t), [engine, t]);
  const getCars = useCallback(() => engine.carPositions(tRef.current), [engine]);
  const lapHistory = useCallback((num: string) => engine.lapHistory(num, t), [engine, t]);

  return (
    <Dashboard
      mode="replay"
      session={data.session}
      drivers={data.drivers}
      state={state}
      track={data.track}
      getCars={getCars}
      startFinish={engine.startFinish}
      isRace={data.isRace}
      totalLaps={data.totalLaps}
      clock={fmtClock(t - data.startAt)}
      lapHistory={lapHistory}
      mapNote={data.track ? null : 'No track outline available for this session'}
      onBack={onBack}
      footer={
        <ReplayControls
          t={t}
          duration={data.duration}
          startAt={data.startAt}
          playing={playing}
          speed={speed}
          bands={engine.bands}
          lapMarks={engine.lapMarks}
          onPlayPause={() => {
            if (tRef.current >= data.duration) seek(data.startAt);
            setPlaying((p) => !p);
          }}
          onSeek={seek}
          onSpeed={setSpeed}
        />
      }
    />
  );
}
