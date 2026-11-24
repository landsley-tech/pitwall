// Track outlines (shape, rotation, corner numbers, marshal sectors) from the
// MultiViewer circuit API, cached on disk.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TrackInfo } from '../../shared/types.ts';
import { CACHE_DIR } from './paths.ts';

interface Pt {
  x: number;
  y: number;
}

function nearestIndex(xs: number[], ys: number[], p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = (xs[i] - p.x) ** 2 + (ys[i] - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export async function getCircuit(circuitKey: number, year: number): Promise<TrackInfo | null> {
  const file = path.join(CACHE_DIR, 'circuits', `${circuitKey}-${year}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as TrackInfo;
  } catch {
    /* not cached */
  }
  try {
    const res = await fetch(`https://api.multiviewer.app/api/v1/circuits/${circuitKey}/${year}`, {
      headers: { 'User-Agent': 'pitwall/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d: any = await res.json();
    if (!Array.isArray(d.x) || d.x.length < 10) return null;
    const xs: number[] = d.x;
    const ys: number[] = d.y;
    const track: TrackInfo = {
      x: xs,
      y: ys,
      rotation: Number(d.rotation) || 0,
      corners: (d.corners ?? []).map((c: any) => ({
        number: c.number,
        x: c.trackPosition.x,
        y: c.trackPosition.y,
      })),
      sectorStarts: (d.marshalSectors ?? []).map((s: any) => nearestIndex(xs, ys, s.trackPosition)),
      source: 'circuit-api',
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(track));
    return track;
  } catch {
    return null;
  }
}

/** Fallback outline: one clean lap of position samples from a single car. */
export function deriveTrack(xs: number[], ys: number[]): TrackInfo | null {
  if (xs.length < 50) return null;
  return { x: xs, y: ys, rotation: 0, corners: [], sectorStarts: [], source: 'derived' };
}
