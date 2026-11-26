// Live timing: connects to the F1 SignalR Core feed, merges the incremental
// updates into one state object and turns it into a RaceState for the browser.
import WebSocket from 'ws';
import { inflateRawSync } from 'node:zlib';
import type {
  CarPos,
  Compound,
  DriverInfo,
  DriverRow,
  LiveMessage,
  RaceState,
  RcMessage,
  SessionMeta,
  Stint,
  TrackStatus,
} from '../../shared/types.ts';

const HOST = 'livetiming.formula1.com';
const RS = '\x1e';
const TOPICS = [
  'SessionInfo',
  'SessionStatus',
  'DriverList',
  'TimingData',
  'TimingAppData',
  'RaceControlMessages',
  'TrackStatus',
  'LapCount',
  'WeatherData',
  'ExtrapolatedClock',
  'Position.z',
];

type Listener = (msg: LiveMessage) => void;

// ---------- merging ----------

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge an F1 feed patch. Arrays are patched with objects keyed by index ("0", "12"). */
export function merge(target: any, patch: any): any {
  if (Array.isArray(target) && isObj(patch)) {
    const out = target.slice();
    for (const [k, v] of Object.entries(patch)) {
      const i = Number(k);
      if (Number.isInteger(i)) out[i] = merge(out[i], v);
    }
    return out;
  }
  if (isObj(target) && isObj(patch)) {
    const out: Record<string, any> = { ...target };
    for (const [k, v] of Object.entries(patch)) out[k] = merge(target[k], v);
    return out;
  }
  return patch;
}

const values = <T = any>(v: unknown): T[] => (Array.isArray(v) ? v : isObj(v) ? (Object.values(v) as T[]) : []);

// ---------- parsing helpers ----------

/** "1:36.182" or "27.995" -> seconds */
export function parseLapTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

function compound(c: unknown): Compound {
  const v = String(c ?? '').toUpperCase();
  return (['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'] as Compound[]).includes(v as Compound)
    ? (v as Compound)
    : 'UNKNOWN';
}

const TRACK_STATUS: Record<string, TrackStatus> = {
  '1': 'GREEN',
  '2': 'YELLOW',
  '4': 'SC',
  '5': 'RED',
  '6': 'VSC',
  '7': 'VSC_ENDING',
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
};

// The feed uses UTC timestamps without a zone suffix.
const utc = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

export function toSession(info: any): SessionMeta | null {
  if (!info?.Meeting) return null;
  const offset = String(info.GmtOffset ?? '00:00:00');
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.replace('-', '').split(':').map(Number);
  const toUtc = (local: string) =>
    new Date(Date.parse(`${local}Z`) - sign * ((h || 0) * 3600 + (m || 0) * 60) * 1000).toISOString();
  return {
    key: info.Key,
    name: info.Name,
    type: info.Type,
    meeting: info.Meeting.Name,
    circuit: info.Meeting.Circuit?.ShortName ?? '',
    circuitKey: info.Meeting.Circuit?.Key ?? 0,
    country: info.Meeting.Country?.Name ?? '',
    countryCode: info.Meeting.Country?.Code ?? '',
    year: info.StartDate ? Number(String(info.StartDate).slice(0, 4)) : new Date().getFullYear(),
    dateStart: info.StartDate ? toUtc(info.StartDate) : '',
    dateEnd: info.EndDate ? toUtc(info.EndDate) : '',
    meetingKey: Number(info.Meeting.Key) || undefined,
  };
}

export function toDrivers(list: any): DriverInfo[] {
  return Object.values<any>(list ?? {})
    .filter((d) => isObj(d) && d.RacingNumber)
    .map((d) => ({
      num: String(d.RacingNumber),
      code: d.Tla ?? String(d.RacingNumber),
      name: d.FullName ?? d.BroadcastName ?? '',
      team: d.TeamName ?? '',
      colour: `#${String(d.TeamColour ?? '888888').replace('#', '')}`,
      headshot: d.HeadshotUrl ?? undefined,
    }));
}

/** Turn merged feed state into the same RaceState the replay engine produces. */
export function toRaceState(st: Record<string, any>, now = Date.now()): RaceState {
  const lines: Record<string, any> = st.TimingData?.Lines ?? {};
  const app: Record<string, any> = st.TimingAppData?.Lines ?? {};
  const isRace = st.SessionInfo?.Type === 'Race';

  const stints: Record<string, Stint[]> = {};
  for (const [n, a] of Object.entries(app)) {
    let lap = 1;
    stints[n] = values(a?.Stints).map((s: any, i: number) => {
      const total = num(s.TotalLaps) ?? 0;
      const start = num(s.StartLaps) ?? 0;
      const driven = Math.max(0, total - start);
      const stint: Stint = {
        n: i + 1,
        compound: compound(s.Compound),
        lapStart: lap,
        lapEnd: lap + Math.max(0, driven - 1),
        ageStart: start,
      };
      lap += Math.max(1, driven);
      return stint;
    });
  }

  let fastest: RaceState['fastest'] = null;
  const rows: DriverRow[] = Object.entries(lines).map(([n, l]) => {
    const best = parseLapTime(l?.BestLapTime?.Value);
    if (best && (!fastest || best < fastest.time)) fastest = { num: n, time: best };
    const ds = values(app[n]?.Stints);
    const cur: any = ds[ds.length - 1];
    const pos = num(l?.Position);
    const gapRaw = isRace ? l?.GapToLeader : l?.TimeDiffToFastest;
    const intRaw = isRace ? l?.IntervalToPositionAhead?.Value : l?.TimeDiffToPositionAhead;
    return {
      num: n,
      position: pos,
      gridPos: num(app[n]?.GridPos),
      gap: pos === 1 ? (isRace ? 'LEADER' : '') : String(gapRaw ?? ''),
      interval: pos === 1 ? '' : String(intRaw ?? ''),
      lastLap: parseLapTime(l?.LastLapTime?.Value),
      bestLap: best,
      sectors: values(l?.Sectors).map((s: any) => parseLapTime(s?.Value)),
      laps: num(l?.NumberOfLaps) ?? 0,
      compound: compound(cur?.Compound),
      tyreAge: cur ? num(cur.TotalLaps) : null,
      tyreNew: cur ? String(cur.New) === 'true' : null,
      pits: num(l?.NumberOfPitStops) ?? 0,
      inPit: !!l?.InPit,
      out: !!(l?.Retired || l?.Stopped),
      personalBestLast: !!l?.LastLapTime?.PersonalFastest,
    };
  });
  rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  const raceControl: RcMessage[] = values(st.RaceControlMessages?.Messages)
    .map((m: any) => ({
      t: utc(m.Utc),
      lap: num(m.Lap),
      category: m.Category ?? 'Other',
      flag: m.Flag ?? null,
      scope: m.Scope ?? null,
      sector: num(m.Sector),
      driver: m.RacingNumber ? String(m.RacingNumber) : null,
      message: m.Message ?? '',
    }))
    .sort((a, b) => b.t - a.t);

  // Yellow sectors: replay the sector flag messages in order.
  const yellow = new Set<number>();
  for (const m of [...raceControl].reverse()) {
    if (m.category !== 'Flag') continue;
    if (m.scope === 'Sector' && m.sector != null) {
      if (/YELLOW/.test(m.flag ?? '')) yellow.add(m.sector);
      else if (m.flag === 'CLEAR') yellow.delete(m.sector);
    } else if (m.scope === 'Track' && (m.flag === 'CLEAR' || m.flag === 'GREEN')) yellow.clear();
  }

  let trackStatus: TrackStatus = TRACK_STATUS[String(st.TrackStatus?.Status)] ?? 'NONE';
  const ss = st.SessionStatus ?? {};
  if (['Finished', 'Finalised', 'Ends'].includes(ss.Status) || ss.Started === 'Finished') trackStatus = 'CHEQUERED';
  if (/CHEQUERED/.test(raceControl[0]?.flag ?? '')) trackStatus = 'CHEQUERED';

  const w = st.WeatherData;
  return {
    now,
    lap: num(st.LapCount?.CurrentLap),
    totalLaps: num(st.LapCount?.TotalLaps),
    trackStatus,
    yellowSectors: [...yellow],
    rows,
    raceControl: raceControl.slice(0, 80),
    weather: w
      ? {
          air: num(w.AirTemp),
          track: num(w.TrackTemp),
          humidity: num(w.Humidity),
          rain: String(w.Rainfall) !== '0',
          wind: num(w.WindSpeed),
          windDir: num(w.WindDirection),
        }
      : null,
    stints,
    fastest,
    remaining: st.ExtrapolatedClock?.Remaining ?? null,
  };
}

export function decodeZ(data: string): any {
  return JSON.parse(inflateRawSync(Buffer.from(data, 'base64')).toString('utf8'));
}

// ---------- connection ----------

export class LiveFeed {
  private ws: WebSocket | null = null;
  private state: Record<string, any> = {};
  private listeners = new Set<Listener>();
  private pushTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private retry = 0;
  private connected = false;
  private hasPositions = false;
  private lapCounts: Record<string, number> = {};
  private lapStartedAt: Record<string, number> = {};
  private lastPositions: LiveMessage | null = null;
  private stopped = true;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopped) this.start();
    else {
      fn(this.snapshot());
      if (this.lastPositions) fn(this.lastPositions);
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        // Keep the connection briefly in case the page is just reloading.
        this.idleTimer = setTimeout(() => this.stop(), 60_000);
      }
    };
  }

  private emit(msg: LiveMessage) {
    for (const fn of this.listeners) fn(msg);
  }

  private start() {
    this.stopped = false;
    this.connect().catch((err) => this.fail(err));
    this.pushTimer ??= setInterval(() => {
      if (this.listeners.size && this.state.TimingData) this.emit(this.snapshot());
    }, 500);
  }

  private stop() {
    this.stopped = true;
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pushTimer = this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private fail(err: unknown) {
    this.connected = false;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[live]', message);
    this.emit({ type: 'status', connected: false, message: `Reconnecting: ${message}` });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => !this.stopped && this.connect().catch((e) => this.fail(e)), delay);
  }

  private async connect() {
    const token = process.env.F1TV_TOKEN;
    const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const neg = await fetch(`https://${HOST}/signalrcore/negotiate?negotiateVersion=1`, {
      method: 'POST',
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
    if (!neg.ok) throw new Error(`negotiate failed (${neg.status})`);
    const cookie = (neg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const { connectionToken } = (await neg.json()) as { connectionToken: string };

    const ws = new WebSocket(`wss://${HOST}/signalrcore?id=${encodeURIComponent(connectionToken)}`, {
      headers: { ...auth, ...(cookie ? { Cookie: cookie } : {}) },
    });
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ws.send(JSON.stringify({ type: 1, invocationId: '0', target: 'Subscribe', arguments: [TOPICS] }) + RS);
      this.pingTimer ??= setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send('{"type":6}' + RS), 15_000);
    });
    ws.on('message', (raw) => {
      for (const part of raw.toString().split(RS)) {
        if (!part) continue;
        let msg: any;
        try {
          msg = JSON.parse(part);
        } catch {
          continue;
        }
        if (msg.type === 3 && msg.invocationId === '0') {
          if (msg.error) return this.fail(new Error(msg.error));
          this.connected = true;
          this.retry = 0;
          this.state = {};
          this.lapCounts = {};
          this.lapStartedAt = {};
          for (const [topic, data] of Object.entries(msg.result ?? {})) this.apply(topic, data, null);
          this.emit(this.snapshot());
        } else if (msg.type === 1 && msg.target === 'feed') {
          const [topic, data, ts] = msg.arguments ?? [];
          if (topic) this.apply(topic, data, ts ?? null);
        } else if (msg.type === 7) {
          this.fail(new Error(msg.error ?? 'server closed the connection'));
        }
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on('error', (err) => console.error('[live] socket error', err.message));
  }

  private apply(topic: string, data: any, ts: string | null) {
    if (topic === 'Position.z') {
      const decoded = typeof data === 'string' ? decodeZ(data) : data;
      const frames = values(decoded?.Position);
      for (const f of frames) {
        const cars: CarPos[] = Object.entries<any>(f.Entries ?? {})
          .filter(([, e]) => e && !(e.X === 0 && e.Y === 0))
          .map(([n, e]) => ({ num: n, x: e.X, y: e.Y }));
        if (!cars.length) continue;
        this.hasPositions = true;
        this.lastPositions = { type: 'positions', ts: utc(f.Timestamp), cars };
        this.emit(this.lastPositions);
      }
      return;
    }
    const key = topic.replace(/\.z$/, '');
    const value = topic.endsWith('.z') && typeof data === 'string' ? decodeZ(data) : data;
    this.state[key] = merge(this.state[key], value);

    if (key === 'TimingData') {
      // Remember when each car started its current lap (for estimated positions).
      const when = ts ? utc(ts) : Date.now();
      for (const [n, l] of Object.entries<any>(this.state.TimingData?.Lines ?? {})) {
        const laps = num(l?.NumberOfLaps);
        if (laps == null) continue;
        if (this.lapCounts[n] !== laps) {
          if (this.lapCounts[n] !== undefined) this.lapStartedAt[n] = when;
          this.lapCounts[n] = laps;
        }
      }
    }
  }

  private snapshot(): LiveMessage {
    return {
      type: 'state',
      connected: this.connected,
      hasPositions: this.hasPositions,
      session: toSession(this.state.SessionInfo),
      sessionStatus: this.state.SessionStatus?.Status ?? null,
      drivers: toDrivers(this.state.DriverList),
      state: toRaceState(this.state),
      lapStartedAt: this.lapStartedAt,
    };
  }
}
