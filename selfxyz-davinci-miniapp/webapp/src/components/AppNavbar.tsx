import type { ReactNode } from 'react';

export interface AppNavbarLink {
  id?: string;
  href: string;
  label: string;
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
  const currentPathname =
    typeof window !== 'undefined' && window.location ? normalizePathname(window.location.pathname) : '';

  return (
    <nav className="app-navbar" id={id}>
      <a href={baseHref} className="navbar-brand" id={brandId}>
        <img className="navbar-logo" src={logoSrc} alt="Davinci logo" />
        <span>{brandLabel}</span>
      </a>
      {navLinks.length > 0 && (
        <div className="navbar-nav">
          {navLinks.map((link) => {
            const linkPathname = getHrefPathname(link.href);
            const isActive = Boolean(
              currentPathname &&
                (currentPathname === linkPathname || currentPathname.startsWith(`${linkPathname}/`))
            );
            return (
              <a
                key={`${link.href}-${link.label}`}
                id={link.id}
                className={`navbar-link ${isActive ? 'is-active' : ''}`}
                href={link.href}
                aria-current={isActive ? 'page' : undefined}
              >
                {link.label}
              </a>
            );
          })}
        </div>
      )}
      <div className="navbar-actions">{children}</div>
    </nav>
  );
}
