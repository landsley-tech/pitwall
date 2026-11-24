import type { DriverInfo, RaceState } from '@shared/types';
import { COMPOUND_COLOUR } from '../lib/format';

interface Props {
  state: RaceState;
  drivers: DriverInfo[];
  totalLaps: number | null;
  selected: string | null;
  onSelect: (num: string | null) => void;
}

export function StrategyChart({ state, drivers, totalLaps, selected, onSelect }: Props) {
  const byNum = new Map(drivers.map((d) => [d.num, d]));
  const maxLap =
    totalLaps ?? Math.max(10, ...Object.values(state.stints).flatMap((s) => s.map((x) => x.lapEnd)));
  const current = state.lap ?? 0;
  const ticks: number[] = [];
  const step = maxLap > 40 ? 10 : 5;
  for (let l = step; l < maxLap; l += step) ticks.push(l);

  return (
    <section className="panel strategy">
      <header className="panel-head">
        <h2>Tyre strategy</h2>
        <div className="legend">
          {(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'] as const).map((c) => (
            <span key={c} className="legend-item">
              <i style={{ background: COMPOUND_COLOUR[c] }} />
              {c[0] + c.slice(1).toLowerCase()}
            </span>
          ))}
        </div>
      </header>
      <div className="strategy-grid">
        {state.rows.map((r) => {
          const d = byNum.get(r.num);
          const stints = state.stints[r.num] ?? [];
          return (
            <div
              key={r.num}
              className={`strat-row${selected === r.num ? ' selected' : ''}${r.out ? ' out' : ''}`}
              onClick={() => onSelect(selected === r.num ? null : r.num)}
            >
              <span className="strat-code mono">{d?.code ?? r.num}</span>
              <div className="strat-track">
                {ticks.map((t) => (
                  <i key={t} className="strat-tick" style={{ left: `${(t / maxLap) * 100}%` }} />
                ))}
                {stints.map((s) => (
                  <span
                    key={s.n}
                    className="strat-bar"
                    title={`${s.compound} · laps ${s.lapStart}–${s.lapEnd}${s.ageStart ? ` · ${s.ageStart} laps old at fit` : ''}`}
                    style={{
                      left: `${((s.lapStart - 1) / maxLap) * 100}%`,
                      width: `${(Math.max(1, s.lapEnd - s.lapStart + 1) / maxLap) * 100}%`,
                      background: COMPOUND_COLOUR[s.compound],
                    }}
                  />
                ))}
                {current > 0 && <i className="strat-now" style={{ left: `${(Math.min(current, maxLap) / maxLap) * 100}%` }} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="strat-axis mono">
        <span />
        <div className="strat-track axis">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${(t / maxLap) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
