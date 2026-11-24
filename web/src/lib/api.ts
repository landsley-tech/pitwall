import type { BuildStatus, ReplayData, SessionMeta, TrackInfo } from '@shared/types';

export async function fetchSessions(year: number): Promise<SessionMeta[]> {
  const res = await fetch(`/api/sessions?year=${year}`);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json();
}

export async function fetchCircuit(circuitKey: number, year: number): Promise<TrackInfo | null> {
  const res = await fetch(`/api/circuit/${circuitKey}/${year}`);
  return res.ok ? res.json() : null;
}

/** Polls until the replay is built, reporting progress along the way. */
export async function loadReplay(
  key: number,
  onProgress: (s: BuildStatus) => void,
  signal: AbortSignal,
): Promise<ReplayData> {
  for (;;) {
    const res = await fetch(`/api/replay/${key}`, { signal });
    if (res.status === 200) {
      onProgress({ state: 'ready', progress: 1, message: 'Opening replay' });
      return res.json();
    }
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    if (res.status !== 202) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    onProgress(body as BuildStatus);
    await new Promise((r) => setTimeout(r, 1000));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}
