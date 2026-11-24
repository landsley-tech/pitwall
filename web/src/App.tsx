import { useEffect, useState } from 'react';
import type { SessionMeta } from '@shared/types';
import { SessionPicker } from './components/SessionPicker';
import { LiveView } from './views/LiveView';
import { ReplayView } from './views/ReplayView';

type Route = { view: 'home' } | { view: 'live' } | { view: 'replay'; session: SessionMeta };

// Keep the chosen view in the URL hash so refreshing stays on the same screen.
function readHash(): Route | null {
  const h = location.hash.slice(1);
  if (h === 'live') return { view: 'live' };
  const m = /^replay\/(.+)$/.exec(h);
  if (m) {
    try {
      return { view: 'replay', session: JSON.parse(decodeURIComponent(m[1])) };
    } catch {
      return null;
    }
  }
  return null;
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => readHash() ?? { view: 'home' });

  useEffect(() => {
    const h =
      route.view === 'live' ? '#live' : route.view === 'replay' ? `#replay/${encodeURIComponent(JSON.stringify(route.session))}` : '';
    if (location.hash !== h) {
      if (h) history.pushState(null, '', h);
      else history.pushState(null, '', location.pathname);
    }
  }, [route]);

  // Browser back/forward and edited URLs.
  useEffect(() => {
    const onNav = () => setRoute(readHash() ?? { view: 'home' });
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, []);

  const home = () => setRoute({ view: 'home' });
  if (route.view === 'live') return <LiveView onBack={home} />;
  if (route.view === 'replay') return <ReplayView key={route.session.key} session={route.session} onBack={home} />;
  return <SessionPicker onReplay={(session) => setRoute({ view: 'replay', session })} onLive={() => setRoute({ view: 'live' })} />;
}
