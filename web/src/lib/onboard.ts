// onboard cameras: talks to /api/onboard/* on the pitwall server, which drives
// the MultiViewer desktop app. see README "Onboard cameras".
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OnboardControl,
  OnboardFeed,
  OnboardLayout,
  OnboardOpenRequest,
  OnboardSession,
  OnboardStatus,
  Rect,
  SessionMeta,
} from '@shared/types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/onboard/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface OpenResult {
  opened: string[];
  failed: { feed: OnboardFeed; error: string }[];
}

/**
 * the screen the pitwall window is on, in screen pixels. availLeft/availTop
 * aren't standard but chrome and firefox have them, and they're what makes
 * "tile on the screen pitwall is on" work with a second monitor.
 */
export function screenArea(): Rect {
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    x: Math.round(s.availLeft ?? 0),
    y: Math.round(s.availTop ?? 0),
    width: Math.max(160, Math.round(s.availWidth || s.width || 1920)),
    height: Math.max(90, Math.round(s.availHeight || s.height || 1080)),
  };
}

/**
 * where in the f1 tv video a moment of the session is. e.g. vegas 2026 race:
 * the session starts 533.509 s into the video at 04:03:53.989Z, so 04:13:53.989Z
 * is 1133.509 s in.
 */
export function videoTimeAt(v: OnboardSession | null, epochMs: number): number | null {
  if (!v || v.videoStart == null || v.wallStart == null) return null;
  return Math.max(0, v.videoStart + (epochMs - v.wallStart) / 1000);
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

export interface ReplayClock {
  /** epoch ms of the replay position */
  epoch: number;
  playing: boolean;
  speed: number;
}

export function useOnboard(session: SessionMeta | null, drawerOpen: boolean) {
  const [status, setStatus] = useState<OnboardStatus | null>(null);
  const [video, setVideo] = useState<OnboardSession | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<OnboardStatus>('status'));
    } catch (e) {
      setStatus({ available: false, version: null, players: [], error: (e as Error).message });
    }
  }, []);

  // poll quicker while the drawer is open, and not at all in a background tab
  useEffect(() => {
    refresh();
    const id = setInterval(() => !document.hidden && refresh(), drawerOpen ? 3000 : 15000);
    return () => clearInterval(id);
  }, [refresh, drawerOpen]);

  useEffect(() => {
    setVideo(null);
    setVideoError(null);
    if (!session?.key) return;
    let cancelled = false;
    const q = session.meetingKey ? `?meeting=${session.meetingKey}` : '';
    call<OnboardSession>(`session/${session.key}${q}`)
      .then((v) => !cancelled && setVideo(v))
      .catch((e) => !cancelled && setVideoError(e.message));
    return () => {
      cancelled = true;
    };
  }, [session?.key, session?.meetingKey]);

  const open = useCallback(
    async (feeds: OnboardFeed[], opts: { layout?: OnboardLayout; tile?: boolean; replace?: boolean } = {}) => {
      if (!video) {
        toast('error', videoError ?? 'No F1 TV video found for this session');
        return null;
      }
      setBusy(true);
      try {
        const req: OnboardOpenRequest = {
          contentId: video.contentId,
          feeds,
          layout: opts.layout ?? 'grid',
          area: opts.tile ? screenArea() : undefined,
          replace: opts.replace ?? false,
        };
        const r = await call<OpenResult>('open', req);
        if (r.failed.length) {
          const names = r.failed.map((f) => (f.feed.kind === 'driver' ? `#${f.feed.num}` : f.feed.title)).join(', ');
          toast('error', `Opened ${r.opened.length}, couldn't open ${names}`);
        } else toast('ok', r.opened.length === 1 ? 'Onboard opened in MultiViewer' : `${r.opened.length} feeds opened in MultiViewer`);
        refresh();
        return r;
      } catch (e) {
        toast('error', (e as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [video, videoError, toast, refresh],
  );

  const control = useCallback(
    async (c: OnboardControl, quiet = false) => {
      try {
        const r = await call<{ players: number }>('control', c);
        if (!quiet) {
          const verb: Record<string, string> = { sync: 'Synced', play: 'Playing', pause: 'Paused', mute: 'Muted', unmute: 'Unmuted', close: 'Closed', seek: 'Moved' };
          toast(r.players ? 'ok' : 'info', r.players ? `${verb[c.action]} ${r.players} window${r.players === 1 ? '' : 's'}` : 'No MultiViewer windows open');
        }
        if (c.action === 'close') refresh();
        return r;
      } catch (e) {
        if (!quiet) toast('error', (e as Error).message);
        return null;
      }
    },
    [toast, refresh],
  );

  return { status, video, videoError, busy, toasts, refresh, open, control, toast };
}

/**
 * keeps MultiViewer's windows on the same moment as the replay. video can't
 * run at 25x, so it plays along at 1x and waits (paused, parked on the right
 * moment) at any other speed.
 */
export function useReplayFollow(
  enabled: boolean,
  clock: ReplayClock | undefined,
  video: OnboardSession | null,
  /** ids of the open windows, joined; new windows get lined up as soon as they appear */
  playerKey: string,
  control: (c: OnboardControl, quiet?: boolean) => Promise<unknown>,
) {
  const last = useRef<{ epoch: number; at: number; running: boolean } | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = enabled && playerKey !== '' && !!clock && videoTimeAt(video, 0) != null;
  const running = !!clock && clock.playing && clock.speed === 1;

  // play / pause / speed changes
  useEffect(() => {
    if (!active || !clock) {
      last.current = null;
      return;
    }
    const t = videoTimeAt(video, clock.epoch);
    if (t == null) return;
    (async () => {
      await control({ action: 'seek', seconds: t }, true);
      await control({ action: running ? 'play' : 'pause' }, true);
    })();
    last.current = { epoch: clock.epoch, at: performance.now(), running };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on state changes, the clock tick is handled below
  }, [active, running, video, playerKey]);

  // scrubbing: a jump the playback clock can't explain
  useEffect(() => {
    if (!active || !clock || !last.current) return;
    const now = performance.now();
    const expected = last.current.epoch + (last.current.running ? now - last.current.at : 0) * (clock.playing ? clock.speed : 0);
    const jumped = Math.abs(clock.epoch - expected) > 3000;
    if (!running && clock.playing) {
      // fast-forwarding: the video waits, it catches up when you drop back to 1x
      last.current = { epoch: clock.epoch, at: now, running };
      return;
    }
    last.current = { epoch: clock.epoch, at: now, running };
    if (!jumped) return;
    if (seekTimer.current) clearTimeout(seekTimer.current);
    const target = videoTimeAt(video, clock.epoch);
    seekTimer.current = setTimeout(() => target != null && control({ action: 'seek', seconds: target }, true), 350);
  }, [active, clock?.epoch, clock?.playing, clock?.speed, running, video, control]);

  useEffect(() => () => void (seekTimer.current && clearTimeout(seekTimer.current)), []);
  return active;
}
