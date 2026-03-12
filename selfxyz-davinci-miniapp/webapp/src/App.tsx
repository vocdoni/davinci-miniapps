import { Suspense, lazy, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { buildAssetUrl } from './utils/assets';
import { COPY } from './copy';
import SupportPopup from './components/SupportPopup';
import SequencerMaintenanceGuard from './components/SequencerMaintenanceGuard';
import MaintenanceRoute from './routes/MaintenanceRoute';

const CreateRoute = lazy(() => import('./routes/CreateRoute'));
const VoteRoute = lazy(() => import('./routes/VoteRoute'));
const ExploreRoute = lazy(() => import('./routes/ExploreRoute'));

function shouldShowSupportPopup(pathname: string): boolean {
  return (
    pathname === '/' ||
    /^\/create(?:\/|$)/.test(pathname) ||
    /^\/vote(?:\/|$)/.test(pathname) ||
    pathname === '/maintenance'
  );
}

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
  const [supportOpen, setSupportOpen] = useState(true);
  const withBase = (file: string) => buildAssetUrl(file);
  const showSupportPopup = shouldShowSupportPopup(location.pathname);

  return (
    <>
      <SequencerMaintenanceGuard />

      <div className={`app-shell ${inVoteView ? 'route-vote' : 'route-create'}`}>
        <main id="mainContent">
          <Outlet />
        </main>

        <SupportPopup open={showSupportPopup && supportOpen} onDismiss={() => setSupportOpen(false)} />
      </div>

      <footer className="app-footer">
        <div className="footer-row">
          <span>{COPY.brand.poweredBy}</span>
          <a className="footer-logo-link" href="https://davinci.vote" target="_blank" rel="noreferrer">
            <img className="logo-davinci" src={withBase('davinci_logo.png')} alt={COPY.brand.davinciLogoAlt} />
          </a>
          <span>{COPY.brand.and}</span>
          <a className="footer-logo-link" href="https://self.xyz" target="_blank" rel="noreferrer">
            <img src={withBase('self_logo.png')} alt={COPY.brand.selfLogoAlt} />
          </a>
        </div>
        <div className="footer-row">
          <span>{COPY.brand.madeWith}</span>
          <span className="heart">❤️</span>
          <span>{COPY.brand.by}</span>
          <a className="footer-logo-link" href="https://vocdoni.io" target="_blank" rel="noreferrer">
            <img src={withBase('vocdoni_logo.png')} alt={COPY.brand.vocdoniLogoAlt} />
          </a>
        </div>
      </footer>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route
          index
          element={
            <Suspense fallback={<RouteLoadingFallback />}>
              <CreateRoute />
            </Suspense>
          }
        />
        <Route
          path="create"
          element={
            <Suspense fallback={<RouteLoadingFallback />}>
              <CreateRoute />
            </Suspense>
          }
        />
        <Route
          path="vote"
          element={
            <Suspense fallback={<RouteLoadingFallback />}>
              <VoteRoute />
            </Suspense>
          }
        />
        <Route
          path="vote/:processId"
          element={
            <Suspense fallback={<RouteLoadingFallback />}>
              <VoteRoute />
            </Suspense>
          }
        />
        <Route
          path="explore"
          element={
            <Suspense fallback={<RouteLoadingFallback />}>
              <ExploreRoute />
            </Suspense>
          }
        />
        <Route path="maintenance" element={<MaintenanceRoute />} />
        <Route path="*" element={<Navigate to="/create" replace />} />
      </Route>
    </Routes>
  );
}
