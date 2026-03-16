import { useCallback, useEffect, useMemo } from 'react';

import AppNavbar from '../components/AppNavbar';
import ProtocolFeatureList from '../components/ProtocolFeatureList';
import RichText from '../components/RichText';
import { COPY } from '../copy';
import { buildAssetUrl } from '../utils/assets';

export default function HomeRoute() {
  const withBase = useCallback((file: string) => buildAssetUrl(file), []);
  const baseUrl = import.meta.env.BASE_URL || '/';
  const buildAppHref = useCallback(
    (path: string) => `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
    [baseUrl]
  );
  const navLinks = useMemo(
    () => [
      {
        id: 'homeCreateLink',
        href: buildAppHref('/create'),
        label: COPY.shared.create,
        iconClass: 'iconoir-plus',
      },
      {
        id: 'homeExploreLink',
        href: buildAppHref('/explore'),
        label: COPY.shared.explore,
        iconClass: 'iconoir-search',
      },
    ],
    [buildAppHref]
  );

  useEffect(() => {
    document.title = COPY.brand.documentTitle;
  }, []);

  return (
    <section id="homeView" className="view home-route">
      <AppNavbar
        id="homeNavbar"
        brandId="homeNavbarBrand"
        baseHref={baseUrl}
        logoSrc={withBase('davinci_logo.png')}
        brandLabel={COPY.brand.appName}
        navLinks={navLinks}
      />

      <header className="home-hero card" id="homeHero">
        <div className="home-hero-copy">
          <p className="eyebrow home-eyebrow">{COPY.home.hero.eyebrow}</p>
          <h1 className="home-title">{COPY.home.hero.title}</h1>
          <p className="home-lede">
            <RichText html={COPY.home.hero.introRich} />
          </p>

          <div className="home-actions">
            <a id="homeCreateCta" className="home-cta" href={buildAppHref('/create')}>
              <span className="iconoir-plus" aria-hidden="true" />
              <span>{COPY.home.hero.primaryCta}</span>
            </a>
            <a className="home-cta secondary" href={buildAppHref('/explore')}>
              <span className="iconoir-search" aria-hidden="true" />
              <span>{COPY.home.hero.secondaryCta}</span>
            </a>
          </div>

          <ul className="home-signal-grid" aria-label={COPY.home.hero.signalsLabel}>
            {COPY.home.hero.signals.map((signal) => (
              <li key={`${signal.title}-${signal.description}`} className="home-signal-card">
                <strong>{signal.title}</strong>
                <span>{signal.description}</span>
              </li>
            ))}
          </ul>
        </div>

        <aside className="home-proof-panel" aria-label={COPY.home.stack.ariaLabel}>
          <p className="eyebrow home-proof-eyebrow">{COPY.home.stack.eyebrow}</p>
          <h2 className="home-proof-title">{COPY.home.stack.title}</h2>
          <p className="home-proof-text">{COPY.home.stack.description}</p>

          <ol className="home-proof-list">
            {COPY.home.stack.items.map((item, index) => (
              <li key={item.title} className="home-proof-item">
                <span className="home-proof-step" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </header>

      <section className="home-story-grid">
        <article className="card home-flow-card">
          <p className="eyebrow">{COPY.home.flow.eyebrow}</p>
          <h2>{COPY.home.flow.title}</h2>
          <ol className="home-flow-list">
            {COPY.home.flow.steps.map((step) => (
              <li key={step.title} className="home-flow-item">
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </li>
            ))}
          </ol>
        </article>

        <article className="card home-audience-card">
          <p className="eyebrow">{COPY.home.audience.eyebrow}</p>
          <h2>{COPY.home.audience.title}</h2>
          <p className="home-audience-copy">{COPY.home.audience.description}</p>
          <div className="home-tag-list" aria-label={COPY.home.audience.tagsLabel}>
            {COPY.home.audience.tags.map((tag) => (
              <span key={tag} className="home-tag">
                {tag}
              </span>
            ))}
          </div>
          <a className="home-cta" href={buildAppHref('/create')}>
            <span className="iconoir-plus" aria-hidden="true" />
            <span>{COPY.home.audience.cta}</span>
          </a>
        </article>
      </section>

      <section className="home-pillars-grid home-protocol-section" aria-labelledby="homeProtocolSectionTitle">
        <header className="home-protocol-section-header">
          <p className="eyebrow home-protocol-section-eyebrow">{COPY.home.protocol.sectionEyebrow}</p>
          <h2 id="homeProtocolSectionTitle" className="home-protocol-section-title">
            {COPY.home.protocol.sectionTitle}
          </h2>
          <p className="home-protocol-section-copy">{COPY.home.protocol.sectionDescription}</p>
        </header>

        <div className="home-protocol-panel-grid">
          <article className="card home-protocol-lead">
            <p className="eyebrow home-protocol-eyebrow">{COPY.home.protocol.eyebrow}</p>
            <h3 id="homeProtocolTitle">{COPY.home.protocol.title}</h3>
            <p className="home-protocol-copy">{COPY.home.protocol.description}</p>
            <div className="home-protocol-tags" aria-label={COPY.home.protocol.tagsLabel}>
              {COPY.home.protocol.tags.map((tag) => (
                <span key={tag} className="home-protocol-tag">
                  {tag}
                </span>
              ))}
            </div>
          </article>

          <ProtocolFeatureList ariaLabel={COPY.home.protocol.featuresLabel} features={COPY.home.protocol.features} />
        </div>
      </section>
    </section>
  );
}
