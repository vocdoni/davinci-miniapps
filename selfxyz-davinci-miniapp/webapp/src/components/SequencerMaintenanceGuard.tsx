import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DavinciSDK } from '@vocdoni/davinci-sdk';

import { CONFIG } from '../lib/occ';
import { pingIndexer } from '../services/indexer';
import { createSequencerSdk, pingSequencer } from '../services/sequencer';

const DEFAULT_ROUTE = '/create';
const MAINTENANCE_ROUTE = '/maintenance';
const SERVICE_POLL_MS = 1_000;
const INITIAL_FAILURE_GRACE_MS = 4_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_500;

function buildLocationHref(pathname: string, search: string, hash: string): string {
  return `${pathname}${search}${hash}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject(new Error(`${label} health check timed out.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timerId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timerId);
        reject(error);
      }
    );
  });
}

export default function SequencerMaintenanceGuard() {
  const location = useLocation();
  const navigate = useNavigate();
  const sdkRef = useRef<DavinciSDK | null>(null);
  const lastHealthyRouteRef = useRef(DEFAULT_ROUTE);
  const isMaintenanceRouteRef = useRef(false);
  const firstFailureAtRef = useRef<number | null>(null);
  const hasObservedHealthyCheckRef = useRef(false);

  useEffect(() => {
    const isMaintenanceRoute = location.pathname === MAINTENANCE_ROUTE;
    isMaintenanceRouteRef.current = isMaintenanceRoute;
    if (!isMaintenanceRoute) {
      lastHealthyRouteRef.current = buildLocationHref(location.pathname, location.search, location.hash);
    }
  }, [location.hash, location.pathname, location.search]);

  useEffect(() => {
    const sequencerUrl = String(CONFIG.davinciSequencerUrl || '').trim();
    const indexerUrl = String(CONFIG.onchainIndexerUrl || '').trim();

    if (!sequencerUrl && !indexerUrl) return;

    if (sequencerUrl && !sdkRef.current) {
      sdkRef.current = createSequencerSdk({ sequencerUrl });
    }

    let cancelled = false;
    let timerId: number | null = null;

    const scheduleNext = (delayMs = SERVICE_POLL_MS) => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void runCheck();
      }, delayMs);
    };

    const runCheck = async () => {
      let nextDelay = SERVICE_POLL_MS;

      try {
        if (sequencerUrl) {
          const sdk = sdkRef.current;
          if (!sdk) {
            throw new Error('Sequencer SDK is unavailable.');
          }
          await withTimeout(pingSequencer(sdk), HEALTH_CHECK_TIMEOUT_MS, 'Sequencer');
        }
        if (indexerUrl) {
          await withTimeout(pingIndexer(indexerUrl), HEALTH_CHECK_TIMEOUT_MS, 'Indexer');
        }
        if (cancelled) return;
        hasObservedHealthyCheckRef.current = true;
        firstFailureAtRef.current = null;
        if (isMaintenanceRouteRef.current) {
          navigate(lastHealthyRouteRef.current || DEFAULT_ROUTE, { replace: true });
        }
      } catch {
        if (cancelled) return;

        if (!isMaintenanceRouteRef.current && !hasObservedHealthyCheckRef.current) {
          const now = Date.now();
          const firstFailureAt = firstFailureAtRef.current ?? now;
          firstFailureAtRef.current = firstFailureAt;

          if (now - firstFailureAt < INITIAL_FAILURE_GRACE_MS) {
            nextDelay = SERVICE_POLL_MS;
            return;
          }
        }

        if (!isMaintenanceRouteRef.current) {
          navigate(MAINTENANCE_ROUTE, { replace: true });
        }
      } finally {
        scheduleNext(nextDelay);
      }
    };

    void runCheck();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [navigate]);

  return null;
}
