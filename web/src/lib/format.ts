import type { Compound, TrackStatus } from '@shared/types';

export function fmtLap(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${rest.toFixed(3).padStart(6, '0')}` : rest.toFixed(3);
}

export function fmtSector(s: number | null | undefined): string {
  return s == null || !Number.isFinite(s) ? '—' : s.toFixed(3);
}

export function fmtGap(v: number | string | null | undefined): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return `+${v.toFixed(3)}`;
  return v;
}

export function fmtClock(ms: number): string {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

export function fmtTimeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const COMPOUND_COLOUR: Record<Compound, string> = {
  SOFT: '#ff3b3b',
  MEDIUM: '#ffd23f',
  HARD: '#eef0f3',
  INTERMEDIATE: '#3ecf5a',
  WET: '#2f8cff',
  UNKNOWN: '#6b7280',
};

export const COMPOUND_LETTER: Record<Compound, string> = {
  SOFT: 'S',
  MEDIUM: 'M',
  HARD: 'H',
  INTERMEDIATE: 'I',
  WET: 'W',
  UNKNOWN: '?',
};

export const STATUS_LABEL: Record<TrackStatus, string> = {
  GREEN: 'Track clear',
  YELLOW: 'Yellow flag',
  SC: 'Safety car',
  SC_ENDING: 'SC in this lap',
  VSC: 'Virtual safety car',
  VSC_ENDING: 'VSC ending',
  RED: 'Red flag',
  CHEQUERED: 'Chequered flag',
  NONE: 'Waiting',
};

/** Parses "+1.234" / "1.234" into seconds; laps and blanks give null. */
export function parseGap(v: string): number | null {
  const m = /^\+?(\d+(?:\.\d+)?)$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}
