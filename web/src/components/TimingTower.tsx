import { useState } from 'react';
import type { DriverInfo, RaceState } from '@shared/types';
import { fmtLap } from '../lib/format';
import { CamIcon } from './OnboardDrawer';
import { TyreBadge } from './TyreBadge';

interface Props {
  state: RaceState;
  drivers: DriverInfo[];
  selected: string | null;
  onSelect: (num: string | null) => void;
  isRace: boolean;
  onWatch?: (num: string) => void;
}

const ROW_H = 34;

export function TimingTower({ state, drivers, selected, onSelect, isRace, onWatch }: Props) {
  const [showGap, setShowGap] = useState(false);
  const byNum = new Map(drivers.map((d) => [d.num, d]));
  // Render in a stable order (by car number) and move rows with transforms,
  // so position changes animate instead of jumping.
  const index = new Map(state.rows.map((r, i) => [r.num, i]));
  const stable = [...state.rows].sort((a, b) => Number(a.num) - Number(b.num));

  return (
    <section className="panel tower">
      <header className="tower-head">
        <span className="c-pos">Pos</span>
        <span className="c-drv">Driver</span>
        <button className="c-gap head-toggle" onClick={() => setShowGap((v) => !v)} title="Switch between interval and gap to leader">
          {showGap ? 'Gap' : 'Int'} <span className="swap">⇄</span>
        </button>
        <span className="c-last">Last</span>
        <span className="c-best">Best</span>
        <span className="c-tyre">Tyre</span>
        <span className="c-pit">Pit</span>
      </header>
      <div className="tower-body" style={{ height: stable.length * ROW_H }}>
        {stable.map((r) => {
          const d = byNum.get(r.num);
          const i = index.get(r.num) ?? 0;
          const delta = r.gridPos != null && r.position != null && isRace ? r.gridPos - r.position : 0;
          const isFastest = state.fastest?.num === r.num;
          const lastIsFastest = isFastest && r.lastLap != null && r.lastLap === state.fastest?.time;
          return (
            <div
              key={r.num}
              className={`tower-row${selected === r.num ? ' selected' : ''}${r.out ? ' out' : ''}`}
              style={{ transform: `translateY(${i * ROW_H}px)`, ['--team' as string]: d?.colour }}
              onClick={() => onSelect(selected === r.num ? null : r.num)}
            >
              <span className="c-pos">
                {/* keyed on position so the number flashes when it changes */}
                <span key={r.position ?? 'x'} className={`pos-num${delta > 0 ? ' gained' : delta < 0 ? ' lost' : ''}`}>
                  {r.out ? '—' : r.position ?? '·'}
                </span>
                {delta !== 0 && (
                  <span className={`pos-delta ${delta > 0 ? 'up' : 'down'}`}>
                    {delta > 0 ? '▲' : '▼'}
                    {Math.abs(delta)}
                  </span>
                )}
              </span>
              <span className="c-drv">
                <span className="team-bar" style={{ background: d?.colour }} />
                <span className="drv-code">{d?.code ?? r.num}</span>
                <span className="drv-num">{r.num}</span>
              </span>
              <span className="c-gap mono">
                {r.out ? <span className="tag tag-out">OUT</span> : r.inPit ? <span className="tag tag-pit">PIT</span> : showGap ? r.gap : r.interval || r.gap}
              </span>
              <span className={`c-last mono${lastIsFastest ? ' t-purple' : r.personalBestLast ? ' t-green' : ''}`}>{fmtLap(r.lastLap)}</span>
              <span className={`c-best mono${isFastest ? ' t-purple' : ''}`}>{fmtLap(r.bestLap)}</span>
              <span className="c-tyre">
                <TyreBadge compound={r.compound} />
                <span className="mono tyre-age">{r.tyreAge ?? ''}</span>
              </span>
              <span className="c-pit mono">{r.pits || ''}</span>
              {onWatch && !r.out && (
                <button
                  className="row-cam"
                  title={`Watch ${d?.code ?? r.num}'s onboard`}
                  aria-label={`Watch ${d?.code ?? r.num}'s onboard`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onWatch(r.num);
                  }}
                >
                  <CamIcon size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
