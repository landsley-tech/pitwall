// Live mode: listens to the server's WebSocket and keeps the latest state,
// plus a short buffer of car positions so the map can interpolate smoothly.
import { useEffect, useRef, useState } from 'react';
import type { CarPos, LiveMessage } from '@shared/types';

type StateMsg = Extract<LiveMessage, { type: 'state' }>;

export interface LiveData {
  msg: StateMsg | null;
  status: string;
  connected: boolean;
  /** Real car positions at a given wall-clock time (delayed for smoothness). */
  positionsAt: (wallMs: number) => CarPos[] | null;
}

const RENDER_DELAY = 2000;

export function useLive(enabled: boolean): LiveData {
  const [msg, setMsg] = useState<StateMsg | null>(null);
  const [status, setStatus] = useState('Connecting to live timing');
  const [connected, setConnected] = useState(false);
  const frames = useRef<{ ts: number; recv: number; cars: Map<string, CarPos> }[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/live`);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as LiveMessage;
        if (m.type === 'state') {
          setMsg(m);
          setConnected(m.connected);
          setStatus(m.connected ? 'Connected' : 'Connecting to live timing');
        } else if (m.type === 'status') {
          setConnected(m.connected);
          setStatus(m.message);
        } else if (m.type === 'positions') {
          const buf = frames.current;
          buf.push({ ts: m.ts, recv: Date.now(), cars: new Map(m.cars.map((c) => [c.num, c])) });
          while (buf.length > 60) buf.shift();
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          setStatus('Server connection lost, retrying');
          retry = window.setTimeout(open, 3000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [enabled]);

  const positionsAt = (wall: number): CarPos[] | null => {
    const buf = frames.current;
    if (!buf.length) return null;
    // Map wall-clock time to feed time using the newest frame's arrival.
    const newest = buf[buf.length - 1];
    const t = newest.ts + (wall - newest.recv) - RENDER_DELAY;
    let i = buf.length - 1;
    while (i > 0 && buf[i].ts > t) i--;
    const a = buf[i];
    const b = buf[i + 1];
    if (!b) return [...a.cars.values()];
    const k = Math.max(0, Math.min(1, (t - a.ts) / (b.ts - a.ts || 1)));
    const out: CarPos[] = [];
    for (const [num, pa] of a.cars) {
      const pb = b.cars.get(num) ?? pa;
      out.push({ num, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k });
    }
    return out;
  };

  return { msg, status, connected, positionsAt };
}
