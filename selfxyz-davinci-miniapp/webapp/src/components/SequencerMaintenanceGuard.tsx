import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { DavinciSDK } from '@vocdoni/davinci-sdk';

import { CONFIG } from '../lib/occ';
import { pingIndexer } from '../services/indexer';
import {
  type HealthCheckService,
  type MaintenanceHealthState,
  getHealthCheckDelay,
  HEALTH_CHECK_MAX_ATTEMPTS,
  HEALTH_CHECK_RETRY_DELAY_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  UNHEALTHY_SERVICE_POLL_MS,
  runHealthCheckRound,
} from '../services/serviceHealth';
import { createSequencerSdk, pingSequencer } from '../services/sequencer';

const DEFAULT_ROUTE = '/create';
const MAINTENANCE_ROUTE = '/maintenance';

function buildLocationHref(pathname: string, search: string, hash: string): string {
  return `${pathname}${search}${hash}`;
}

export default function SequencerMaintenanceGuard() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMaintenanceRoute = location.pathname === MAINTENANCE_ROUTE;
  const navigateRef = useRef(navigate);
  const sdkRef = useRef<DavinciSDK | null>(null);
  const lastHealthyRouteRef = useRef(DEFAULT_ROUTE);
  const isMaintenanceRouteRef = useRef(isMaintenanceRoute);
  const healthStateRef = useRef<MaintenanceHealthState>(isMaintenanceRoute ? 'maintenance' : 'healthy');
  const previousMaintenanceRouteRef = useRef(isMaintenanceRoute);
  const timerIdRef = useRef<number | null>(null);
  const runCheckRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    const wasMaintenanceRoute = previousMaintenanceRouteRef.current;
    previousMaintenanceRouteRef.current = isMaintenanceRoute;
    isMaintenanceRouteRef.current = isMaintenanceRoute;

    if (isMaintenanceRoute) {
      healthStateRef.current = 'maintenance';

      if (!wasMaintenanceRoute) {
        if (timerIdRef.current !== null) {
          window.clearTimeout(timerIdRef.current);
        }
        timerIdRef.current = window.setTimeout(() => {
          void runCheckRef.current?.();
        }, UNHEALTHY_SERVICE_POLL_MS);
      }

      return;
    }

    lastHealthyRouteRef.current = buildLocationHref(location.pathname, location.search, location.hash);
  }, [isMaintenanceRoute, location.hash, location.pathname, location.search]);

  useEffect(() => {
    const sequencerUrl = String(CONFIG.davinciSequencerUrl || '').trim();
    const indexerUrl = String(CONFIG.onchainIndexerUrl || '').trim();

    if (!sequencerUrl && !indexerUrl) return;

    if (sequencerUrl && !sdkRef.current) {
      sdkRef.current = createSequencerSdk({ sequencerUrl });
    }

    let cancelled = false;

    const services: HealthCheckService[] = [];

    if (sequencerUrl) {
      services.push({
        label: 'Sequencer',
        check: async () => {
          const sdk = sdkRef.current;
          if (!sdk) {
            throw new Error('Sequencer SDK is unavailable.');
          }
          await pingSequencer(sdk);
        },
      });
    }

    if (indexerUrl) {
      services.push({
        label: 'Indexer',
        check: () => pingIndexer(indexerUrl),
      });
    }

    const scheduleNext = (delayMs = getHealthCheckDelay(healthStateRef.current)) => {
      if (cancelled) return;
      if (timerIdRef.current !== null) {
        window.clearTimeout(timerIdRef.current);
      }
      timerIdRef.current = window.setTimeout(() => {
        void runCheck();
      }, delayMs);
    };

    const runCheck = async () => {
      try {
        const round = await runHealthCheckRound(services, {
          maxAttempts: HEALTH_CHECK_MAX_ATTEMPTS,
          retryDelayMs: HEALTH_CHECK_RETRY_DELAY_MS,
          timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
        });

        if (cancelled) return;

        if (round.healthy) {
          healthStateRef.current = 'healthy';
          if (isMaintenanceRouteRef.current) {
            navigateRef.current(lastHealthyRouteRef.current || DEFAULT_ROUTE, { replace: true });
          }
          return;
        }

        if (isMaintenanceRouteRef.current || healthStateRef.current === 'maintenance') {
          healthStateRef.current = 'maintenance';
          if (!isMaintenanceRouteRef.current) {
            navigateRef.current(MAINTENANCE_ROUTE, { replace: true });
          }
          return;
        }

        if (healthStateRef.current === 'suspect') {
          healthStateRef.current = 'maintenance';
          navigateRef.current(MAINTENANCE_ROUTE, { replace: true });
          return;
        }

        healthStateRef.current = 'suspect';
      } finally {
        scheduleNext();
      }
    };

    runCheckRef.current = runCheck;
    void runCheck();

    return () => {
      cancelled = true;
      runCheckRef.current = null;
      if (timerIdRef.current !== null) {
        window.clearTimeout(timerIdRef.current);
        timerIdRef.current = null;
      }
    };
  }, []);

  return null;
}
