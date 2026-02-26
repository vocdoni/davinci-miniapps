import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { buildAssetUrl } from './utils/assets';

const CreateRoute = lazy(() => import('./routes/CreateRoute'));
const VoteRoute = lazy(() => import('./routes/VoteRoute'));
const ExploreRoute = lazy(() => import('./routes/ExploreRoute'));

function RouteLoadingFallback() {
  return (
    <section className="view">
      <article className="card">
        <p className="muted">Loading route...</p>
      </article>
    </section>
  );
}

function AppLayout() {
  const location = useLocation();
  const inVoteView = /^\/vote(?:\/|$)/.test(location.pathname);
  const withBase = (file: string) => buildAssetUrl(file);

  return (
    <>
      <div className={`app-shell ${inVoteView ? 'route-vote' : 'route-create'}`}>
        <main id="mainContent">
          <Outlet />
        </main>
      </div>

      <footer className="app-footer">
        <div className="footer-row">
          <span>Powered by</span>
          <img className="logo-davinci" src={withBase('davinci_logo.png')} alt="Davinci logo" />
          <span>and</span>
          <img src={withBase('self_logo.png')} alt="Self logo" />
        </div>
        <div className="footer-row">
          <span>Made with</span>
          <span className="heart">❤️</span>
          <span>by</span>
          <img src={withBase('vocdoni_logo.png')} alt="Vocdoni logo" />
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
        <Route path="*" element={<Navigate to="/create" replace />} />
      </Route>
    </Routes>
  );
}
