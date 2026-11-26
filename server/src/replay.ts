// Builds a compact replay file for one session from OpenF1 data.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  BuildStatus,
  Compound,
  DriverInfo,
  RcMessage,
  ReplayCarTrack,
  ReplayData,
  ReplayLap,
  SessionMeta,
  Stint,
  TrackInfo,
} from '../../shared/types.ts';
import { deriveTrack, getCircuit } from './circuit.ts';
import { openf1 } from './openf1.ts';
import { CACHE_DIR } from './paths.ts';

const FORMAT_VERSION = 1;
const CHUNK_MS = 10 * 60_000;

const jobs = new Map<number, { status: BuildStatus; promise: Promise<Buffer> }>();

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function compound(c: string | null | undefined): Compound {
  const v = (c ?? '').toUpperCase();
  return (['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'] as Compound[]).includes(v as Compound)
    ? (v as Compound)
    : 'UNKNOWN';
}

function deltaEncode(values: number[]): number[] {
  const out = new Array(values.length);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] - prev;
    prev = values[i];
  }
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(r);
  return out;
}

export function sessionMetaFrom(s: any, meetingName?: string): SessionMeta {
  return {
    key: s.session_key,
    name: s.session_name,
    type: s.session_type,
    meeting: meetingName ?? `${s.country_name} Grand Prix`,
    circuit: s.circuit_short_name,
    circuitKey: s.circuit_key,
    country: s.country_name,
    countryCode: s.country_code,
    year: s.year,
    dateStart: s.date_start,
    dateEnd: s.date_end,
    meetingKey: s.meeting_key ?? undefined,
  };
}

async function build(sessionKey: number, status: BuildStatus): Promise<ReplayData> {
  const step = (progress: number, message: string) => {
    status.progress = progress;
    status.message = message;
  };

  step(0.01, 'Loading session');
  const [s] = await openf1('sessions', { session_key: sessionKey });
  if (!s) throw new Error('Session not found');
  const finished = Date.parse(s.date_end) + 30 * 60_000 < Date.now();
  if (!finished) throw new Error('This session has not finished yet. Use Live mode for sessions in progress.');
  const [meeting] = await openf1('meetings', { meeting_key: s.meeting_key }, true);
  const session = sessionMetaFrom(s, meeting?.meeting_name);
  const isRace = s.session_type === 'Race';
  const p = { session_key: sessionKey };

  step(0.04, 'Loading drivers');
  const driverRows = await openf1('drivers', p, true);
  const drivers: DriverInfo[] = driverRows.map((d: any) => ({
    num: String(d.driver_number),
    code: d.name_acronym ?? String(d.driver_number),
    name: d.full_name ?? d.broadcast_name ?? '',
    team: d.team_name ?? '',
    colour: `#${(d.team_colour ?? '888888').replace('#', '')}`,
    headshot: d.headshot_url ?? undefined,
  }));

  step(0.07, 'Loading timing and race control');
  const raceControlRaw = await openf1('race_control', p, true);
  const laps = await openf1('laps', p, true);
  const positionsRaw = await openf1('position', p, true);
  const stintsRaw = await openf1('stints', p, true);
  const pitsRaw = await openf1('pit', p, true);
  const weatherRaw = await openf1('weather', p, true);
  const results = await openf1('session_result', p, true);
  step(0.15, 'Loading gaps');
  const intervalsRaw = isRace ? await openf1('intervals', p, true) : [];

  // Timeline window: a little before the session starts until it ends.
  const t0 = ms(s.date_start) - 5 * 60_000;
  const tEnd = ms(s.date_end) + 10 * 60_000;
  const rel = (iso: string) => ms(iso) - t0;

  // Car positions, fetched in time chunks covering every driver at once.
  const cars: Record<string, { t: number[]; x: number[]; y: number[] }> = {};
  const chunks = Math.ceil((tEnd - t0) / CHUNK_MS);
  for (let i = 0; i < chunks; i++) {
    const a = new Date(t0 + i * CHUNK_MS).toISOString();
    const b = new Date(Math.min(tEnd, t0 + (i + 1) * CHUNK_MS)).toISOString();
    step(0.2 + (0.7 * i) / chunks, `Loading car positions (${i + 1}/${chunks})`);
    const rows = await openf1('location', { ...p, 'date>=': a, 'date<': b }, true);
    for (const r of rows) {
      if (r.x === 0 && r.y === 0) continue;
      const c = (cars[String(r.driver_number)] ??= { t: [], x: [], y: [] });
      c.t.push(Math.round(rel(r.date) / 100));
      c.x.push(r.x);
      c.y.push(r.y);
    }
  }

  step(0.92, 'Building replay');
  const carTracks: Record<string, ReplayCarTrack> = {};
  for (const [num, c] of Object.entries(cars)) {
    const idx = c.t.map((_, i) => i).sort((a, b) => c.t[a] - c.t[b]);
    const t = idx.map((i) => c.t[i]);
    carTracks[num] = {
      t: deltaEncode(t),
      x: deltaEncode(idx.map((i) => c.x[i])),
      y: deltaEncode(idx.map((i) => c.y[i])),
    };
  }

  const raceControl: RcMessage[] = raceControlRaw
    .map((r: any) => ({
      t: rel(r.date),
      lap: r.lap_number ?? null,
      category: r.category ?? 'Other',
      flag: r.flag ?? null,
      scope: r.scope ?? null,
      sector: r.sector ?? (/SECTOR (\d+)/.exec(r.message ?? '')?.[1] ? Number(/SECTOR (\d+)/.exec(r.message)![1]) : null),
      driver: r.driver_number != null ? String(r.driver_number) : null,
      message: r.message ?? '',
    }))
    .sort((a: RcMessage, b: RcMessage) => a.t - b.t);

  const started = raceControl.find((m) => m.category === 'SessionStatus' && /STARTED/.test(m.message));
  const startAt = started ? Math.max(0, started.t) : Math.max(0, ms(s.date_start) - t0);

  const lapsBy: Record<string, ReplayLap[]> = {};
  for (const [num, rows] of Object.entries(groupBy(laps, (l: any) => String(l.driver_number)))) {
    const sorted = rows.sort((a: any, b: any) => a.lap_number - b.lap_number);
    lapsBy[num] = sorted.map((l: any, i: number) => {
      let start = l.date_start ? rel(l.date_start) : NaN;
      if (Number.isNaN(start)) {
        // Lap 1 has no start time in OpenF1; work back from lap 2 or use lights out.
        const next = sorted[i + 1];
        start = next?.date_start && l.lap_duration ? rel(next.date_start) - l.lap_duration * 1000 : startAt;
      }
      return {
        lap: l.lap_number,
        start,
        dur: l.lap_duration ?? null,
        s: [l.duration_sector_1 ?? null, l.duration_sector_2 ?? null, l.duration_sector_3 ?? null],
        pitOut: !!l.is_pit_out_lap,
      };
    });
  }

  const positions: ReplayData['positions'] = {};
  for (const r of positionsRaw.sort((a: any, b: any) => ms(a.date) - ms(b.date))) {
    (positions[String(r.driver_number)] ??= []).push([rel(r.date), r.position]);
  }

  const intervals: ReplayData['intervals'] = {};
  for (const r of intervalsRaw.sort((a: any, b: any) => ms(a.date) - ms(b.date))) {
    (intervals[String(r.driver_number)] ??= []).push([rel(r.date), r.gap_to_leader ?? null, r.interval ?? null]);
  }

  const stints: Record<string, Stint[]> = {};
  for (const r of stintsRaw) {
    (stints[String(r.driver_number)] ??= []).push({
      n: r.stint_number,
      compound: compound(r.compound),
      lapStart: r.lap_start ?? 1,
      lapEnd: r.lap_end ?? r.lap_start ?? 1,
      ageStart: r.tyre_age_at_start ?? 0,
    });
  }
  for (const list of Object.values(stints)) list.sort((a, b) => a.n - b.n);

  const totalLaps = Math.max(0, ...results.map((r: any) => r.number_of_laps ?? 0)) || null;

  let track: TrackInfo | null = await getCircuit(s.circuit_key, s.year);
  if (!track) {
    // Fallback: trace a mid-session lap of the car with the most laps.
    const [num, l] = Object.entries(lapsBy).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    const c = num ? cars[num] : undefined;
    const lap = l?.[Math.floor(l.length / 2)];
    if (c && lap?.dur) {
      const a = lap.start / 100;
      const b = (lap.start + lap.dur * 1000) / 100;
      const xs: number[] = [];
      const ys: number[] = [];
      c.t.forEach((t, i) => {
        if (t >= a && t <= b) {
          xs.push(c.x[i]);
          ys.push(c.y[i]);
        }
      });
      track = deriveTrack(xs, ys);
    }
  }

  const lastLapEnd = Math.max(
    0,
    ...Object.values(lapsBy).flatMap((l) => l.map((x) => x.start + (x.dur ?? 0) * 1000)),
  );
  const duration = Math.min(tEnd - t0, Math.max(lastLapEnd + 3 * 60_000, ms(s.date_end) - t0));

  return {
    version: FORMAT_VERSION,
    session,
    t0,
    duration,
    startAt,
    totalLaps,
    isRace: isRace,
    drivers,
    track,
    cars: carTracks,
    positions,
    intervals,
    laps: lapsBy,
    stints,
    pits: pitsRaw.map((r: any) => ({
      num: String(r.driver_number),
      t: rel(r.date),
      lap: r.lap_number,
      lane: r.lane_duration ?? r.pit_duration ?? null,
      stop: r.stop_duration ?? null,
    })),
    raceControl,
    weather: weatherRaw
      .map((w: any) => ({
        t: rel(w.date),
        air: w.air_temperature ?? null,
        track: w.track_temperature ?? null,
        humidity: w.humidity ?? null,
        rain: !!w.rainfall,
        wind: w.wind_speed ?? null,
        windDir: w.wind_direction ?? null,
      }))
      .sort((a: any, b: any) => a.t - b.t),
    results: results.map((r: any) => ({
      num: String(r.driver_number),
      position: r.position ?? null,
      dnf: !!r.dnf,
      dns: !!r.dns,
      dsq: !!r.dsq,
      laps: r.number_of_laps ?? null,
    })),
  };
}

const replayFile = (key: number) => path.join(CACHE_DIR, 'replays', `${key}.v${FORMAT_VERSION}.json.gz`);

/** Returns the gzipped replay if ready, otherwise starts/continues a build and returns its status. */
export async function getReplay(sessionKey: number): Promise<{ gz: Buffer } | { status: BuildStatus }> {
  try {
    return { gz: await readFile(replayFile(sessionKey)) };
  } catch {
    /* not built yet */
  }
  const existing = jobs.get(sessionKey);
  if (existing) {
    if (existing.status.state === 'error') jobs.delete(sessionKey);
    return { status: { ...existing.status } };
  }
  const status: BuildStatus = { state: 'building', progress: 0, message: 'Starting' };
  const promise = build(sessionKey, status).then(async (data) => {
    const gz = gzipSync(JSON.stringify(data));
    await mkdir(path.dirname(replayFile(sessionKey)), { recursive: true });
    await writeFile(replayFile(sessionKey), gz);
    status.state = 'ready';
    status.progress = 1;
    jobs.delete(sessionKey);
    return gz;
  });
  promise.catch((err) => {
    status.state = 'error';
    status.message = err instanceof Error ? err.message : String(err);
    console.error(`[replay ${sessionKey}]`, err);
  });
  jobs.set(sessionKey, { status, promise });
  return { status: { ...status } };
}

/** For tests / CLI. */
export function readReplay(gz: Buffer): ReplayData {
  return JSON.parse(gunzipSync(gz).toString('utf8'));
}
