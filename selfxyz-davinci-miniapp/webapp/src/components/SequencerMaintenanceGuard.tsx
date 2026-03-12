import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DavinciSDK } from '@vocdoni/davinci-sdk';

import { CONFIG } from '../lib/occ';
import { pingIndexer } from '../services/indexer';
import { createSequencerSdk, pingSequencer } from '../services/sequencer';

const DEFAULT_ROUTE = '/create';
const MAINTENANCE_ROUTE = '/maintenance';
const SERVICE_POLL_MS = 10_000;

function buildLocationHref(pathname: string, search: string, hash: string): string {
  return `${pathname}${search}${hash}`;
}

export default function SequencerMaintenanceGuard() {
  const location = useLocation();
  const navigate = useNavigate();
  const sdkRef = useRef<DavinciSDK | null>(null);
  const lastHealthyRouteRef = useRef(DEFAULT_ROUTE);
  const isMaintenanceRouteRef = useRef(false);

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

    const scheduleNext = () => {
      if (cancelled) return;
      timerId = window.setTimeout(() => {
        void runCheck();
      }, SERVICE_POLL_MS);
    };

    const runCheck = async () => {
      try {
        if (sequencerUrl) {
          const sdk = sdkRef.current;
          if (!sdk) {
            throw new Error('Sequencer SDK is unavailable.');
          }
          await pingSequencer(sdk);
        }
        if (indexerUrl) {
          await pingIndexer(indexerUrl);
        }
        if (cancelled) return;
        if (isMaintenanceRouteRef.current) {
          navigate(lastHealthyRouteRef.current || DEFAULT_ROUTE, { replace: true });
        }
      } catch {
        if (cancelled) return;
        if (!isMaintenanceRouteRef.current) {
          navigate(MAINTENANCE_ROUTE, { replace: true });
        }
      } finally {
        scheduleNext();
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
