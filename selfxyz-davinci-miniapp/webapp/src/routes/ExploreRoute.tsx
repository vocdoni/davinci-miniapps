import { ProcessStatus } from '@vocdoni/davinci-sdk';
import type { DavinciSDK } from '@vocdoni/davinci-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AppNavbar from '../components/AppNavbar';
import RichText from '../components/RichText';
import { COPY } from '../copy';
import { CONFIG } from '../lib/occ';
import {
  listProcessesFromSequencer,
  createSequencerSdk,
  fetchProcessMetadata,
  getProcessFromSequencer,
} from '../services/sequencer';
import type { SequencerMetadata, SequencerProcess } from '../services/sequencer';
import { buildAssetUrl } from '../utils/assets';
import { normalizeProcessId } from '../utils/normalization';
import {
  DEFAULT_EXPLORE_PAGE_STATE,
  collectExploreMatches,
  extractProcessStartTimeMs,
  mapExploreProcessRow,
  sortProcessIdsNewestFirst,
} from './explore/model';
import type { ExplorePageState, ExploreProcessRow } from './explore/types';
import { COUNTRY_OPTIONS } from './create/constants';

const PAGE_MATCH_TARGET = 20;
const SCAN_CHUNK_SIZE = 20;
const FETCH_CONCURRENCY = 4;
const REFRESH_INTERVAL_MS = 30_000;

interface MetadataCacheEntry {
  uri: string;
  metadata: SequencerMetadata | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return COPY.explore.loadingError;
}

function statusClassName(statusCode: number | null): string {
  switch (statusCode) {
    case ProcessStatus.READY:
      return 'ready';
    case ProcessStatus.ENDED:
      return 'ended';
    case ProcessStatus.CANCELED:
      return 'canceled';
    case ProcessStatus.PAUSED:
      return 'paused';
    case ProcessStatus.RESULTS:
      return 'results';
    default:
      return 'unknown';
  }
}

export default function ExploreRoute() {
  const baseUrl = import.meta.env.BASE_URL || '/';
  const [state, setState] = useState<ExplorePageState>(DEFAULT_EXPLORE_PAGE_STATE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState('');

  const sdkRef = useRef<DavinciSDK | null>(null);
  const processCacheRef = useRef<Map<string, SequencerProcess | null>>(new Map());
  const metadataCacheRef = useRef<Map<string, MetadataCacheEntry>>(new Map());
  const requestTokenRef = useRef(0);

  const withBase = useCallback((file: string) => buildAssetUrl(file), []);

  const buildAppHref = useCallback(
    (path: string): string => {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `${baseUrl.replace(/\/$/, '')}${normalizedPath}`;
    },
    [baseUrl]
  );

  const navLinks = useMemo(
    () => [{ id: 'navExploreLink', href: buildAppHref('/explore'), label: COPY.shared.explore }],
    [buildAppHref]
  );
  const countryFilterOptions = useMemo(
    () => [...COUNTRY_OPTIONS].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })),
    []
  );

  const getSdk = useCallback(() => {
    if (sdkRef.current) return sdkRef.current;
    const sequencerUrl = String(CONFIG.davinciSequencerUrl || '').trim();
    if (!sequencerUrl) {
      throw new Error(COPY.explore.missingSequencerUrl);
    }
    const sdk = createSequencerSdk({ sequencerUrl });
    sdkRef.current = sdk;
    return sdk;
  }, []);

  const getProcess = useCallback(
    async (processId: string, force = false): Promise<SequencerProcess | null> => {
      const cached = processCacheRef.current.get(processId);
      if (cached && !force) return cached;

      try {
        const process = await getProcessFromSequencer(getSdk(), processId);
        processCacheRef.current.set(processId, process);
        return process;
      } catch {
        return cached || null;
      }
    },
    [getSdk]
  );

  const getMetadata = useCallback(
    async (processId: string, process: SequencerProcess | null): Promise<SequencerMetadata | null> => {
      if (!process) return null;
      const metadataUri = String(process.metadataURI || process.metadataUri || '').trim();
      const cached = metadataCacheRef.current.get(processId);
      if (cached && (!metadataUri || cached.uri === metadataUri)) return cached.metadata;

      const metadata = await fetchProcessMetadata(getSdk(), process);
      metadataCacheRef.current.set(processId, {
        uri: metadataUri,
        metadata,
      });
      return metadata;
    },
    [getSdk]
  );

  const buildRowFromProcessId = useCallback(
    async (processId: string, options?: { forceProcess?: boolean }): Promise<ExploreProcessRow | null> => {
      const normalizedProcessId = normalizeProcessId(processId);
      if (!normalizedProcessId) return null;

      const process = await getProcess(normalizedProcessId, Boolean(options?.forceProcess));
      if (!process) return null;

      const metadata = await getMetadata(normalizedProcessId, process);
      return mapExploreProcessRow({
        processId: normalizedProcessId,
        process,
        metadata,
        buildVoteHref: (id: string) => buildAppHref(`/vote/${encodeURIComponent(normalizeProcessId(id))}`),
      });
    },
    [buildAppHref, getMetadata, getProcess]
  );

  const buildFilteredRowFromProcessId = useCallback(
    async (processId: string, options?: { forceProcess?: boolean }): Promise<ExploreProcessRow | null> => {
      const row = await buildRowFromProcessId(processId, options);
      if (!row) return null;
      if (selectedCountry && !row.countries.includes(selectedCountry)) return null;
      return row;
    },
    [buildRowFromProcessId, selectedCountry]
  );

  const loadSortedProcessIds = useCallback(async (): Promise<string[]> => {
    const processIds = await listProcessesFromSequencer(getSdk());
    const uniqueProcessIds = Array.from(new Set(processIds.map((processId) => normalizeProcessId(processId)).filter(Boolean)));
    if (!uniqueProcessIds.length) return [];

    const startEntries = await collectExploreMatches({
      processIds: uniqueProcessIds,
      cursor: 0,
      targetMatches: uniqueProcessIds.length,
      chunkSize: SCAN_CHUNK_SIZE,
      concurrency: FETCH_CONCURRENCY,
      mapProcessId: async (processId) => {
        const process = await getProcess(processId);
        return {
          processId,
          startTimeMs: extractProcessStartTimeMs(process),
        };
      },
    });

    return sortProcessIdsNewestFirst(startEntries.items);
  }, [getProcess, getSdk]);

  const loadInitial = useCallback(async () => {
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    setLoadingMore(false);
    setState({
      ...DEFAULT_EXPLORE_PAGE_STATE,
      loading: true,
    });

    try {
      const sortedProcessIds = await loadSortedProcessIds();
      if (token !== requestTokenRef.current) return;

      const firstPage = await collectExploreMatches({
        processIds: sortedProcessIds,
        cursor: 0,
        targetMatches: PAGE_MATCH_TARGET,
        chunkSize: SCAN_CHUNK_SIZE,
        concurrency: FETCH_CONCURRENCY,
        mapProcessId: (processId) => buildFilteredRowFromProcessId(processId),
      });
      if (token !== requestTokenRef.current) return;

      setState({
        loading: false,
        refreshing: false,
        error: '',
        rows: firstPage.items,
        nextCursor: firstPage.nextCursor,
        hasMore: firstPage.hasMore,
        allProcessIds: sortedProcessIds,
      });
    } catch (error) {
      if (token !== requestTokenRef.current) return;
      setState({
        loading: false,
        refreshing: false,
        error: getErrorMessage(error),
        rows: [],
        nextCursor: 0,
        hasMore: false,
        allProcessIds: [],
      });
    }
  }, [buildFilteredRowFromProcessId, loadSortedProcessIds]);

  const handleLoadMore = useCallback(async () => {
    if (state.loading || loadingMore || !state.hasMore) return;
    const token = requestTokenRef.current;
    setLoadingMore(true);

    try {
      const nextPage = await collectExploreMatches({
        processIds: state.allProcessIds,
        cursor: state.nextCursor,
        targetMatches: PAGE_MATCH_TARGET,
        chunkSize: SCAN_CHUNK_SIZE,
        concurrency: FETCH_CONCURRENCY,
        mapProcessId: (processId) => buildFilteredRowFromProcessId(processId),
      });
      if (token !== requestTokenRef.current) return;

      setState((previous) => {
        const knownProcessIds = new Set(previous.rows.map((row) => row.processId));
        const appendedRows = nextPage.items.filter((row) => !knownProcessIds.has(row.processId));
        return {
          ...previous,
          error: '',
          rows: [...previous.rows, ...appendedRows],
          nextCursor: nextPage.nextCursor,
          hasMore: nextPage.hasMore,
        };
      });
    } catch (error) {
      if (token !== requestTokenRef.current) return;
      setState((previous) => ({
        ...previous,
        error: getErrorMessage(error),
      }));
    } finally {
      if (token === requestTokenRef.current) {
        setLoadingMore(false);
      }
    }
  }, [buildFilteredRowFromProcessId, loadingMore, state.allProcessIds, state.hasMore, state.loading, state.nextCursor]);

  const refreshLoadedRows = useCallback(async () => {
    if (state.loading || state.refreshing || !state.rows.length) return;
    const token = requestTokenRef.current;
    const activeProcessIds = state.rows.map((row) => row.processId);
    setState((previous) => ({
      ...previous,
      refreshing: true,
      error: '',
    }));

    try {
      const refreshed = await collectExploreMatches({
        processIds: activeProcessIds,
        cursor: 0,
        targetMatches: activeProcessIds.length,
        chunkSize: SCAN_CHUNK_SIZE,
        concurrency: FETCH_CONCURRENCY,
        mapProcessId: (processId) => buildFilteredRowFromProcessId(processId, { forceProcess: true }),
      });
      if (token !== requestTokenRef.current) return;

      const nextRowsById = new Map(refreshed.items.map((row) => [row.processId, row]));
      setState((previous) => ({
        ...previous,
        refreshing: false,
        rows: previous.rows.map((row) => nextRowsById.get(row.processId) || row),
      }));
    } catch (error) {
      if (token !== requestTokenRef.current) return;
      setState((previous) => ({
        ...previous,
        refreshing: false,
        error: getErrorMessage(error),
      }));
    }
  }, [buildFilteredRowFromProcessId, state.loading, state.refreshing, state.rows]);

  useEffect(() => {
    void loadInitial();
    return () => {
      requestTokenRef.current += 1;
    };
  }, [loadInitial]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshLoadedRows();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [refreshLoadedRows]);

  const showCountryFilter = Boolean(selectedCountry) || state.rows.length > 0;

  return (
    <section id="exploreView" className="view explore-route">
      <AppNavbar
        id="exploreNavbar"
        brandId="exploreNavbarBrand"
        baseHref={baseUrl}
        logoSrc={withBase('davinci_logo.png')}
        brandLabel={COPY.brand.appName}
        navLinks={navLinks}
      />

      <header className="app-header create-header question-hero-header explore-header" id="exploreHeader">
        <h1 id="exploreHeaderTitle" className="question-hero-title">
          {COPY.explore.headerTitle}
        </h1>
        <p id="exploreHeaderText" className="create-intro question-hero-helper">
          <RichText html={COPY.explore.headerTextRich} />
        </p>
      </header>

      <section className="explore-list-panel">
        {showCountryFilter && (
          <div className="explore-filter-floating">
            <div className="explore-filter">
              <select
                id="exploreCountryFilter"
                className="explore-filter-select"
                aria-label={COPY.explore.countryFilterLabel}
                value={selectedCountry}
                onChange={(event) => setSelectedCountry(event.target.value)}
              >
                <option value="">{COPY.explore.countryFilterAll}</option>
                {countryFilterOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label} ({option.code})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <section className="explore-list-wrap">
          <div className="explore-list-head">
            <p className="muted" id="exploreStatsText">
              {COPY.explore.statsShowing(state.rows.length)}
            </p>
          </div>

          {state.error && (
            <div className="explore-feedback explore-feedback-error" role="alert">
              <p>{state.error}</p>
              <button type="button" className="secondary" onClick={() => void loadInitial()}>
                {COPY.explore.retry}
              </button>
            </div>
          )}

          {state.loading && (
            <div className="explore-feedback explore-feedback-loading" id="exploreLoading">
              <span className="timeline-spinner" aria-hidden="true" />
              <span>{COPY.explore.loading}</span>
            </div>
          )}

          {!state.loading && !state.error && state.rows.length === 0 && (
            <div className="explore-feedback" id="exploreEmptyState">
              {COPY.explore.emptyState}
            </div>
          )}

          {!state.loading && state.rows.length > 0 && (
            <>
              <ul className="explore-list" id="exploreProcessList">
                {state.rows.map((row) => {
                  const showRemaining = row.statusCode === ProcessStatus.READY;
                  return (
                    <li className="explore-row" key={row.processId}>
                      <a className="explore-row-link" href={row.voteHref}>
                        <div className="explore-row-main">
                          <p className="explore-row-question">{row.questionTitle}</p>
                          <span className={`explore-row-status is-${statusClassName(row.statusCode)}`}>{row.statusLabel}</span>
                        </div>
                        <p className="explore-row-requirements">
                          {COPY.explore.requirementsPrefix} {row.countries.join(', ')} | {COPY.explore.requirementsMinAge}{' '}
                          {row.minAge}
                          {showRemaining ? ` | ${COPY.explore.requirementsClosesIn} ${row.readyTimeRemainingLabel}` : ''}
                        </p>
                      </a>
                    </li>
                  );
                })}
              </ul>

              {state.hasMore && (
                <div className="explore-load-more-wrap">
                  <button
                    id="exploreLoadMoreBtn"
                    type="button"
                    className="cta-btn secondary"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore()}
                  >
                    <span className={`btn-icon ${loadingMore ? 'iconoir-refresh' : 'iconoir-more-horiz'}`} aria-hidden="true" />
                    <span>{loadingMore ? COPY.explore.loadingMore : COPY.explore.loadMore}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </section>
  );
}
