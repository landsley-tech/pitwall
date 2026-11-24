// Small OpenF1 client: one request at a time, polite spacing, retries on 429,
// and an on-disk cache for sessions that have already finished.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './paths.ts';

const BASE = 'https://api.openf1.org/v1';
const MIN_GAP_MS = 700;
const MAX_ATTEMPTS = 6;

let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildUrl(endpoint: string, params: Record<string, string | number>): string {
  // OpenF1 filters use operators inside the key (date>=...), so build the query by hand.
  const q = Object.entries(params)
    .map(([k, v]) => {
      const m = /^(.*?)(>=|<=|>|<)?$/.exec(k)!;
      return `${encodeURIComponent(m[1])}${m[2] ?? '='}${encodeURIComponent(String(v))}`;
    })
    .join('&');
  return `${BASE}/${endpoint}${q ? `?${q}` : ''}`;
}

async function rawFetch(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 404) return []; // OpenF1 uses 404 for "no rows"
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`OpenF1 ${res.status} for ${url}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`OpenF1 ${res.status} for ${url}`);
    return res.json();
  }
}

/** Fetch an OpenF1 endpoint. `cache` should only be true for finished sessions. */
export function openf1<T = any>(
  endpoint: string,
  params: Record<string, string | number> = {},
  cache = false,
): Promise<T[]> {
  const url = buildUrl(endpoint, params);
  const run = async () => {
    const file = path.join(CACHE_DIR, 'openf1', createHash('sha1').update(url).digest('hex') + '.json');
    if (cache) {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as T[];
      } catch {
        /* not cached yet */
      }
    }
    const data = (await rawFetch(url)) as T[];
    if (!Array.isArray(data)) throw new Error(`Unexpected OpenF1 response for ${url}`);
    if (cache) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    }
    return data;
  };
  // Serialise every request so we stay inside the free rate limit.
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
