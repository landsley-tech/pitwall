// Pitwall server: JSON API for sessions and replays, a WebSocket for live
// timing, and the built web app.
import './env.ts';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { getCircuit } from './circuit.ts';
import { LiveFeed } from './live.ts';
import { createOnboard } from './onboard.ts';
import { openf1 } from './openf1.ts';
import { WEB_DIST } from './paths.ts';
import { getReplay, sessionMetaFrom } from './replay.ts';

const PORT = Number(process.env.PORT ?? 8787);
const live = new LiveFeed();

// onboard cameras through the MultiViewer desktop app (see README "Onboard cameras")
const onboard = createOnboard({
  mvUrl: process.env.MULTIVIEWER_URL ?? 'http://localhost:10101/api/graphql',
  metaBase: 'https://api.multiviewer.app',
  allowRemote: process.env.PITWALL_REMOTE_CONTROL === '1',
  lookupMeeting: async (sessionKey) => {
    const [s] = await openf1('sessions', { session_key: sessionKey });
    return Number(s?.meeting_key) || null;
  },
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const sessionsCache = new Map<number, { at: number; data: unknown }>();

async function listSessions(year: number) {
  const hit = sessionsCache.get(year);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const [sessions, meetings] = await Promise.all([openf1('sessions', { year }), openf1('meetings', { year })]);
  const names = new Map(meetings.map((m: any) => [m.meeting_key, m.meeting_name]));
  const data = sessions
    .filter((s: any) => !s.is_cancelled)
    .map((s: any) => sessionMetaFrom(s, names.get(s.meeting_key)))
    .filter((s) => !/testing/i.test(s.meeting))
    .sort((a, b) => Date.parse(a.dateStart) - Date.parse(b.dateStart));
  sessionsCache.set(year, { at: Date.now(), data });
  return data;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = path.normalize(path.join(WEB_DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(WEB_DIST)) return json(res, 403, { error: 'forbidden' });
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(WEB_DIST, 'index.html'); // SPA fallback
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Web app not built. Run "npm run build" first, or use "npm run dev".');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/api/sessions') {
      const year = Number(url.searchParams.get('year')) || new Date().getUTCFullYear();
      return json(res, 200, await listSessions(year));
    }

    let m = /^\/api\/replay\/(\d+)$/.exec(url.pathname);
    if (m) {
      const r = await getReplay(Number(m[1]));
      if ('status' in r) return json(res, r.status.state === 'error' ? 500 : 202, r.status);
      const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
      if (!acceptsGzip) {
        const { gunzipSync } = await import('node:zlib');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(gunzipSync(r.gz));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      return res.end(r.gz);
    }

    m = /^\/api\/circuit\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (m) return json(res, 200, await getCircuit(Number(m[1]), Number(m[2])));

    if (await onboard.handle(req, res, url)) return;

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws/live' });
wss.on('connection', (socket) => {
  const off = live.subscribe((msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  });
  socket.on('close', off);
});

server.listen(PORT, () => {
  console.log(`Pitwall server on http://localhost:${PORT}`);
  onboard.status().then((s) =>
    console.log(s.available ? `MultiViewer ${s.version ?? ''} found, onboard cameras ready` : 'MultiViewer not running, onboard cameras off until it is'),
  );
});
