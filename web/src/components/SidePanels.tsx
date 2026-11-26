import type { DriverInfo, DriverRow, RcMessage, ReplayLap, Weather } from '@shared/types';
import { fmtLap, fmtSector, fmtTimeOfDay } from '../lib/format';
import { CamIcon } from './OnboardDrawer';
import { TyreBadge } from './TyreBadge';

export function DriverCard({
  driver,
  row,
  history,
  onClose,
  onWatch,
}: {
  driver: DriverInfo;
  row: DriverRow | undefined;
  history: ReplayLap[] | null;
  onClose: () => void;
  onWatch?: () => void;
}) {
  const recent = history ? history.slice(-6).reverse() : null;
  const best = history ? Math.min(...history.map((l) => l.dur ?? Infinity)) : null;
  return (
    <section className="panel driver-card" style={{ ['--team' as string]: driver.colour }}>
      <div className="driver-top">
        {driver.headshot ? <img src={driver.headshot} alt="" className="headshot" /> : <div className="headshot" />}
        <div className="driver-id">
          <div className="driver-name">{driver.name}</div>
          <div className="driver-team">
            {driver.team} · #{driver.num}
          </div>
        </div>
        <div className="driver-pos">
          <span className="label">Pos</span>
          <span className="big mono">{row?.out ? '—' : row?.position ?? '—'}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close driver">
          ×
        </button>
      </div>
      <div className="driver-stats">
        <Stat label="Last lap" value={fmtLap(row?.lastLap)} />
        <Stat label="Best lap" value={fmtLap(row?.bestLap)} />
        <Stat
          label="Tyre"
          value={
            <span className="tyre-inline">
              <TyreBadge compound={row?.compound ?? 'UNKNOWN'} size={18} />
              {row?.tyreAge != null ? `${row.tyreAge} laps` : '—'}
            </span>
          }
        />
        <Stat label="Pit stops" value={String(row?.pits ?? 0)} />
      </div>
      {onWatch && (
        <button className="watch-btn" onClick={onWatch}>
          <CamIcon />
          Watch onboard
          <span className="watch-sub muted">opens in MultiViewer</span>
        </button>
      )}
      <div className="sector-row">
        {(row?.sectors ?? [null, null, null]).slice(0, 3).map((s, i) => (
          <div key={i} className="sector">
            <span className="label">S{i + 1}</span>
            <span className="mono">{fmtSector(s)}</span>
          </div>
        ))}
      </div>
      {recent && recent.length > 0 && (
        <table className="lap-table">
          <thead>
            <tr>
              <th>Lap</th>
              <th>Time</th>
              <th>S1</th>
              <th>S2</th>
              <th>S3</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((l) => (
              <tr key={l.lap} className={l.dur === best ? 't-green' : ''}>
                <td>{l.lap}</td>
                <td>
                  {fmtLap(l.dur)}
                  {l.pitOut && <span className="tag tag-pit small">OUT</span>}
                </td>
                {l.s.map((s, i) => (
                  <td key={i}>{fmtSector(s)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function flagClass(m: RcMessage): string {
  const f = (m.flag ?? '').toUpperCase();
  if (m.category === 'SafetyCar') return 'rc-sc';
  if (f.includes('YELLOW')) return 'rc-yellow';
  if (f === 'RED') return 'rc-red';
  if (f === 'GREEN' || f === 'CLEAR') return 'rc-green';
  if (f === 'BLUE') return 'rc-blue';
  if (f === 'CHEQUERED') return 'rc-chequered';
  if (/PENALTY|INVESTIGATION|STEWARDS/.test(m.message)) return 'rc-stewards';
  return 'rc-info';
}

export function RaceControl({ messages, hideBlue }: { messages: RcMessage[]; hideBlue: boolean }) {
  const list = hideBlue ? messages.filter((m) => m.flag !== 'BLUE') : messages;
  return (
    <section className="panel rc">
      <header className="panel-head">
        <h2>Race control</h2>
        <span className="muted small">{list.length ? `${list.length} messages` : ''}</span>
      </header>
      <ol className="rc-list">
        {list.slice(0, 40).map((m, i) => (
          <li key={`${m.t}-${i}`} className={flagClass(m)}>
            <span className="rc-mark" />
            <div>
              <div className="rc-meta mono">
                {fmtTimeOfDay(m.t)}
                {m.lap ? ` · Lap ${m.lap}` : ''}
              </div>
              <div className="rc-msg">{m.message}</div>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="rc-empty muted">No messages yet</li>}
      </ol>
    </section>
  );
}

export function WeatherCard({ weather }: { weather: Weather | null }) {
  const v = (n: number | null | undefined, unit: string, digits = 1) => (n == null ? '—' : `${n.toFixed(digits)}${unit}`);
  return (
    <section className="panel weather">
      <div className="wx">
        <span className="label">Track</span>
        <span className="mono big-ish">{v(weather?.track, '°')}</span>
      </div>
      <div className="wx">
        <span className="label">Air</span>
        <span className="mono big-ish">{v(weather?.air, '°')}</span>
      </div>
      <div className="wx">
        <span className="label">Humidity</span>
        <span className="mono big-ish">{v(weather?.humidity, '%', 0)}</span>
      </div>
      <div className="wx">
        <span className="label">Wind</span>
        <span className="mono big-ish">
          {weather?.windDir != null && (
            <span className="wind-arrow" style={{ transform: `rotate(${weather.windDir + 180}deg)` }}>
              ↑
            </span>
          )}
          {v(weather?.wind, '', 1)}
          <span className="unit">m/s</span>
        </span>
      </div>
      <div className="wx">
        <span className="label">Rain</span>
        <span className={`mono big-ish${weather?.rain ? ' t-blue' : ''}`}>{weather ? (weather.rain ? 'Yes' : 'No') : '—'}</span>
      </div>
    </section>
  );
}
