import { useEffect, useMemo, useState } from 'react';
import { tileLayout } from '@shared/onboardLayout';
import { MAIN_FEEDS, type DriverInfo, type DriverRow, type MainFeedTitle, type OnboardFeed, type OnboardLayout } from '@shared/types';
import { screenArea, type Toast, type useOnboard } from '../lib/onboard';

type Onboard = ReturnType<typeof useOnboard>;

interface Props {
  open: boolean;
  onClose: () => void;
  mode: 'replay' | 'live';
  drivers: DriverInfo[];
  rows: DriverRow[];
  selected: string | null;
  onboard: Onboard;
  follow: boolean;
  onFollow: (v: boolean) => void;
  followActive: boolean;
}

const README = 'https://github.com/landsley-tech/pitwall#onboard-cameras';

// remembered per browser, it's only a convenience
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`pitwall.onboard.${key}`);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(`pitwall.onboard.${key}`, JSON.stringify(v));
  } catch {
    /* private mode etc */
  }
}

export function OnboardDrawer(p: Props) {
  const { status, video, videoError, busy } = p.onboard;
  const byNum = useMemo(() => new Map(p.drivers.map((d) => [d.num, d])), [p.drivers]);
  // running order, with drivers the timing doesn't know about yet at the end
  const order = useMemo(() => {
    const seen = new Set(p.rows.map((r) => r.num));
    return [...p.rows.map((r) => r.num), ...p.drivers.map((d) => d.num).filter((n) => !seen.has(n))].filter((n) => byNum.has(n));
  }, [p.rows, p.drivers, byNum]);
  const rowOf = useMemo(() => new Map(p.rows.map((r) => [r.num, r])), [p.rows]);

  const [picked, setPicked] = useState<Set<string> | null>(null); // null = everyone still running
  const [withMain, setWithMain] = useState(() => load('withMain', true));
  const [mainTitle, setMainTitle] = useState<MainFeedTitle>(() => load('mainTitle', 'F1 LIVE'));
  const [layout, setLayout] = useState<OnboardLayout>(() => load('layout', 'feature'));
  const [replace, setReplace] = useState(() => load('replace', true));
  useEffect(() => save('withMain', withMain), [withMain]);
  useEffect(() => save('mainTitle', mainTitle), [mainTitle]);
  useEffect(() => save('layout', layout), [layout]);
  useEffect(() => save('replace', replace), [replace]);

  const running = order.filter((n) => !rowOf.get(n)?.out);
  const chosen = picked ? order.filter((n) => picked.has(n)) : running;
  const feeds: OnboardFeed[] = [
    ...(withMain ? [{ kind: 'main' as const, title: mainTitle }] : []),
    ...chosen.map((n) => ({ kind: 'driver' as const, num: Number(n) })),
  ];
  const effLayout: OnboardLayout = withMain ? layout : 'grid';

  const toggle = (num: string) => {
    const s = new Set(picked ?? running);
    if (s.has(num)) s.delete(num);
    else s.add(num);
    setPicked(s);
  };
  const pickTop = (n: number) => setPicked(new Set(running.slice(0, n)));
  const pickAround = () => {
    if (!p.selected) return;
    const i = running.indexOf(p.selected);
    setPicked(new Set(running.slice(Math.max(0, i - 2), i + 3)));
  };

  // live preview of where the windows will go, same maths as the server
  const area = useMemo(() => (p.open ? screenArea() : { x: 0, y: 0, width: 1920, height: 1080 }), [p.open]);
  const tiles = tileLayout(feeds.length, area, effLayout);

  const players = status?.players ?? [];
  const ready = !!status?.available && !!video;

  return (
    <>
      <div className={`drawer-scrim${p.open ? ' on' : ''}`} onClick={p.onClose} aria-hidden="true" />
      <aside className={`drawer${p.open ? ' on' : ''}`} aria-label="Onboard cameras" aria-hidden={!p.open} inert={!p.open}>
        <header className="drawer-head">
          <div>
            <h2>
              <CamIcon /> Onboard cameras
            </h2>
            <p className="muted small">Every car's onboard through MultiViewer and your F1 TV subscription.</p>
          </div>
          <button className="icon-btn" onClick={p.onClose} aria-label="Close onboard cameras">
            ×
          </button>
        </header>

        <div className="drawer-body">
          <ConnectionCard status={status} video={video} videoError={videoError} onRetry={p.onboard.refresh} />

          {status?.available && (
            <>
              <section className="ob-section">
                <div className="ob-section-head">
                  <span className="label">Cars · {chosen.length} of {order.length}</span>
                  <div className="ob-quick">
                    <button onClick={() => setPicked(null)}>All</button>
                    <button onClick={() => pickTop(10)}>Top 10</button>
                    <button onClick={() => pickTop(5)}>Top 5</button>
                    <button onClick={pickAround} disabled={!p.selected} title={p.selected ? 'The selected car and two either side' : 'Select a car first'}>
                      Battle
                    </button>
                    <button onClick={() => setPicked(new Set())}>None</button>
                  </div>
                </div>
                <div className="ob-cars">
                  {order.map((num, i) => {
                    const d = byNum.get(num)!;
                    const r = rowOf.get(num);
                    const on = chosen.includes(num);
                    return (
                      <button
                        key={num}
                        className={`ob-car${on ? ' on' : ''}${r?.out ? ' out' : ''}`}
                        style={{ ['--team' as string]: d.colour, ['--i' as string]: i }}
                        onClick={() => toggle(num)}
                        aria-pressed={on}
                        title={`${d.name} · ${d.team}`}
                      >
                        <span className="ob-pos mono">{r?.out ? '—' : r?.position ?? ''}</span>
                        <span className="ob-code">{d.code}</span>
                        <span className="ob-num mono">{num}</span>
                        <span className="ob-check" aria-hidden="true">
                          <svg viewBox="0 0 16 16" width="10" height="10">
                            <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="ob-section">
                <span className="label">Layout</span>
                <div className="ob-row">
                  <label className="switch">
                    <input type="checkbox" checked={withMain} onChange={(e) => setWithMain(e.target.checked)} />
                    <span className="switch-track" />
                    Main feed
                  </label>
                  <select value={mainTitle} onChange={(e) => setMainTitle(e.target.value as MainFeedTitle)} disabled={!withMain} className="ob-select">
                    {MAIN_FEEDS.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <div className="seg" role="group" aria-label="Layout">
                    <button className={effLayout === 'feature' ? 'active' : ''} disabled={!withMain} onClick={() => setLayout('feature')}>
                      Feature
                    </button>
                    <button className={effLayout === 'grid' ? 'active' : ''} onClick={() => setLayout('grid')}>
                      Grid
                    </button>
                  </div>
                </div>

                <div className="ob-preview" style={{ aspectRatio: `${area.width} / ${area.height}` }}>
                  {tiles.map((t, i) => {
                    const f = feeds[i];
                    const d = f.kind === 'driver' ? byNum.get(String(f.num)) : null;
                    const key = f.kind === 'driver' ? `d${f.num}` : 'main';
                    return (
                      <span
                        key={key}
                        className={`ob-tile${f.kind === 'main' ? ' main' : ''}`}
                        style={{
                          left: `${((t.x - area.x) / area.width) * 100}%`,
                          top: `${((t.y - area.y) / area.height) * 100}%`,
                          width: `${(t.width / area.width) * 100}%`,
                          height: `${(t.height / area.height) * 100}%`,
                          ['--team' as string]: d?.colour ?? 'var(--accent)',
                        }}
                      >
                        <span>{f.kind === 'main' ? f.title : d?.code}</span>
                      </span>
                    );
                  })}
                  {!tiles.length && <span className="ob-preview-empty muted small">Pick some cars</span>}
                </div>
                <p className="muted small ob-hint">
                  Tiles the screen this window is on ({area.width}×{area.height}). Drag pitwall to another monitor to tile that one.
                </p>
                <label className="check small">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Close MultiViewer's open windows first
                </label>
              </section>

              <button
                className="btn primary ob-go"
                disabled={!ready || busy || !feeds.length}
                onClick={() => p.onboard.open(feeds, { layout: effLayout, tile: true, replace })}
              >
                {busy ? <span className="spinner" /> : <GridIcon />}
                {busy ? 'Opening…' : `Open ${feeds.length} feed${feeds.length === 1 ? '' : 's'}`}
              </button>

              <section className="ob-section">
                <div className="ob-section-head">
                  <span className="label">Open windows · {players.length}</span>
                </div>
                {p.mode === 'replay' && (
                  <label className="switch">
                    <input type="checkbox" checked={p.follow} onChange={(e) => p.onFollow(e.target.checked)} disabled={video?.videoStart == null} />
                    <span className="switch-track" />
                    Follow the replay
                    <span className={`follow-state small${p.followActive ? ' on' : ''}`}>
                      {video?.videoStart == null ? 'no sync data for this session' : p.followActive ? 'in step at 1×, waits at other speeds' : 'off'}
                    </span>
                  </label>
                )}
                <div className="ob-controls">
                  <button className="btn" disabled={!players.length} onClick={() => p.onboard.control({ action: 'sync' })} title="Line every window up with the main feed">
                    Sync
                  </button>
                  <button className="btn" disabled={!players.length} onClick={() => p.onboard.control({ action: 'pause' })}>
                    Pause
                  </button>
                  <button className="btn" disabled={!players.length} onClick={() => p.onboard.control({ action: 'play' })}>
                    Play
                  </button>
                  <button className="btn" disabled={!players.length} onClick={() => p.onboard.control({ action: 'mute' })}>
                    Mute all
                  </button>
                  <button className="btn danger" disabled={!players.length} onClick={() => p.onboard.control({ action: 'close' })}>
                    Close all
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
        <footer className="drawer-foot muted small">
          Video plays in MultiViewer with your own F1 TV account. Pitwall only arranges the windows.{' '}
          <a href={README} target="_blank" rel="noreferrer">
            Setup guide
          </a>
        </footer>
      </aside>
    </>
  );
}

function ConnectionCard({
  status,
  video,
  videoError,
  onRetry,
}: Pick<Onboard, 'status' | 'video' | 'videoError'> & { onRetry: () => void }) {
  if (!status) return <div className="ob-conn skeleton" />;
  if (status.remoteBlocked) {
    return (
      <div className="ob-conn warn">
        <strong>Only works on the machine running pitwall</strong>
        <p className="small">Onboard windows open on the computer running MultiViewer, so control from other devices is off. Start the server with <code>PITWALL_REMOTE_CONTROL=1</code> to allow it.</p>
      </div>
    );
  }
  if (!status.available) {
    return (
      <div className="ob-conn off">
        <strong>MultiViewer isn't running</strong>
        <ol className="ob-steps small">
          <li>
            Install <a href="https://multiviewer.app/download" target="_blank" rel="noreferrer">MultiViewer</a> (free, Windows, macOS and Linux).
          </li>
          <li>Sign in with an F1 TV Pro or Premium account.</li>
          <li>Leave it open. Pitwall finds it on its own.</li>
        </ol>
        <button className="btn small-btn" onClick={onRetry}>
          Check again
        </button>
      </div>
    );
  }
  return (
    <div className={`ob-conn ${video ? 'ok' : 'warn'}`}>
      <span className="ob-dot" />
      <div>
        <strong>MultiViewer {status.version ?? ''} connected</strong>
        <p className="small muted">{video ? video.title : videoError ?? 'Finding this session on F1 TV…'}</p>
      </div>
    </div>
  );
}

export function Toaster({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <i />
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function CamIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="cam-icon">
      <rect x="2.5" y="6" width="13" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.5 10.5 5-3v9l-5-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M3 3h8v8H3zM13 3h8v4h-8zM13 9h8v2h-8zM3 13h4v8H3zM9 13h4v8H9zM15 13h6v8h-6z" fill="currentColor" opacity=".9" />
    </svg>
  );
}
