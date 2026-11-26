// Types shared by the server and the web app.

export type Compound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET' | 'UNKNOWN';

export type TrackStatus =
  | 'GREEN'
  | 'YELLOW'
  | 'SC'
  | 'SC_ENDING'
  | 'VSC'
  | 'VSC_ENDING'
  | 'RED'
  | 'CHEQUERED'
  | 'NONE';

export interface SessionMeta {
  key: number;
  name: string; // "Race", "Qualifying", "Sprint", ...
  type: string; // "Race", "Qualifying", "Practice"
  meeting: string; // "Australian Grand Prix"
  circuit: string;
  circuitKey: number;
  country: string;
  countryCode: string;
  year: number;
  dateStart: string;
  dateEnd: string;
  /** F1 meeting key (same in OpenF1, the live feed and MultiViewer); missing in older cached replays */
  meetingKey?: number;
}

export interface DriverInfo {
  num: string;
  code: string;
  name: string;
  team: string;
  colour: string; // "#rrggbb"
  headshot?: string;
}

export interface Corner {
  number: number;
  x: number;
  y: number;
}

export interface TrackInfo {
  x: number[];
  y: number[];
  rotation: number; // degrees
  corners: Corner[];
  /** marshal sector n (1-based) starts at index sectorStarts[n-1] of x/y */
  sectorStarts: number[];
  source: 'circuit-api' | 'derived';
}

export interface Stint {
  n: number;
  compound: Compound;
  lapStart: number;
  lapEnd: number;
  ageStart: number;
}

export interface RcMessage {
  t: number; // epoch ms
  lap: number | null;
  category: string;
  flag: string | null;
  scope: string | null;
  sector: number | null;
  driver: string | null;
  message: string;
}

export interface Weather {
  air: number | null;
  track: number | null;
  humidity: number | null;
  rain: boolean;
  wind: number | null;
  windDir: number | null;
}

export interface DriverRow {
  num: string;
  position: number | null;
  gridPos: number | null;
  gap: string; // already formatted ("+1.234", "+1 LAP", "LEADER", "")
  interval: string;
  lastLap: number | null; // seconds
  bestLap: number | null; // seconds
  sectors: (number | null)[]; // last completed lap's sectors
  laps: number;
  compound: Compound;
  tyreAge: number | null;
  tyreNew: boolean | null;
  pits: number;
  inPit: boolean;
  out: boolean;
  personalBestLast: boolean;
}

export interface RaceState {
  now: number; // epoch ms
  lap: number | null;
  totalLaps: number | null;
  trackStatus: TrackStatus;
  yellowSectors: number[];
  rows: DriverRow[]; // sorted by position
  raceControl: RcMessage[]; // newest first
  weather: Weather | null;
  stints: Record<string, Stint[]>;
  fastest: { num: string; time: number } | null;
  remaining?: string | null; // session clock, live only
}

export interface CarPos {
  num: string;
  x: number;
  y: number;
}

// ---------- Replay wire format ----------

/** Delta-encoded integer series: value[i] = value[i-1] + d[i], value[0] = d[0] */
export interface ReplayCarTrack {
  t: number[]; // deciseconds from t0, delta-encoded
  x: number[]; // delta-encoded
  y: number[]; // delta-encoded
}

export interface ReplayLap {
  lap: number;
  start: number; // ms from t0
  dur: number | null; // seconds
  s: (number | null)[];
  pitOut: boolean;
}

export interface ReplayData {
  version: number;
  session: SessionMeta;
  t0: number; // epoch ms
  duration: number; // ms
  startAt: number; // ms from t0 (lights out / session start)
  totalLaps: number | null;
  isRace: boolean;
  drivers: DriverInfo[];
  track: TrackInfo | null;
  cars: Record<string, ReplayCarTrack>;
  /** [msFromT0, position] */
  positions: Record<string, [number, number][]>;
  /** [msFromT0, gapToLeader, interval]; gap may be a string like "+1 LAP" */
  intervals: Record<string, [number, number | string | null, number | string | null][]>;
  laps: Record<string, ReplayLap[]>;
  stints: Record<string, Stint[]>;
  pits: { num: string; t: number; lap: number; lane: number | null; stop: number | null }[];
  raceControl: RcMessage[]; // t is ms from t0 here
  weather: (Weather & { t: number })[];
  results: { num: string; position: number | null; dnf: boolean; dns: boolean; dsq: boolean; laps: number | null }[];
}

export interface BuildStatus {
  state: 'building' | 'ready' | 'error';
  progress: number; // 0..1
  message: string;
}

// ---------- Live wire format (server -> browser) ----------

export type LiveMessage =
  | {
      type: 'state';
      connected: boolean;
      hasPositions: boolean;
      session: SessionMeta | null;
      sessionStatus: string | null;
      drivers: DriverInfo[];
      state: RaceState;
      /** epoch ms when each driver's current lap started (for estimated map positions) */
      lapStartedAt: Record<string, number>;
    }
  | { type: 'positions'; ts: number; cars: CarPos[] }
  | { type: 'status'; connected: boolean; message: string };

// ---------- Onboard cameras (MultiViewer + F1 TV) ----------

/** A video feed to open: one driver's onboard, or a main channel like F1 LIVE. */
export type OnboardFeed = { kind: 'driver'; num: number } | { kind: 'main'; title: MainFeedTitle };

export const MAIN_FEEDS = ['F1 LIVE', 'INTERNATIONAL', 'TRACKER', 'DATA'] as const;
export type MainFeedTitle = (typeof MAIN_FEEDS)[number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OnboardPlayer {
  id: string;
  title: string | null;
  driverNumber: number | null;
  tla: string | null;
  contentId: string | null;
}

export interface OnboardStatus {
  /** MultiViewer answered on its local API */
  available: boolean;
  version: string | null;
  players: OnboardPlayer[];
  /** onboard control is turned off for this client (not on this machine) */
  remoteBlocked?: boolean;
  error?: string;
}

/** The F1 TV video for a session, from MultiViewer's meeting data. */
export interface OnboardSession {
  contentId: string;
  title: string;
  /** seconds into the video where the session starts, for replay sync */
  videoStart: number | null;
  /** epoch ms of that same moment */
  wallStart: number | null;
}

export type OnboardLayout = 'grid' | 'feature';

export interface OnboardOpenRequest {
  contentId: string;
  feeds: OnboardFeed[];
  /** screen area to tile, in screen pixels; omitted = let MultiViewer place the window */
  area?: Rect;
  layout: OnboardLayout;
  /** close the players that are already open first */
  replace: boolean;
}

export type OnboardControl =
  | { action: 'sync' | 'play' | 'pause' | 'mute' | 'unmute' | 'close' }
  | { action: 'seek'; seconds: number };
