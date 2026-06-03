export const HEALTHY_SERVICE_POLL_MS = 10_000;
export const UNHEALTHY_SERVICE_POLL_MS = 1_000;
export const HEALTH_CHECK_TIMEOUT_MS = 2_500;
export const HEALTH_CHECK_MAX_ATTEMPTS = 5;
export const HEALTH_CHECK_RETRY_DELAY_MS = 150;

export type MaintenanceHealthState = 'healthy' | 'suspect' | 'maintenance';

export interface HealthCheckService {
  label: string;
  check: () => Promise<void>;
}

export interface ServiceHealthResult {
  label: string;
  healthy: boolean;
  attempts: number;
}

export interface HealthRoundResult {
  healthy: boolean;
  services: ServiceHealthResult[];
}

export interface ServiceHealthCheckOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timerId = globalThis.setTimeout(() => {
      reject(new Error(`${label} health check timed out.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timerId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timerId);
        reject(error);
      }
    );
  });
}

export async function retryServiceHealthCheck(
  service: HealthCheckService,
  options: ServiceHealthCheckOptions = {}
): Promise<ServiceHealthResult> {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? HEALTH_CHECK_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? HEALTH_CHECK_RETRY_DELAY_MS));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await withTimeout(Promise.resolve().then(() => service.check()), timeoutMs, service.label);
      return {
        label: service.label,
        healthy: true,
        attempts: attempt,
      };
    } catch {
      if (attempt < maxAttempts) {
        await wait(retryDelayMs);
      }
    }
  }

  return {
    label: service.label,
    healthy: false,
    attempts: maxAttempts,
  };
}

export async function runHealthCheckRound(
  services: HealthCheckService[],
  options: ServiceHealthCheckOptions = {}
): Promise<HealthRoundResult> {
  if (!services.length) {
    return {
      healthy: true,
      services: [],
    };
  }

  const results = await Promise.all(services.map((service) => retryServiceHealthCheck(service, options)));

  return {
    healthy: results.every((service) => service.healthy),
    services: results,
  };
}

export function getHealthCheckDelay(state: MaintenanceHealthState): number {
  return state === 'healthy' ? HEALTHY_SERVICE_POLL_MS : UNHEALTHY_SERVICE_POLL_MS;
}
