// Turns a ReplayData file into a RaceState for any moment in the session,
// plus smoothly interpolated car positions for the map.
import type {
  CarPos,
  DriverRow,
  RaceState,
  RcMessage,
  ReplayData,
  ReplayLap,
  Stint,
  TrackStatus,
  Weather,
} from '@shared/types';
import { fmtGap } from './format';

interface CarSeries {
  t: Float64Array; // ms from t0
  x: Float32Array;
  y: Float32Array;
}

function decode(d: number[]): number[] {
  const out = new Array(d.length);
  let acc = 0;
  for (let i = 0; i < d.length; i++) out[i] = acc += d[i];
  return out;
}

/** Index of the last element whose key <= t, or -1. */
function lastAtOrBefore<T>(arr: T[], t: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function lastIndex(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const lapEnd = (l: ReplayLap) => (l.dur != null ? l.start + l.dur * 1000 : null);

export interface StatusBand {
  from: number;
  to: number;
  status: TrackStatus;
}

export class ReplayEngine {
  readonly data: ReplayData;
  private cars = new Map<string, CarSeries>();
  private lastLapEnd: Record<string, number> = {};
  readonly statusTimeline: { t: number; status: TrackStatus }[];
  readonly bands: StatusBand[];
  /** Start/finish line position: where the winner's car was when lap 2 began. */
  readonly startFinish: { x: number; y: number } | null;
  readonly lapMarks: { lap: number; t: number }[];
  /** Qualifying: when Q1, Q2 and Q3 each start (green light after a chequered flag). */
  readonly partStarts: number[] = [];

  constructor(data: ReplayData) {
    this.data = data;
    for (const [num, c] of Object.entries(data.cars)) {
      const t = decode(c.t);
      this.cars.set(num, {
        t: Float64Array.from(t, (v) => v * 100),
        x: Float32Array.from(decode(c.x)),
        y: Float32Array.from(decode(c.y)),
      });
    }
    for (const [num, laps] of Object.entries(data.laps)) {
      this.lastLapEnd[num] = Math.max(0, ...laps.map((l) => lapEnd(l) ?? l.start));
    }

    this.statusTimeline = buildStatusTimeline(data.raceControl);
    this.bands = [];
    for (let i = 0; i < this.statusTimeline.length; i++) {
      const cur = this.statusTimeline[i];
      if (cur.status === 'GREEN' || cur.status === 'NONE') continue;
      const next = this.statusTimeline[i + 1];
      this.bands.push({ from: cur.t, to: next ? next.t : data.duration, status: cur.status });
    }

    const winner = data.results.find((r) => r.position === 1)?.num ?? Object.keys(data.laps)[0];
    const lap2 = winner ? data.laps[winner]?.find((l) => l.lap === 2) : undefined;
    this.startFinish = lap2 ? this.carAt(winner!, lap2.start) : null;

    // Lap ticks for the scrubber: the leader's lap starts.
    const leaderLaps = winner ? data.laps[winner] ?? [] : [];
    this.lapMarks = leaderLaps.map((l) => ({ lap: l.lap, t: l.start }));

    if (data.session.type === 'Qualifying') {
      let afterFlag = true;
      for (const m of data.raceControl) {
        if (m.category !== 'Flag' || m.scope !== 'Track') continue;
        if (m.flag === 'CHEQUERED') afterFlag = true;
        else if (m.flag === 'GREEN' && afterFlag) {
          this.partStarts.push(m.t);
          afterFlag = false;
        }
      }
    }
  }

  get drivers() {
    return this.data.drivers;
  }

  private carAt(num: string, t: number): { x: number; y: number } | null {
    const c = this.cars.get(num);
    if (!c || c.t.length === 0) return null;
    const i = lastIndex(c.t, t);
    if (i < 0) return t > c.t[0] - 2000 ? { x: c.x[0], y: c.y[0] } : null;
    if (i >= c.t.length - 1) return t - c.t[i] < 5000 ? { x: c.x[i], y: c.y[i] } : null;
    const span = c.t[i + 1] - c.t[i];
    if (span > 8000) return t - c.t[i] < 3000 ? { x: c.x[i], y: c.y[i] } : null;
    const k = span > 0 ? (t - c.t[i]) / span : 0;
    return { x: c.x[i] + (c.x[i + 1] - c.x[i]) * k, y: c.y[i] + (c.y[i + 1] - c.y[i]) * k };
  }

  carPositions(t: number): CarPos[] {
    const out: CarPos[] = [];
    for (const d of this.data.drivers) {
      const p = this.carAt(d.num, t);
      if (p) out.push({ num: d.num, ...p });
    }
    return out;
  }

  stateAt(t: number): RaceState {
    const d = this.data;
    const rows: DriverRow[] = [];
    const stints: Record<string, Stint[]> = {};
    let fastest: RaceState['fastest'] = null;

    // In qualifying only laps from the current part (Q1/Q2/Q3) count.
    const pi = lastAtOrBefore(this.partStarts, t, (v) => v);
    const partStart = pi >= 0 ? this.partStarts[pi] : -Infinity;
    const partBest: Record<string, number> = {};

    for (const drv of d.drivers) {
      const num = drv.num;
      const laps = d.laps[num] ?? [];
      const started = lastAtOrBefore(laps, t, (l) => l.start) + 1;
      let completed: ReplayLap | null = null;
      let best: number | null = null;
      for (let i = 0; i < laps.length; i++) {
        const e = lapEnd(laps[i]);
        if (e == null || e > t) {
          if (laps[i].start > t) break;
          continue;
        }
        completed = laps[i];
        if (laps[i].dur && (best == null || laps[i].dur! < best)) best = laps[i].dur;
        if (laps[i].dur && laps[i].start >= partStart && !(partBest[num] <= laps[i].dur!)) partBest[num] = laps[i].dur!;
      }
      if (best != null && (!fastest || best < fastest.time)) fastest = { num, time: best };

      const posList = d.positions[num] ?? [];
      const pi = lastAtOrBefore(posList, t, (p) => p[0]);
      const position = pi >= 0 ? posList[pi][1] : null;
      const gridPos = posList.length ? posList[0][1] : null;

      const ivList = d.intervals[num] ?? [];
      const ii = lastAtOrBefore(ivList, t, (v) => v[0]);
      const iv = ii >= 0 ? ivList[ii] : null;

      const lapNo = Math.max(1, started);
      const all = d.stints[num] ?? [];
      // Use the stint covering this lap; after the last stint ends (retired or
      // finished) keep showing the last set of tyres fitted.
      const stint =
        all.find((s) => lapNo >= s.lapStart && lapNo <= s.lapEnd) ??
        [...all].reverse().find((s) => s.lapStart <= lapNo) ??
        all[0];
      stints[num] = all
        .filter((s) => s.lapStart <= lapNo)
        .map((s) => ({ ...s, lapEnd: Math.min(s.lapEnd, lapNo) }));

      const myPits = d.pits.filter((p) => p.num === num && p.t <= t);
      const lastPit = myPits[myPits.length - 1];
      // In practice and qualifying OpenF1's lane time includes time parked in
      // the garage, so cap it at a realistic drive-through.
      const inPit = !!lastPit && t <= lastPit.t + Math.min(lastPit.lane ?? 25, 40) * 1000;

      const res = d.results.find((r) => r.num === num);
      const out = !!res && (res.dns || ((res.dnf || res.dsq) && t > (this.lastLapEnd[num] ?? 0) + 30_000));

      rows.push({
        num,
        position,
        gridPos,
        gap: '',
        interval: '',
        lastLap: completed?.dur ?? null,
        bestLap: best,
        sectors: completed?.s ?? [null, null, null],
        laps: completed?.lap ?? 0,
        compound: stint?.compound ?? 'UNKNOWN',
        tyreAge: stint ? stint.ageStart + (Math.min(lapNo, stint.lapEnd) - stint.lapStart) : null,
        tyreNew: stint ? stint.ageStart === 0 : null,
        pits: myPits.length,
        inPit,
        out,
        personalBestLast: !!completed?.dur && completed.dur === best,
        // gap/interval filled in below
        ...(iv && d.isRace ? { gap: fmtGap(iv[1]), interval: fmtGap(iv[2]) } : {}),
      });
    }

    rows.sort((a, b) => {
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (a.position != null || b.position != null) return (a.position ?? 99) - (b.position ?? 99);
      return (a.bestLap ?? 1e9) - (b.bestLap ?? 1e9);
    });

    if (d.isRace) {
      for (const r of rows) {
        if (r.position === 1) {
          r.gap = 'LEADER';
          r.interval = '';
        }
      }
    } else {
      // Practice and qualifying: gaps come from best laps (current part only in qualifying).
      const useParts = this.partStarts.length > 0;
      const bestOf = (num: string, overall: number | null) => (useParts ? partBest[num] ?? null : overall);
      const times = rows.map((r) => bestOf(r.num, r.bestLap)).filter((v): v is number => v != null);
      const top = times.length ? Math.min(...times) : null;
      let ahead: number | null = null;
      for (const r of rows) {
        const b = bestOf(r.num, r.bestLap);
        if (b == null || top == null) {
          ahead = null;
          continue;
        }
        r.gap = b === top ? '' : signed(b - top);
        r.interval = ahead != null ? signed(b - ahead) : '';
        ahead = b;
      }
    }

    const leader = rows.find((r) => r.position === 1) ?? rows[0];
    const leaderLaps = leader ? d.laps[leader.num] ?? [] : [];
    const leaderLap = leader ? lastAtOrBefore(leaderLaps, t, (l) => l.start) + 1 : 0;

    const si = lastAtOrBefore(this.statusTimeline, t, (s) => s.t);
    const trackStatus = si >= 0 ? this.statusTimeline[si].status : 'NONE';

    const rcEnd = lastAtOrBefore(d.raceControl, t, (m) => m.t);
    const raceControl: RcMessage[] = [];
    for (let i = rcEnd; i >= 0 && raceControl.length < 80; i--) {
      const m = d.raceControl[i];
      raceControl.push({ ...m, t: d.t0 + m.t });
    }

    const wi = lastAtOrBefore(d.weather, t, (w) => w.t);
    const weather: Weather | null = wi >= 0 ? d.weather[wi] : null;

    return {
      now: d.t0 + t,
      lap: t < d.startAt ? null : d.totalLaps ? Math.min(leaderLap, d.totalLaps) : leaderLap,
      totalLaps: d.isRace ? d.totalLaps : null,
      trackStatus,
      yellowSectors: yellowSectorsAt(d.raceControl, rcEnd),
      rows,
      raceControl,
      weather,
      stints,
      fastest,
    };
  }

  lapHistory(num: string, t: number): ReplayLap[] {
    return (this.data.laps[num] ?? []).filter((l) => {
      const e = lapEnd(l);
      return e != null && e <= t;
    });
  }
}

// Knockout qualifying can rank a slower lap ahead of a faster one, so allow negatives.
const signed = (v: number) => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(3)}`;

function buildStatusTimeline(rc: RcMessage[]): { t: number; status: TrackStatus }[] {
  const out: { t: number; status: TrackStatus }[] = [];
  let cur = 'NONE' as TrackStatus;
  const set = (t: number, s: TrackStatus) => {
    if (s !== cur) out.push({ t, status: (cur = s) });
  };
  for (const m of rc) {
    const msg = m.message.toUpperCase();
    if (m.category === 'SafetyCar') {
      if (/VSC DEPLOYED|VIRTUAL SAFETY CAR DEPLOYED/.test(msg)) set(m.t, 'VSC');
      else if (/VSC ENDING|VIRTUAL SAFETY CAR ENDING/.test(msg)) set(m.t, 'VSC_ENDING');
      else if (/SAFETY CAR DEPLOYED/.test(msg)) set(m.t, 'SC');
      else if (/SAFETY CAR IN THIS LAP/.test(msg)) set(m.t, 'SC_ENDING');
    } else if (m.category === 'Flag') {
      if (m.flag === 'RED') set(m.t, 'RED');
      else if (m.flag === 'CHEQUERED') set(m.t, 'CHEQUERED');
      // A green light restarts the session (e.g. Q2 after Q1's chequered flag);
      // "track clear" only ends a caution.
      else if (m.scope === 'Track' && m.flag === 'GREEN') set(m.t, 'GREEN');
      else if (cur !== 'CHEQUERED' && m.scope === 'Track' && m.flag === 'CLEAR') set(m.t, 'GREEN');
    } else if (m.category === 'SessionStatus' && /STARTED/.test(msg) && cur === 'NONE') {
      set(m.t, 'GREEN');
    }
  }
  return out;
}

function yellowSectorsAt(rc: RcMessage[], endIndex: number): number[] {
  const yellow = new Set<number>();
  for (let i = 0; i <= endIndex; i++) {
    const m = rc[i];
    if (m.category !== 'Flag') continue;
    if (m.scope === 'Sector' && m.sector != null) {
      if (/YELLOW/.test(m.flag ?? '')) yellow.add(m.sector);
      else if (m.flag === 'CLEAR') yellow.delete(m.sector);
    } else if (m.scope === 'Track' && (m.flag === 'CLEAR' || m.flag === 'GREEN' || m.flag === 'RED')) {
      yellow.clear();
    }
  }
  return [...yellow];
}
