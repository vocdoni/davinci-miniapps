import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fold } from '../services/fold';
import type { ElectionResponse, ElectionStatus } from '../lib/types';
import { formatEndTime, loadElectionMeta, shortHex, timeUntil } from '../lib/dfc';
import { COPY } from '../copy';
import StatusBadge from '../components/StatusBadge';

type Filter = 'all' | ElectionStatus;

export default function ExploreRoute() {
  const [elections, setElections] = useState<ElectionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fold.elections();
      setElections(data.elections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : COPY.explore.loadingFailed);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = filter === 'all' ? elections : elections.filter((e) => e.status === filter);

  return (
    <section className="view" id="exploreView">
      <article className="card">
        <div className="card-head">
          <h2>{COPY.explore.headerTitle}</h2>
          <p className="muted">{COPY.explore.headerIntro}</p>
        </div>

        <div className="row">
          {(['all', 'active', 'results'] as const).map((f) => (
            <button
              key={f}
              className={filter === f ? undefined : 'secondary'}
              onClick={() => setFilter(f)}
              style={{ minHeight: 36, padding: '6px 14px', fontSize: 13 }}
            >
              {f === 'all' ? COPY.explore.filterAll : f === 'active' ? COPY.explore.filterActive : COPY.explore.filterResults}
            </button>
          ))}
          <button className="ghost" onClick={() => void load()} style={{ minHeight: 36, padding: '6px 14px', fontSize: 13, marginLeft: 'auto' }}>
            {COPY.explore.retry}
          </button>
        </div>

        {loading && <p className="muted">{COPY.explore.loading}</p>}
        {error && <p className="muted danger">{error}</p>}

        {!loading && !error && visible.length === 0 && (
          <p className="muted">{COPY.explore.empty}</p>
        )}

        {visible.map((election) => (
          <ElectionCard key={election.id} election={election} />
        ))}
      </article>
    </section>
  );
}

function ElectionCard({ election }: { election: ElectionResponse }) {
  const meta = loadElectionMeta(election.id);
  const title = meta?.title ?? shortHex('0x' + election.id);

  return (
    <Link className="election-card" to={`/vote/${election.id}`}>
      <div className="election-card-head">
        <h3 className="election-card-title">{title}</h3>
        <StatusBadge status={election.status} />
      </div>
      {meta?.description && <p className="muted">{meta.description}</p>}
      <div className="election-card-meta">
        <span className="election-card-id">{shortHex('0x' + election.id)}</span>
        {election.endTime && (
          <span className="muted" style={{ fontSize: 12 }}>
            {election.status === 'active' ? `Closes in ${timeUntil(election.endTime)}` : formatEndTime(election.endTime)}
          </span>
        )}
      </div>
    </Link>
  );
}
