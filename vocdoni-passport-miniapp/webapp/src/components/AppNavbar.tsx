import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { COPY } from '../copy';

interface AppNavbarLink {
  id?: string;
  href: string;
  label: string;
  iconClass?: string;
  matchPathnames?: string[];
}

interface AppNavbarProps {
  id?: string;
  brandId?: string;
  baseHref: string;
  logoSrc: string;
  brandLabel: string;
  navLinks?: AppNavbarLink[];
  children?: ReactNode;
}

function normalizePathname(value: string): string {
  if (!value) return '/';
  const normalized = value.replace(/\/+$/, '');
  return normalized || '/';
}

function getHrefPathname(href: string): string {
  try {
    return normalizePathname(new URL(href, window.location.origin).pathname);
  } catch {
    return normalizePathname(String(href || '').split(/[?#]/, 1)[0] || '/');
  }
}

export default function AppNavbar({ id, brandId, baseHref, logoSrc, brandLabel, navLinks = [], children }: AppNavbarProps) {
  const inRouter = useInRouterContext();
  const currentPathname =
    typeof window !== 'undefined' && window.location ? normalizePathname(window.location.pathname) : '';

  return (
    <nav className="app-navbar" id={id}>
      <div className="app-navbar-inner">
        {inRouter ? (
          <Link to={baseHref} className="navbar-brand" id={brandId}>
            <img className="navbar-logo" src={logoSrc} alt={COPY.brand.davinciLogoAlt} />
            <span>{brandLabel}</span>
          </Link>
        ) : (
          <a href={baseHref} className="navbar-brand" id={brandId}>
            <img className="navbar-logo" src={logoSrc} alt={COPY.brand.davinciLogoAlt} />
            <span>{brandLabel}</span>
          </a>
        )}
        {navLinks.length > 0 && (
          <div className="navbar-nav">
            {navLinks.map((link) => {
              const activePathnames =
                link.matchPathnames?.map((pathname) => getHrefPathname(pathname)) || [getHrefPathname(link.href)];
              const isActive = Boolean(
                currentPathname &&
                  activePathnames.some((pathname) => pathname === '/'
                    ? currentPathname === pathname
                    : currentPathname === pathname || currentPathname.startsWith(`${pathname}/`))
              );
              return (
                inRouter ? (
                  <Link
                    key={`${link.href}-${link.label}`}
                    id={link.id}
                    className={`navbar-link ${isActive ? 'is-active' : ''}`}
                    to={link.href}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {link.iconClass && <span className={`navbar-link-icon ${link.iconClass}`} aria-hidden="true" />}
                    <span>{link.label}</span>
                  </Link>
                ) : (
                  <a
                    key={`${link.href}-${link.label}`}
                    id={link.id}
                    className={`navbar-link ${isActive ? 'is-active' : ''}`}
                    href={link.href}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {link.iconClass && <span className={`navbar-link-icon ${link.iconClass}`} aria-hidden="true" />}
                    <span>{link.label}</span>
                  </a>
                )
              );
            })}
          </div>
        )}
        <div className="navbar-actions">{children}</div>
      </div>
    </nav>
  );
}
