import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { tileLayout } from '../../shared/onboardLayout.ts';
import type { Rect } from '../../shared/types.ts';
import { createOnboard, guard, isLoopbackAddress, parseControl, parseOpenRequest, pickSession } from './onboard.ts';

// ---------- layout ----------

const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('tileLayout', () => {
  test('one feed fills a 16:9 screen', () => {
    assert.deepEqual(tileLayout(1, SCREEN), [{ x: 0, y: 0, width: 1920, height: 1080 }]);
  });

  test('20 cars on 1080p -> 5x4 of 384x216', () => {
    const r = tileLayout(20, SCREEN);
    assert.equal(r.length, 20);
    assert.ok(r.every((t) => t.width === 384 && t.height === 216));
    assert.equal(new Set(r.map((t) => t.x)).size, 5);
    assert.equal(new Set(r.map((t) => t.y)).size, 4);
  });

  for (const n of [2, 3, 5, 7, 11, 13, 20, 22, 24]) {
    for (const layout of ['grid', 'feature'] as const) {
      test(`${n} feeds (${layout}) stay on screen, keep 16:9 and never overlap`, () => {
        const area = { x: -1920, y: 40, width: 2560, height: 1400 }; // left-hand second monitor
        const r = tileLayout(n, area, layout);
        assert.equal(r.length, n);
        for (const t of r) {
          assert.ok(inside(t, area), `${JSON.stringify(t)} off screen`);
          assert.ok(Math.abs(t.width / t.height - 16 / 9) < 0.02, 'aspect ratio');
        }
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) assert.ok(!overlaps(r[i], r[j]), `${i} overlaps ${j}`);
      });
    }
  }

  test('feature layout makes the first tile twice the size of the rest', () => {
    const [main, ...rest] = tileLayout(13, SCREEN, 'feature');
    assert.equal(main.width, rest[0].width * 2);
    assert.equal(main.height, rest[0].height * 2);
  });

  test('a short last row is centred', () => {
    const r = tileLayout(5, SCREEN); // 3 + 2
    const last = r.slice(3);
    const left = last[0].x;
    const right = SCREEN.width - (last[1].x + last[1].width);
    assert.ok(Math.abs(left - right) <= 1);
  });

  test('nothing to tile, or no space', () => {
    assert.deepEqual(tileLayout(0, SCREEN), []);
    assert.deepEqual(tileLayout(4, { x: 0, y: 0, width: 0, height: 900 }), []);
  });
});

// ---------- validation ----------

const okReq = { contentId: '1000010442', feeds: [{ kind: 'driver', num: 1 }], layout: 'grid' };

describe('parseOpenRequest', () => {
  test('accepts a normal grid request', () => {
    const r = parseOpenRequest({
      ...okReq,
      feeds: [{ kind: 'main', title: 'F1 LIVE' }, { kind: 'driver', num: 44 }],
      area: { x: 0, y: 0, width: 1920, height: 1080 },
      replace: true,
    });
    assert.equal(r.feeds.length, 2);
    assert.equal(r.replace, true);
    assert.deepEqual(r.area, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  test('numeric content ids are accepted and turned into strings', () => {
    assert.equal(parseOpenRequest({ ...okReq, contentId: 1000010442 }).contentId, '1000010442');
  });

  const bad: [string, unknown][] = [
    ['not an object', 'hello'],
    ['array body', [okReq]],
    ['graphql injection in content id', { ...okReq, contentId: '1") { playerDelete(id: "1") }' }],
    ['content id with letters', { ...okReq, contentId: 'abc' }],
    ['huge content id', { ...okReq, contentId: '9'.repeat(40) }],
    ['no feeds', { ...okReq, feeds: [] }],
    ['too many feeds', { ...okReq, feeds: Array.from({ length: 25 }, (_, i) => ({ kind: 'driver', num: i + 1 })) }],
    ['duplicate feed', { ...okReq, feeds: [{ kind: 'driver', num: 1 }, { kind: 'driver', num: 1 }] }],
    ['car number 0', { ...okReq, feeds: [{ kind: 'driver', num: 0 }] }],
    ['car number 100', { ...okReq, feeds: [{ kind: 'driver', num: 100 }] }],
    ['car number as string', { ...okReq, feeds: [{ kind: 'driver', num: '1' }] }],
    ['fractional car number', { ...okReq, feeds: [{ kind: 'driver', num: 1.5 }] }],
    ['unknown main feed', { ...okReq, feeds: [{ kind: 'main', title: 'PIRATE STREAM' }] }],
    ['unknown feed kind', { ...okReq, feeds: [{ kind: 'url', url: 'http://evil' }] }],
    ['prototype pollution', JSON.parse('{"__proto__":{"admin":true},"contentId":"1","feeds":[{"kind":"driver","num":1,"__proto__":{"x":1}}],"layout":"weird"}')],
    ['bad layout', { ...okReq, layout: 'mosaic' }],
    ['NaN area', { ...okReq, area: { x: 0, y: 0, width: NaN, height: 1080 } }],
    ['tiny area', { ...okReq, area: { x: 0, y: 0, width: 10, height: 10 } }],
    ['absurd area', { ...okReq, area: { x: 0, y: 0, width: 1e9, height: 1080 } }],
    ['string area', { ...okReq, area: '0,0,1920,1080' }],
  ];
  for (const [name, body] of bad) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parseOpenRequest(body), (e: any) => e.status === 400);
    });
  }
  test('rejects prototype pollution without polluting', () => {
    assert.equal(({} as any).admin, undefined);
  });
});

describe('parseControl', () => {
  test('accepts the known actions', () => {
    for (const a of ['sync', 'play', 'pause', 'mute', 'unmute', 'close']) assert.deepEqual(parseControl({ action: a }), { action: a });
    assert.deepEqual(parseControl({ action: 'seek', seconds: 533.5 }), { action: 'seek', seconds: 533.5 });
  });
  for (const body of [{ action: 'delete-everything' }, { action: 'seek' }, { action: 'seek', seconds: -1 }, { action: 'seek', seconds: Infinity }, { action: 'seek', seconds: '10' }, null, 'sync']) {
    test(`rejects ${JSON.stringify(body)}`, () => {
      assert.throws(() => parseControl(body), (e: any) => e.status === 400);
    });
  }
});

describe('pickSession', () => {
  // trimmed from the real api.multiviewer.app/api/v1/meetings/1300 reply
  const meeting = {
    sessions: [
      { session_key: '11420001', title: 'Pre-Race Show', f1tv_content_id: '1000010440', session_start: null, session_start_pdt: null },
      { session_key: '11420', title: '2026 Las Vegas GP - Race', f1tv_content_id: '1000010442', session_start: '533.509', session_start_pdt: '2026-11-22T04:03:53.989Z' },
      { session_key: '11416', title: 'Qualifying', f1tv_content_id: '1000010439', session_start: null, session_start_pdt: null },
      { session_key: '99', title: 'evil', f1tv_content_id: '1); drop', session_start: '1', session_start_pdt: '2026-01-01T00:00:00Z' },
    ],
  };
  test('matches the session key exactly, not the pre-race show', () => {
    assert.deepEqual(pickSession(meeting, 11420), {
      contentId: '1000010442',
      title: '2026 Las Vegas GP - Race',
      videoStart: 533.509,
      wallStart: Date.parse('2026-11-22T04:03:53.989Z'),
    });
  });
  test('no sync anchor when MultiViewer has no offsets yet', () => {
    const s = pickSession(meeting, 11416)!;
    assert.equal(s.videoStart, null);
    assert.equal(s.wallStart, null);
  });
  test('unknown session, junk content id or junk body -> null', () => {
    assert.equal(pickSession(meeting, 1), null);
    assert.equal(pickSession(meeting, 99), null);
    assert.equal(pickSession({ sessions: 'nope' }, 11420), null);
    assert.equal(pickSession(null, 11420), null);
  });
});

// ---------- request guard ----------

const fakeReq = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
  ({ headers, socket: { remoteAddress } }) as unknown as http.IncomingMessage;
const JSON_HDRS = { host: 'localhost:8787', 'content-type': 'application/json' };

describe('guard', () => {
  test('loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.8.9.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(a), a);
    for (const a of ['192.168.1.20', '100.64.0.7', '::ffff:10.0.0.1', '1270.0.0.1', '', undefined]) assert.ok(!isLoopbackAddress(a), String(a));
  });
  test('same-machine POST from the app is allowed', () => {
    assert.equal(guard(fakeReq({ ...JSON_HDRS, origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin' }), false, true), null);
  });
  test('vite dev proxy (origin and host both :5173) is allowed', () => {
    assert.equal(guard(fakeReq({ host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' }), false, true), null);
  });
  test('another device on the network is blocked by default', () => {
    assert.equal(guard(fakeReq({ ...JSON_HDRS, host: '192.168.1.10:8787' }, '192.168.1.20'), false, true)?.status, 403);
  });
  test('...and allowed with PITWALL_REMOTE_CONTROL', () => {
    assert.equal(guard(fakeReq({ ...JSON_HDRS, host: 'bowermanhome:8787', origin: 'http://bowermanhome:8787' }, '100.64.0.7'), true, true), null);
  });
  test('DNS rebinding (evil host name pointing at 127.0.0.1) is blocked', () => {
    assert.equal(guard(fakeReq({ ...JSON_HDRS, host: 'evil.example:8787', origin: 'http://evil.example:8787' }), false, true)?.status, 403);
  });
  test('cross-site POST from another website is blocked', () => {
    assert.equal(guard(fakeReq({ ...JSON_HDRS, origin: 'https://evil.example' }), false, true)?.status, 403);
    assert.equal(guard(fakeReq({ ...JSON_HDRS, origin: 'https://evil.example', host: 'h:1', 'sec-fetch-site': 'cross-site' }), true, true)?.status, 403);
    assert.equal(guard(fakeReq({ ...JSON_HDRS, origin: 'null' }), false, true)?.status, 403);
  });
  test('form posts (no preflight) are refused by content type', () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      assert.equal(guard(fakeReq({ host: 'localhost:8787', 'content-type': ct }), false, true)?.status, 415, ct);
    }
  });
});

// ---------- end to end against a fake MultiViewer ----------

interface Call {
  op: string;
  variables: any;
}

describe('onboard routes', () => {
  let mv: http.Server;
  let app: http.Server;
  let base = '';
  let calls: Call[] = [];
  let mvPlayers: any[] = [];
  let nextId = 1;
  let rejectDriver: number | null = null;

  const mvHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?';
      calls.push({ op, variables });
      const reply = (data: unknown, errors?: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errors ? { errors } : { data }));
      };
      if (op === 'PitwallStatus') return reply({ version: '2.9.0', players: mvPlayers });
      if (op === 'PitwallCreate') {
        if (variables.input.driverNumber === rejectDriver) return reply(null, [{ message: 'No onboard for driver' }]);
        const id = String(nextId++);
        mvPlayers.push({ id, streamData: { contentId: variables.input.contentId, title: variables.input.streamTitle ?? 'OBC' }, driverData: null });
        return reply({ playerCreate: id });
      }
      if (op === 'PitwallDelete') {
        mvPlayers = mvPlayers.filter((p) => p.id !== variables.id);
        return reply({ playerDelete: true });
      }
      return reply({ ok: true });
    });
  };

  const meta = {
    sessions: [{ session_key: '11420', title: 'Race', f1tv_content_id: '1000010442', session_start: '533.509', session_start_pdt: '2026-11-22T04:03:53.989Z' }],
  };
  let metaHits = 0;
  let lookups = 0;

  before(async () => {
    mv = http.createServer(mvHandler).listen(0, '127.0.0.1');
    await new Promise((r) => mv.once('listening', r));
    const mvPort = (mv.address() as AddressInfo).port;
    const realFetch = fetch;
    const onboard = createOnboard({
      mvUrl: `http://127.0.0.1:${mvPort}/api/graphql`,
      metaBase: 'https://meta.test',
      allowRemote: false,
      createGapMs: 0,
      lookupMeeting: async () => (lookups++, 1300),
      // meta api is faked, everything else is real http to the fake MultiViewer
      fetch: (async (url: any, init: any) => {
        if (String(url).startsWith('https://meta.test/')) {
          metaHits++;
          return new Response(String(url).endsWith('/1300') ? JSON.stringify(meta) : '{}', { status: 200 });
        }
        return realFetch(url, init);
      }) as typeof fetch,
    });
    app = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (!(await onboard.handle(req, res, url))) res.writeHead(404).end();
    });
    app.listen(0, '127.0.0.1');
    await new Promise((r) => app.once('listening', r));
    base = `http://localhost:${(app.address() as AddressInfo).port}`;
  });
  after(() => {
    mv.close();
    app.close();
  });
  beforeEach(() => {
    calls = [];
    mvPlayers = [];
    nextId = 1;
    rejectDriver = null;
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('status reports MultiViewer and its windows', async () => {
    mvPlayers = [{ id: '7', streamData: { contentId: '1000010442', title: 'F1 LIVE' }, driverData: { driverNumber: '1', tla: 'VER' } }];
    const s = await (await fetch(base + '/api/onboard/status')).json();
    assert.equal(s.available, true);
    assert.equal(s.version, '2.9.0');
    assert.deepEqual(s.players, [{ id: '7', title: 'F1 LIVE', driverNumber: 1, tla: 'VER', contentId: '1000010442' }]);
  });

  test('opens a feature grid with the main feed first and real window bounds', async () => {
    const res = await post('/api/onboard/open', {
      contentId: '1000010442',
      feeds: [{ kind: 'main', title: 'F1 LIVE' }, { kind: 'driver', num: 1 }, { kind: 'driver', num: 44 }, { kind: 'driver', num: 16 }],
      area: { x: 0, y: 0, width: 1920, height: 1080 },
      layout: 'feature',
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(out, { opened: ['1', '2', '3', '4'], failed: [] });
    const creates = calls.filter((c) => c.op === 'PitwallCreate').map((c) => c.variables.input);
    assert.equal(creates[0].streamTitle, 'F1 LIVE');
    assert.deepEqual(creates.slice(1).map((c) => c.driverNumber), [1, 44, 16]);
    assert.ok(creates.every((c) => c.contentId === '1000010442' && c.maintainAspectRatio === true));
    assert.deepEqual(creates.map((c) => c.bounds), tileLayout(4, { x: 0, y: 0, width: 1920, height: 1080 }, 'feature'));
  });

  test('replace closes the old windows first', async () => {
    mvPlayers = [{ id: 'old1' }, { id: 'old2' }];
    nextId = 10;
    await post('/api/onboard/open', { contentId: '1', feeds: [{ kind: 'driver', num: 4 }], replace: true });
    const ops = calls.map((c) => c.op);
    assert.deepEqual(ops.slice(0, 3).sort(), ['PitwallDelete', 'PitwallDelete', 'PitwallStatus'].sort());
    assert.equal(ops.at(-1), 'PitwallCreate');
    assert.equal(calls.at(-1)!.variables.input.bounds, undefined, 'no area -> MultiViewer places it');
  });

  test('one missing onboard does not stop the rest', async () => {
    rejectDriver = 44;
    const out = await (await post('/api/onboard/open', { contentId: '1', feeds: [1, 44, 16].map((num) => ({ kind: 'driver', num })) })).json();
    assert.deepEqual(out.opened, ['1', '2']);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].feed.num, 44);
    assert.match(out.failed[0].error, /No onboard/);
  });

  test('controls go to every window, sync goes to the main feed', async () => {
    mvPlayers = [
      { id: 'a', streamData: { title: 'OBC' } },
      { id: 'b', streamData: { title: 'F1 LIVE' } },
    ];
    await post('/api/onboard/control', { action: 'sync' });
    assert.deepEqual(calls.filter((c) => c.op === 'PitwallSync').map((c) => c.variables.id), ['b']);

    calls = [];
    await post('/api/onboard/control', { action: 'seek', seconds: 1200.5 });
    assert.deepEqual(calls.filter((c) => c.op === 'PitwallSeek').map((c) => c.variables), [{ id: 'a', absolute: 1200.5 }, { id: 'b', absolute: 1200.5 }]);

    calls = [];
    await post('/api/onboard/control', { action: 'pause' });
    assert.ok(calls.filter((c) => c.op === 'PitwallPause').every((c) => c.variables.paused === true));
  });

  test('session lookup finds the content id and caches it', async () => {
    metaHits = 0;
    lookups = 0;
    const s = await (await fetch(base + '/api/onboard/session/11420')).json();
    assert.equal(s.contentId, '1000010442');
    assert.equal(s.videoStart, 533.509);
    await fetch(base + '/api/onboard/session/11420');
    assert.equal(metaHits, 1, 'second call served from cache');
    assert.equal(lookups, 1, 'meeting key looked up when not given');
    await fetch(base + '/api/onboard/session/11420?meeting=1300');
    assert.equal(lookups, 1, 'meeting key given -> no lookup');
    assert.equal((await fetch(base + '/api/onboard/session/12345?meeting=1300')).status, 404);
  });

  // ---------- attacks against the routes ----------

  test('rejects a cross-site POST before touching MultiViewer', async () => {
    const res = await post('/api/onboard/control', { action: 'close' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  test('rejects a no-preflight form post', async () => {
    const res = await fetch(base + '/api/onboard/control', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"action":"close"}' });
    assert.equal(res.status, 415);
    assert.equal(calls.length, 0);
  });

  test('rejects a rebinding host header', async () => {
    const res = await new Promise<number>((resolve) => {
      const r = http.request(base + '/api/onboard/control', { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (x) => resolve(x.statusCode!));
      r.end('{"action":"close"}');
    });
    assert.equal(res, 403);
    assert.equal(calls.length, 0);
  });

  test('status from a blocked client says so instead of erroring', async () => {
    const res = await new Promise<any>((resolve) => {
      http.get(base + '/api/onboard/status', { headers: { Host: 'evil.example' } }, (x) => {
        let b = '';
        x.on('data', (c) => (b += c));
        x.on('end', () => resolve(JSON.parse(b)));
      });
    });
    assert.equal(res.remoteBlocked, true);
    assert.equal(res.available, false);
  });

  test('oversized and malformed bodies are refused', async () => {
    assert.equal((await post('/api/onboard/open', 'x'.repeat(64 * 1024))).status, 413);
    assert.equal((await post('/api/onboard/open', '{"contentId":')).status, 400);
    assert.equal(calls.length, 0);
  });

  test('injection attempts never reach MultiViewer as query text', async () => {
    await post('/api/onboard/open', { contentId: '1"}){playerDelete(id:"1")}#', feeds: [{ kind: 'driver', num: 1 }] });
    await post('/api/onboard/open', { contentId: '1', feeds: [{ kind: 'main', title: 'F1 LIVE") { x' }] });
    assert.equal(calls.length, 0);
  });

  test('bad paths, methods and keys', async () => {
    assert.equal((await fetch(base + '/api/onboard/session/abc')).status, 404);
    assert.equal((await fetch(base + '/api/onboard/session/11420?meeting=1300;drop')).status, 400);
    assert.equal((await fetch(base + '/api/onboard/open')).status, 404, 'GET on a POST route');
    assert.equal((await fetch(base + '/api/onboard/status', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(base + '/api/onboard/../replay/1')).status, 404);
  });

  test('MultiViewer closed -> status says so, open gives a clear 503', async () => {
    const dead = createOnboard({ mvUrl: 'http://127.0.0.1:9/api/graphql', metaBase: 'https://meta.test', allowRemote: false, lookupMeeting: async () => null });
    const s = await dead.status();
    assert.equal(s.available, false);
    assert.match(s.error!, /MultiViewer isn't reachable/);
    await assert.rejects(dead.open(parseOpenRequest(okReq)), (e: any) => e.status === 503);
  });
});
