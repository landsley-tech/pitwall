import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '@shared/types';
import { fetchSessions } from '../lib/api';
import { Logo } from './Dashboard';

interface Props {
  onReplay: (s: SessionMeta) => void;
  onLive: () => void;
}

const FIRST_YEAR = 2023;

export function SessionPicker({ onReplay, onLive }: Props) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    fetchSessions(year)
      .then((s) => !cancelled && setSessions(s))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [year]);

  const meetings = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const s of sessions ?? []) {
      const k = `${s.meeting}|${s.circuitKey}`;
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.values()].reverse(); // most recent first
  }, [sessions]);

  const next = sessions?.find((s) => Date.parse(s.dateEnd) > now);
  const liveNow = next && Date.parse(next.dateStart) - 15 * 60_000 < now;

  return (
    <div className="picker">
      <header className="picker-top">
        <div className="brand static">
          <Logo />
          <span>PITWALL</span>
        </div>
        <div className="year-tabs" role="tablist">
          {Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i).map((y) => (
            <button key={y} className={y === year ? 'active' : ''} onClick={() => setYear(y)}>
              {y}
            </button>
          ))}
        </div>
      </header>

      <section className="hero">
        <div>
          <h1>Race data, the way the pit wall sees it.</h1>
          <p className="muted">
            Live track map, timing tower, tyre strategy and race control for any session. Replay past races at up to 25× speed,
            or follow a session as it happens.
          </p>
        </div>
        <button className={`live-card${liveNow ? ' on' : ''}`} onClick={onLive}>
          <span className="live-dot" />
          <div>
            <div className="live-title">{liveNow ? 'Session live now' : 'Live timing'}</div>
            <div className="muted small">
              {next
                ? `${liveNow ? '' : 'Next: '}${next.meeting} · ${next.name} · ${new Date(next.dateStart).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : 'Open the live dashboard'}
            </div>
          </div>
          <span className="arrow">→</span>
        </button>
      </section>

      {error && <div className="error-box">Couldn't load sessions: {error}</div>}
      {!sessions && !error && <div className="muted pad">Loading {year} season…</div>}

      <div className="meetings">
        {meetings.map((list) => {
          const m = list[0];
          const done = list.filter((s) => Date.parse(s.dateEnd) + 30 * 60_000 < now);
          const upcoming = done.length === 0;
          return (
            <article key={`${m.meeting}-${m.circuitKey}`} className={`meeting${upcoming ? ' upcoming' : ''}`}>
              <div className="meeting-head">
                <span className="cc mono">{m.countryCode}</span>
                <div>
                  <h3>{m.meeting}</h3>
                  <div className="muted small">
                    {m.circuit} ·{' '}
                    {new Date(m.dateStart).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                  </div>
                </div>
              </div>
              <div className="session-chips">
                {list.map((s) => {
                  const ready = Date.parse(s.dateEnd) + 30 * 60_000 < now;
                  const isRace = s.type === 'Race';
                  return (
                    <button
                      key={s.key}
                      disabled={!ready}
                      className={`chip${isRace ? ' race' : ''}`}
                      onClick={() => onReplay(s)}
                      title={ready ? `Replay ${s.name}` : 'Not available yet'}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="picker-foot muted small">
        Unofficial project. Not associated with Formula 1 companies. Data from OpenF1, live timing and MultiViewer circuit maps.
      </footer>
    </div>
  );
}
