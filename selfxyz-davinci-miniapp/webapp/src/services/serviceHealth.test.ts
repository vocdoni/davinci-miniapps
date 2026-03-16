import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getHealthCheckDelay,
  HEALTHY_SERVICE_POLL_MS,
  retryServiceHealthCheck,
  runHealthCheckRound,
  UNHEALTHY_SERVICE_POLL_MS,
} from './serviceHealth';

describe('service health helpers', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('treats a later successful retry as healthy', async () => {
    const check = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('try 1 failed'))
      .mockRejectedValueOnce(new Error('try 2 failed'))
      .mockResolvedValue(undefined);

    await expect(
      retryServiceHealthCheck(
        { label: 'Sequencer', check },
        { maxAttempts: 5, retryDelayMs: 0, timeoutMs: 50 }
      )
    ).resolves.toEqual({
      label: 'Sequencer',
      healthy: true,
      attempts: 3,
    });

    expect(check).toHaveBeenCalledTimes(3);
  });

  it('marks a service as unhealthy when all retries fail', async () => {
    const check = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('still down'));

    await expect(
      retryServiceHealthCheck(
        { label: 'Indexer', check },
        { maxAttempts: 5, retryDelayMs: 0, timeoutMs: 50 }
      )
    ).resolves.toEqual({
      label: 'Indexer',
      healthy: false,
      attempts: 5,
    });

    expect(check).toHaveBeenCalledTimes(5);
  });

  it('treats timeout failures as unhealthy attempts', async () => {
    vi.useFakeTimers();

    const check = vi.fn<() => Promise<void>>(() => new Promise<void>(() => {}));
    const resultPromise = retryServiceHealthCheck(
      { label: 'Sequencer', check },
      { maxAttempts: 5, retryDelayMs: 0, timeoutMs: 10 }
    );

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      label: 'Sequencer',
      healthy: false,
      attempts: 5,
    });

    expect(check).toHaveBeenCalledTimes(5);
  });

  it('keeps a round unhealthy when one required service stays down', async () => {
    const round = await runHealthCheckRound(
      [
        { label: 'Sequencer', check: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
        { label: 'Indexer', check: vi.fn<() => Promise<void>>().mockRejectedValue(new Error('indexer down')) },
      ],
      { maxAttempts: 2, retryDelayMs: 0, timeoutMs: 50 }
    );

    expect(round.healthy).toBe(false);
    expect(round.services).toEqual([
      { label: 'Sequencer', healthy: true, attempts: 1 },
      { label: 'Indexer', healthy: false, attempts: 2 },
    ]);
  });

  it('uses the faster cadence while suspecting or recovering from maintenance', () => {
    expect(getHealthCheckDelay('healthy')).toBe(HEALTHY_SERVICE_POLL_MS);
    expect(getHealthCheckDelay('suspect')).toBe(UNHEALTHY_SERVICE_POLL_MS);
    expect(getHealthCheckDelay('maintenance')).toBe(UNHEALTHY_SERVICE_POLL_MS);
  });
});
