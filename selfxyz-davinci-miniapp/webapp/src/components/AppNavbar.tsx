import type { ReactNode } from 'react';

interface AppNavbarProps {
  id?: string;
  brandId?: string;
  baseHref: string;
  logoSrc: string;
  brandLabel: string;
  children?: ReactNode;
}

export default function AppNavbar({ id, brandId, baseHref, logoSrc, brandLabel, children }: AppNavbarProps) {
  return (
    <nav className="app-navbar" id={id}>
      <a href={baseHref} className="navbar-brand" id={brandId}>
        <img className="navbar-logo" src={logoSrc} alt="Davinci logo" />
        <span>{brandLabel}</span>
      </a>
      <div className="navbar-actions">{children}</div>
    </nav>
  );
}
