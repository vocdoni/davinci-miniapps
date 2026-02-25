import { describe, expect, it } from 'vitest';

import {
  computeExpiresAtFromStartAndDuration,
  extractProcessEndDateMs,
  toDateFromUnknown,
  toDurationMs,
  toRfc3339Timestamp,
} from './timing';

describe('timing utils', () => {
  it('parses unknown date formats', () => {
    expect(toDateFromUnknown('2026-03-01T12:00:00Z')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(toDateFromUnknown(1_708_000_000)?.toISOString()).toBeTruthy();
    expect(toDateFromUnknown('')).toBeNull();
  });

  it('converts duration units to milliseconds', () => {
    expect(toDurationMs(60)).toBe(60_000);
    expect(toDurationMs(60_000_000)).toBe(60_000_000);
    expect(toDurationMs('0')).toBeNull();
  });

  it('formats RFC3339 and computes expiresAt', () => {
    const start = new Date('2026-03-01T11:00:00Z');
    expect(toRfc3339Timestamp(start)).toBe('2026-03-01T11:00:00Z');
    expect(computeExpiresAtFromStartAndDuration(start, 3600)).toBe('2026-03-01T12:00:00Z');
  });

  it('extracts end date from timing fallback', () => {
    const process = {
      timing: {
        startDate: '2026-03-01T11:00:00Z',
        duration: 3600,
      },
    };

    expect(extractProcessEndDateMs(process, null)).toBe(new Date('2026-03-01T12:00:00Z').getTime());
  });
});
