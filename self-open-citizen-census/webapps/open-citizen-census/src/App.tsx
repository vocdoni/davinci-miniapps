import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { CREATE_HEADER_TITLE, VOTE_HEADER_TITLE } from './lib/occ';
import CreateRoute from './routes/CreateRoute';
import VoteRoute from './routes/VoteRoute';

function AppLayout() {
  const location = useLocation();
  const inVoteView = /^\/vote(?:\/|$)/.test(location.pathname);
  const headerTitle = inVoteView ? VOTE_HEADER_TITLE : CREATE_HEADER_TITLE;
  const base = import.meta.env.BASE_URL || '/';
  const withBase = (file: string) => `${base.replace(/\/$/, '')}/assets/${file}`;

  return (
    <>
      <div className="app-shell">
        <header className="app-header">
          <div>
            <p className="eyebrow">Open Citizen Census</p>
            <h1>{headerTitle}</h1>
          </div>
        </header>

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
        <Route index element={<CreateRoute />} />
        <Route path="create" element={<CreateRoute />} />
        <Route path="vote" element={<VoteRoute />} />
        <Route path="vote/:processId" element={<VoteRoute />} />
        <Route path="*" element={<Navigate to="create" replace />} />
      </Route>
    </Routes>
  );
}
