import { Link } from 'react-router-dom';
import { COPY } from '../copy';

export default function HomeRoute() {
  const { eyebrow, title, intro, primaryCta, secondaryCta, howItWorks } = COPY.home;

  return (
    <section className="view" id="homeView">
      <article className="card home-hero">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{intro}</p>
        <div className="home-ctas">
          <Link className="home-cta primary" to="/create">
            {primaryCta}
          </Link>
          <Link className="home-cta secondary" to="/explore">
            {secondaryCta}
          </Link>
        </div>
      </article>

      <article className="card">
        <div className="card-head">
          <p className="eyebrow">{howItWorks.eyebrow}</p>
          <h2>{howItWorks.title}</h2>
        </div>
        <div className="how-steps">
          {howItWorks.steps.map((step, i) => (
            <div className="how-step" key={i}>
              <span className="how-step-num">Step {i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
