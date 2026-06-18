import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { COPY } from './copy';
import Navbar from './components/Navbar';

const HomeRoute = lazy(() => import('./routes/HomeRoute'));
const CreateRoute = lazy(() => import('./routes/CreateRoute'));
const VoteRoute = lazy(() => import('./routes/VoteRoute'));
const ExploreRoute = lazy(() => import('./routes/ExploreRoute'));

function RouteLoadingFallback() {
  return (
    <section className="view">
      <article className="card">
        <p className="muted">{COPY.app.routeLoading}</p>
      </article>
    </section>
  );
}

function AppLayout() {
  const location = useLocation();
  const inVoteView = /^\/vote(?:\/|$)/.test(location.pathname);
  const inHomeView = location.pathname === '/';
  const routeShellClass = inVoteView ? 'route-vote' : inHomeView ? 'route-home' : 'route-create';

  return (
    <div className={`app-shell ${routeShellClass}`}>
      <Navbar />
      <main id="mainContent">
        <Outlet />
      </main>
      <footer className="app-footer">
        <div className="footer-row">
          <span>{COPY.brand.poweredBy}</span>
          <a className="footer-logo-link" href="https://davinci.vote" target="_blank" rel="noreferrer">
            <img className="logo-davinci" src="/assets/davinci_logo.png" alt={COPY.brand.davinciLogoAlt} />
          </a>
        </div>
        <div className="footer-row">
          <span>{COPY.brand.madeWith}</span>
          <span>❤️</span>
          <span>{COPY.brand.by}</span>
          <a className="footer-logo-link" href="https://vocdoni.io" target="_blank" rel="noreferrer">
            <img src="/assets/vocdoni_logo.png" alt={COPY.brand.vocdoniLogoAlt} />
          </a>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Suspense fallback={<RouteLoadingFallback />}><HomeRoute /></Suspense>} />
        <Route path="create" element={<Suspense fallback={<RouteLoadingFallback />}><CreateRoute /></Suspense>} />
        <Route path="vote" element={<Suspense fallback={<RouteLoadingFallback />}><VoteRoute /></Suspense>} />
        <Route path="vote/:electionId" element={<Suspense fallback={<RouteLoadingFallback />}><VoteRoute /></Suspense>} />
        <Route path="explore" element={<Suspense fallback={<RouteLoadingFallback />}><ExploreRoute /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
