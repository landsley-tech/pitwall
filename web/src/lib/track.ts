// Geometry for drawing the track: rotation, fitting to the canvas, and
// walking along the outline (used for estimated live positions).
import type { TrackInfo } from '@shared/types';

export interface Projector {
  (x: number, y: number): [number, number];
  scale: number;
}

export function makeProjector(track: TrackInfo, width: number, height: number, pad = 48): Projector {
  const a = (track.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const rot = (x: number, y: number): [number, number] => [x * cos - y * sin, x * sin + y * cos];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < track.x.length; i++) {
    const [rx, ry] = rot(track.x[i], track.y[i]);
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  const scale = Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  const fn = ((x: number, y: number) => {
    const [rx, ry] = rot(x, y);
    // Screen y grows downwards, so flip it.
    return [offX + (rx - minX) * scale, height - (offY + (ry - minY) * scale)];
  }) as Projector;
  fn.scale = scale;
  return fn;
}

export class TrackPath {
  private cum: number[] = [0];
  readonly length: number;
  private track: TrackInfo;

  constructor(track: TrackInfo) {
    this.track = track;
    for (let i = 1; i < track.x.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(track.x[i] - track.x[i - 1], track.y[i] - track.y[i - 1]));
    }
    // Close the loop back to the first point.
    const n = track.x.length - 1;
    this.length = this.cum[n] + Math.hypot(track.x[0] - track.x[n], track.y[0] - track.y[n]);
  }

  /** Point at a fraction (0..1) of the lap. */
  pointAt(f: number): { x: number; y: number } {
    const { x, y } = this.track;
    const d = (((f % 1) + 1) % 1) * this.length;
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % x.length;
    const segLen = (j === 0 ? this.length : this.cum[j]) - this.cum[i];
    const k = segLen > 0 ? (d - this.cum[i]) / segLen : 0;
    return { x: x[i] + (x[j] - x[i]) * k, y: y[i] + (y[j] - y[i]) * k };
  }
}
