import { useEffect, useRef } from 'react';
import type { CarPos, DriverInfo, TrackInfo } from '@shared/types';
import { makeProjector, type Projector } from '../lib/track';

interface Props {
  track: TrackInfo | null;
  drivers: DriverInfo[];
  getCars: () => CarPos[] | null;
  yellowSectors: number[];
  selected: string | null;
  onSelect: (num: string | null) => void;
  startFinish?: { x: number; y: number } | null;
  badge?: string | null;
  emptyMessage?: string | null;
}

// Theme colours are fixed, so read each CSS variable once.
const cssCache = new Map<string, string>();
const css = (name: string) => {
  let v = cssCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cssCache.set(name, v);
  }
  return v;
};

export function TrackMap(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const hits = useRef<{ num: string; x: number; y: number }[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let proj: Projector | null = null;
    let projTrack: TrackInfo | null = null;
    let trackLayer: HTMLCanvasElement | null = null;
    let layerKey = '';

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      proj = null;
      layerKey = '';
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const drawTrackLayer = (track: TrackInfo, p: Projector, yellow: number[], sf: Props['startFinish']) => {
      const dpr = window.devicePixelRatio || 1;
      const layer = document.createElement('canvas');
      layer.width = Math.round(w * dpr);
      layer.height = Math.round(h * dpr);
      const c = layer.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pts = track.x.map((x, i) => p(x, track.y[i]));
      const path = new Path2D();
      pts.forEach(([x, y], i) => {
        if (i) path.lineTo(x, y);
        else path.moveTo(x, y);
      });
      path.closePath();

      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.strokeStyle = css('--track-edge');
      c.lineWidth = 16;
      c.stroke(path);
      c.strokeStyle = css('--track');
      c.lineWidth = 10;
      c.stroke(path);

      // Yellow marshal sectors.
      if (yellow.length && track.sectorStarts.length) {
        c.strokeStyle = css('--yellow');
        c.lineWidth = 6;
        for (const s of yellow) {
          const a = track.sectorStarts[s - 1];
          if (a == null) continue;
          const b = track.sectorStarts[s] ?? pts.length;
          c.beginPath();
          for (let i = a; i <= b; i++) {
            const [x, y] = pts[i % pts.length];
            if (i === a) c.moveTo(x, y);
            else c.lineTo(x, y);
          }
          c.stroke();
        }
      }

      // Start / finish line, drawn across the track.
      if (sf) {
        let best = 0;
        let bd = Infinity;
        track.x.forEach((x, i) => {
          const d = (x - sf.x) ** 2 + (track.y[i] - sf.y) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        const [ax, ay] = pts[(best - 2 + pts.length) % pts.length];
        const [bx, by] = pts[(best + 2) % pts.length];
        const [cx, cy] = pts[best];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        c.strokeStyle = css('--text');
        c.lineWidth = 3;
        c.lineCap = 'butt';
        c.beginPath();
        c.moveTo(cx - nx * 10, cy - ny * 10);
        c.lineTo(cx + nx * 10, cy + ny * 10);
        c.stroke();
      }

      // Corner numbers, pushed to the outside of the track.
      const cxm = pts.reduce((s, q) => s + q[0], 0) / pts.length;
      const cym = pts.reduce((s, q) => s + q[1], 0) / pts.length;
      c.font = `600 10px ${css('--font-mono')}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (const corner of track.corners) {
        const [x, y] = p(corner.x, corner.y);
        let dx = x - cxm;
        let dy = y - cym;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        c.fillStyle = css('--dim');
        c.fillText(String(corner.number), x + dx * 20, y + dy * 20);
      }
      return layer;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { track, drivers, getCars, yellowSectors, selected, startFinish } = propsRef.current;
      ctx.clearRect(0, 0, w, h);
      if (!track || w < 10) return;
      if (!proj || projTrack !== track) {
        proj = makeProjector(track, w, h, Math.max(40, Math.min(w, h) * 0.08));
        projTrack = track;
        layerKey = '';
      }
      const key = `${w}x${h}|${[...yellowSectors].sort().join(',')}|${startFinish?.x ?? ''}`;
      if (key !== layerKey) {
        trackLayer = drawTrackLayer(track, proj, yellowSectors, startFinish);
        layerKey = key;
      }
      if (trackLayer) ctx.drawImage(trackLayer, 0, 0, w, h);

      const cars = getCars() ?? [];
      const byNum = new Map(drivers.map((d) => [d.num, d]));
      hits.current = [];
      // Draw the selected car last so it sits on top.
      const ordered = [...cars].sort((a, b) => (a.num === selected ? 1 : 0) - (b.num === selected ? 1 : 0));
      const mono = css('--font-mono');
      for (const car of ordered) {
        const d = byNum.get(car.num);
        const [x, y] = proj(car.x, car.y);
        hits.current.push({ num: car.num, x, y });
        const isSel = car.num === selected;
        const dimmed = selected && !isSel;
        ctx.globalAlpha = dimmed ? 0.55 : 1;
        if (isSel) {
          ctx.beginPath();
          ctx.arc(x, y, 13, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, isSel ? 8 : 6.5, 0, Math.PI * 2);
        ctx.fillStyle = d?.colour ?? '#888';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = isSel ? '#fff' : css('--bg');
        ctx.stroke();

        const label = d?.code ?? car.num;
        ctx.font = `700 ${isSel ? 12 : 10.5}px ${mono}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = css('--bg');
        ctx.strokeText(label, x + 10, y);
        ctx.fillStyle = isSel ? '#fff' : css('--text');
        ctx.fillText(label, x + 10, y);
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const onClick = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: string | null = null;
    let bd = 16 * 16;
    for (const hpt of hits.current) {
      const d = (hpt.x - x) ** 2 + (hpt.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = hpt.num;
      }
    }
    props.onSelect(best && best === props.selected ? null : best);
  };

  return (
    <div className="track-map" ref={wrapRef}>
      <canvas ref={canvasRef} onClick={onClick} />
      {props.badge && <div className="map-badge">{props.badge}</div>}
      {!props.track && <div className="map-empty">{props.emptyMessage ?? 'Loading track…'}</div>}
      {props.track && props.emptyMessage && <div className="map-note">{props.emptyMessage}</div>}
    </div>
  );
}
