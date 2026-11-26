// onboard cameras: drives the MultiViewer desktop app through its local
// GraphQL API (default http://localhost:10101/api/graphql). MultiViewer does
// the F1 TV sign-in and DRM playback, pitwall just tells it which feeds to
// open, where to put the windows, and keeps them in step with a replay.
//
// only fixed operation strings are sent, every value goes in as a GraphQL
// variable, and control requests must come from this machine unless
// PITWALL_REMOTE_CONTROL=1 is set.
import type http from 'node:http';
import { tileLayout } from '../../shared/onboardLayout.ts';
import {
  MAIN_FEEDS,
  type MainFeedTitle,
  type OnboardControl,
  type OnboardFeed,
  type OnboardOpenRequest,
  type OnboardPlayer,
  type OnboardSession,
  type OnboardStatus,
  type Rect,
} from '../../shared/types.ts';

export interface OnboardDeps {
  /** MultiViewer's GraphQL endpoint */
  mvUrl: string;
  /** MultiViewer's public meta API (content ids per session) */
  metaBase: string;
  /** let other devices on the network control the windows */
  allowRemote: boolean;
  /** session key -> meeting key, for replays cached before meetingKey existed */
  lookupMeeting: (sessionKey: number) => Promise<number | null>;
  fetch?: typeof fetch;
  /** gap between window creates so MultiViewer isn't flooded, ms */
  createGapMs?: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_FEEDS = 24; // 20 cars + a main feed, with a bit of slack
const MAX_BODY = 16 * 1024;
const COORD_LIMIT = 100_000; // multi-monitor setups go negative and wide, but not this wide

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function parseContentId(v: unknown): string {
  // f1 tv content ids are plain digits, e.g. "1000010442"
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,15}$/.test(s)) throw new HttpError(400, 'contentId must be an F1 TV content id (digits)');
  return s;
}

function parseFeed(v: unknown): OnboardFeed {
  if (!isObj(v)) throw new HttpError(400, 'each feed must be an object');
  if (v.kind === 'driver') {
    if (!isInt(v.num, 1, 99)) throw new HttpError(400, 'driver feeds need a car number from 1 to 99');
    return { kind: 'driver', num: v.num };
  }
  if (v.kind === 'main') {
    if (!MAIN_FEEDS.includes(v.title as MainFeedTitle)) throw new HttpError(400, `main feed must be one of ${MAIN_FEEDS.join(', ')}`);
    return { kind: 'main', title: v.title as MainFeedTitle };
  }
  throw new HttpError(400, 'feed kind must be "driver" or "main"');
}

function parseRect(v: unknown): Rect {
  if (!isObj(v)) throw new HttpError(400, 'area must be an object');
  const { x, y, width, height } = v;
  if (!isInt(x, -COORD_LIMIT, COORD_LIMIT) || !isInt(y, -COORD_LIMIT, COORD_LIMIT))
    throw new HttpError(400, 'area x/y must be whole numbers');
  if (!isInt(width, 160, COORD_LIMIT) || !isInt(height, 90, COORD_LIMIT))
    throw new HttpError(400, 'area width/height must be whole numbers of at least 160x90');
  return { x, y, width, height };
}

export function parseOpenRequest(body: unknown): OnboardOpenRequest {
  if (!isObj(body)) throw new HttpError(400, 'expected a JSON object');
  const contentId = parseContentId(body.contentId);
  if (!Array.isArray(body.feeds) || body.feeds.length === 0) throw new HttpError(400, 'feeds must be a non-empty list');
  if (body.feeds.length > MAX_FEEDS) throw new HttpError(400, `at most ${MAX_FEEDS} feeds at once`);
  const feeds = body.feeds.map(parseFeed);
  const seen = new Set(feeds.map((f) => (f.kind === 'driver' ? `d${f.num}` : `m${f.title}`)));
  if (seen.size !== feeds.length) throw new HttpError(400, 'the same feed is listed twice');
  const layout = body.layout ?? 'grid';
  if (layout !== 'grid' && layout !== 'feature') throw new HttpError(400, 'layout must be "grid" or "feature"');
  return {
    contentId,
    feeds,
    area: body.area === undefined || body.area === null ? undefined : parseRect(body.area),
    layout,
    replace: body.replace === true,
  };
}

export function parseControl(body: unknown): OnboardControl {
  if (!isObj(body)) throw new HttpError(400, 'expected a JSON object');
  const a = body.action;
  if (a === 'seek') {
    const s = body.seconds;
    // a long race with a red flag is still well under a day of video
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 86_400) throw new HttpError(400, 'seconds must be 0 to 86400');
    return { action: 'seek', seconds: s };
  }
  if (a === 'sync' || a === 'play' || a === 'pause' || a === 'mute' || a === 'unmute' || a === 'close') return { action: a };
  throw new HttpError(400, 'unknown action');
}

// ---------- request guard ----------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function hostName(host: string): string {
  // "localhost:8787" -> "localhost", "[::1]:8787" -> "[::1]"
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  return (m?.[1] ?? '').toLowerCase();
}

/**
 * null when the request may control MultiViewer, otherwise why not.
 * - another device on the network: blocked unless allowRemote
 * - DNS rebinding (evil.com resolving to 127.0.0.1): Host isn't a loopback name, blocked
 * - another website posting from your browser: Origin doesn't match Host, blocked,
 *   and JSON-only bodies force a CORS preflight that this server never answers
 */
export function guard(req: http.IncomingMessage, allowRemote: boolean, write: boolean): HttpError | null {
  const host = String(req.headers.host ?? '');
  if (!allowRemote) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return new HttpError(403, 'Onboard control only works from the machine running pitwall (set PITWALL_REMOTE_CONTROL=1 to allow other devices)');
    }
    if (!LOOPBACK_HOSTS.has(hostName(host))) return new HttpError(403, 'Unexpected Host header');
  }
  if (!write) return null;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return new HttpError(403, 'Cross-origin requests are not allowed');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return new HttpError(403, 'Cross-site requests are not allowed');
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    return new HttpError(415, 'Content-Type must be application/json');
  }
  return null;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

// ---------- multiviewer client ----------

const Q_STATUS = 'query PitwallStatus { version players { id streamData { contentId title } driverData { driverNumber tla } } }';
// older/newer MultiViewer builds may not have every field, so fall back to the bare minimum
const Q_STATUS_MIN = 'query PitwallStatusMin { version players { id } }';
const M_CREATE = 'mutation PitwallCreate($input: PlayerCreateInput!) { playerCreate(input: $input) }';
const M_DELETE = 'mutation PitwallDelete($id: ID!) { playerDelete(id: $id) }';
const M_SYNC = 'mutation PitwallSync($id: ID!) { playerSync(id: $id) }';
const M_PAUSE = 'mutation PitwallPause($id: ID!, $paused: Boolean) { playerSetPaused(id: $id, paused: $paused) }';
const M_MUTE = 'mutation PitwallMute($id: ID!, $muted: Boolean) { playerSetMuted(id: $id, muted: $muted) }';
const M_SEEK = 'mutation PitwallSeek($id: ID!, $absolute: Float) { playerSeekTo(id: $id, absolute: $absolute) }';

class MvUnavailable extends HttpError {
  constructor(detail: string) {
    super(503, `MultiViewer isn't reachable (${detail}). Open MultiViewer and sign in to F1 TV.`);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : typeof v === 'number' ? String(v) : null);

export function createOnboard(deps: OnboardDeps) {
  const doFetch = deps.fetch ?? fetch;
  const gap = deps.createGapMs ?? 150;
  const sessionCache = new Map<string, { at: number; data: OnboardSession | null }>();
  const meetingOf = new Map<number, number>(); // session key -> meeting key, never changes

  async function gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(deps.mvUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      const cause = (err as any)?.cause?.code ?? (err as Error)?.name ?? 'no answer';
      throw new MvUnavailable(String(cause));
    }
    if (!res.ok) throw new MvUnavailable(`HTTP ${res.status}`);
    const body: any = await res.json().catch(() => null);
    if (!isObj(body)) throw new HttpError(502, 'MultiViewer sent an unexpected reply');
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new HttpError(502, `MultiViewer: ${String(body.errors[0]?.message ?? 'error').slice(0, 200)}`);
    }
    return body.data as T;
  }

  async function players(): Promise<{ version: string | null; players: OnboardPlayer[] }> {
    let data: any;
    try {
      data = await gql(Q_STATUS);
    } catch (err) {
      if (err instanceof MvUnavailable) throw err;
      data = await gql(Q_STATUS_MIN);
    }
    const list: unknown[] = Array.isArray(data?.players) ? data.players : [];
    return {
      version: str(data?.version),
      players: list.filter(isObj).flatMap((p: any) => {
        const id = str(p.id);
        if (!id) return [];
        const n = Number(p.driverData?.driverNumber);
        return [
          {
            id,
            title: str(p.streamData?.title),
            driverNumber: Number.isInteger(n) ? n : null,
            tla: str(p.driverData?.tla),
            contentId: str(p.streamData?.contentId),
          },
        ];
      }),
    };
  }

  async function status(): Promise<OnboardStatus> {
    try {
      return { available: true, ...(await players()) };
    } catch (err) {
      return { available: false, version: null, players: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function session(sessionKey: number, meetingKey: number | null): Promise<OnboardSession | null> {
    const meeting = meetingKey ?? meetingOf.get(sessionKey) ?? (await deps.lookupMeeting(sessionKey));
    if (!meeting) return null;
    meetingOf.set(sessionKey, meeting);
    const cacheKey = `${meeting}/${sessionKey}`;
    const hit = sessionCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

    const res = await doFetch(`${deps.metaBase}/api/v1/meetings/${meeting}`, {
      headers: { 'User-Agent': 'pitwall/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(502, `MultiViewer meeting data: HTTP ${res.status}`);
    const body: any = await res.json();
    const data = pickSession(body, sessionKey);
    sessionCache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  async function open(req: OnboardOpenRequest) {
    if (req.replace) {
      const { players: open } = await players();
      await Promise.all(open.map((p) => gql(M_DELETE, { id: p.id })));
    }
    const rects = req.area ? tileLayout(req.feeds.length, req.area, req.layout) : [];
    const opened: string[] = [];
    const failed: { feed: OnboardFeed; error: string }[] = [];
    for (let i = 0; i < req.feeds.length; i++) {
      const feed = req.feeds[i];
      const input: Record<string, unknown> = {
        contentId: req.contentId,
        maintainAspectRatio: true,
        ...(feed.kind === 'driver' ? { driverNumber: feed.num } : { streamTitle: feed.title }),
        ...(rects[i] ? { bounds: rects[i] } : {}),
      };
      try {
        const data = await gql(M_CREATE, { input });
        opened.push(String(data?.playerCreate));
      } catch (err) {
        if (err instanceof MvUnavailable) throw err;
        failed.push({ feed, error: err instanceof Error ? err.message : String(err) });
      }
      if (gap && i < req.feeds.length - 1) await new Promise((r) => setTimeout(r, gap));
    }
    return { opened, failed };
  }

  async function control(c: OnboardControl) {
    const { players: list } = await players();
    if (!list.length) return { players: 0 };
    const all = (q: string, vars: Record<string, unknown> = {}) => Promise.all(list.map((p) => gql(q, { id: p.id, ...vars })));
    switch (c.action) {
      case 'sync': {
        // everything follows the main broadcast if there is one, otherwise the first window
        const lead = list.find((p) => p.title && MAIN_FEEDS.includes(p.title.toUpperCase() as MainFeedTitle)) ?? list[0];
        await gql(M_SYNC, { id: lead.id });
        break;
      }
      case 'play':
      case 'pause':
        await all(M_PAUSE, { paused: c.action === 'pause' });
        break;
      case 'mute':
      case 'unmute':
        await all(M_MUTE, { muted: c.action === 'mute' });
        break;
      case 'seek':
        await all(M_SEEK, { absolute: c.seconds });
        break;
      case 'close':
        await all(M_DELETE);
        break;
    }
    return { players: list.length };
  }

  /** handles /api/onboard/*; false when the url isn't one of ours */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/onboard/')) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return true;
    };
    const route = url.pathname.slice('/api/onboard/'.length);
    const write = req.method === 'POST';
    try {
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

      const blocked = guard(req, deps.allowRemote, write);
      if (blocked) {
        if (route === 'status' && blocked.status === 403) {
          return send(200, { available: false, version: null, players: [], remoteBlocked: true, error: blocked.message } satisfies OnboardStatus);
        }
        throw blocked;
      }

      if (route === 'status' && !write) return send(200, await status());

      const m = /^session\/(\d{1,9})$/.exec(route);
      if (m && !write) {
        const mk = url.searchParams.get('meeting');
        if (mk !== null && !/^\d{1,9}$/.test(mk)) throw new HttpError(400, 'meeting must be a number');
        const data = await session(Number(m[1]), mk ? Number(mk) : null);
        if (!data) throw new HttpError(404, "This session isn't on F1 TV (yet), or MultiViewer has no video for it");
        return send(200, data);
      }

      if (route === 'open' && write) return send(200, await open(parseOpenRequest(await readJson(req))));
      if (route === 'control' && write) return send(200, await control(parseControl(await readJson(req))));

      throw new HttpError(404, 'not found');
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('[onboard]', err);
      const e = err instanceof HttpError ? err : new HttpError(502, err instanceof Error ? err.message : String(err));
      if (e.status === 413) res.setHeader('Connection', 'close');
      return send(e.status, { error: e.message });
    }
  }

  return { handle, status, session, open, control };
}

/**
 * finds the f1 tv video for a session in MultiViewer's meeting data. e.g. the
 * 2026 las vegas race is session 11420 -> content 1000010442, the session
 * starts 533.509 s into the video, at 2026-11-22T04:03:53.989Z.
 */
export function pickSession(body: any, sessionKey: number): OnboardSession | null {
  const list: any[] = Array.isArray(body?.sessions) ? body.sessions : [];
  const s = list.find((x) => isObj(x) && String(x.session_key) === String(sessionKey));
  if (!s) return null;
  let contentId: string;
  try {
    contentId = parseContentId(s.f1tv_content_id);
  } catch {
    return null;
  }
  const videoStart = Number.parseFloat(s.session_start);
  const wallStart = typeof s.session_start_pdt === 'string' ? Date.parse(s.session_start_pdt) : NaN;
  const ok = Number.isFinite(videoStart) && Number.isFinite(wallStart);
  return {
    contentId,
    title: str(s.title) ?? `Session ${sessionKey}`,
    videoStart: ok ? videoStart : null,
    wallStart: ok ? wallStart : null,
  };
}
