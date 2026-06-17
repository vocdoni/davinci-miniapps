import { COPY } from '../copy';

export default function MaintenanceRoute() {
  return (
    <section id="maintenanceView" className="view">
      <article className="card maintenance-card">
        <p className="eyebrow">{COPY.app.maintenance.eyebrow}</p>
        <h1 className="maintenance-title">{COPY.app.maintenance.title}</h1>
        <p className="maintenance-copy">{COPY.app.maintenance.description}</p>
        <div className="maintenance-status" role="status" aria-live="polite">
          <span className="maintenance-status-dot" aria-hidden="true" />
          <span>{COPY.app.maintenance.status}</span>
        </div>
        <p className="muted maintenance-footnote">{COPY.app.maintenance.footnote}</p>
      </article>
    </section>
  );
}
