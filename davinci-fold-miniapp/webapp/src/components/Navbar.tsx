import { NavLink } from 'react-router-dom';
import { COPY } from '../copy';

export default function Navbar() {
  return (
    <nav className="app-navbar" aria-label="Main navigation">
      <div className="app-navbar-inner">
        <NavLink className="app-navbar-brand" to="/">
          {COPY.navbar.home}
        </NavLink>
        <div className="app-navbar-links">
          <NavLink
            className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
            to="/create"
          >
            {COPY.navbar.create}
          </NavLink>
          <NavLink
            className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
            to="/explore"
          >
            {COPY.navbar.explore}
          </NavLink>
        </div>
      </div>
    </nav>
  );
}
