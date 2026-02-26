import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
  },
  DavinciSDK: class MockDavinciSDK {},
}));

import { collectExploreMatches, isExploreEligibleMetadata, mapExploreProcessRow, sortProcessIdsNewestFirst } from './model';

describe('explore metadata eligibility', () => {
  it('accepts metadata with valid selfConfig core fields', () => {
    const result = isExploreEligibleMetadata({
      meta: {
        selfConfig: {
          scope: 'ESP_18_abcde',
          minAge: 18,
          countries: ['ESP', 'FRA'],
        },
      },
    });

    expect(result).toEqual({ accepted: true, reason: 'ok' });
  });

  it('rejects metadata when scope is missing', () => {
    const result = isExploreEligibleMetadata({
      meta: {
        selfConfig: {
          minAge: 18,
          countries: ['ESP'],
        },
      },
    });

    expect(result).toEqual({ accepted: false, reason: 'missing_scope' });
  });

  it('rejects metadata when minAge is invalid', () => {
    const result = isExploreEligibleMetadata({
      meta: {
        selfConfig: {
          scope: 'ESP_18_abcde',
          minAge: 0,
          countries: ['ESP'],
        },
      },
    });

    expect(result).toEqual({ accepted: false, reason: 'invalid_min_age' });
  });

  it('rejects metadata when both countries and legacy country are missing', () => {
    const result = isExploreEligibleMetadata({
      meta: {
        selfConfig: {
          scope: 'ESP_18_abcde',
          minAge: 18,
        },
      },
    });

    expect(result).toEqual({ accepted: false, reason: 'missing_countries' });
  });

  it('accepts legacy single-country fallback', () => {
    const result = isExploreEligibleMetadata({
      meta: {
        selfConfig: {
          scope: 'ESP_18_abcde',
          minAge: 18,
          country: 'esp',
        },
      },
    });

    expect(result).toEqual({ accepted: true, reason: 'ok' });
  });
});

describe('explore row mapping', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses question title, computes READY remaining time and maps requirements', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-26T10:30:00Z'));

    const row = mapExploreProcessRow({
      processId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      process: {
        status: 0,
        startTime: '2026-02-26T10:00:00Z',
        duration: 3600,
      },
      metadata: {
        title: { default: 'Fallback title' },
        questions: [
          {
            title: { default: 'Question from metadata' },
            choices: [
              { title: { default: 'Yes' }, value: 0 },
              { title: { default: 'No' }, value: 1 },
            ],
          },
        ],
        meta: {
          selfConfig: {
            scope: 'ESP_18_abcde',
            minAge: 18,
            countries: ['ESP', 'FRA'],
          },
        },
      },
      buildVoteHref: (processId) => `/vote/${processId}`,
    });

    expect(row).not.toBeNull();
    expect(row?.questionTitle).toBe('Question from metadata');
    expect(row?.statusCode).toBe(0);
    expect(row?.readyTimeRemainingLabel).toBe('30m');
    expect(row?.countries).toEqual(['ESP', 'FRA']);
    expect(row?.minAge).toBe(18);
  });

  it('falls back to metadata title and uses "-" remaining time for non-ready statuses', () => {
    const row = mapExploreProcessRow({
      processId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      process: {
        status: 4,
        startTime: '2026-02-26T10:00:00Z',
        duration: 3600,
      },
      metadata: {
        title: { default: 'Metadata title' },
        meta: {
          selfConfig: {
            scope: 'ESP_18_abcde',
            minAge: 18,
            countries: ['ESP'],
          },
        },
      },
      buildVoteHref: (processId) => `/vote/${processId}`,
    });

    expect(row?.questionTitle).toBe('Metadata title');
    expect(row?.readyTimeRemainingLabel).toBe('-');
  });
});

describe('explore scan and sort helpers', () => {
  it('fills page target under sparse matches by scanning multiple chunks', async () => {
    const processIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const eligible = new Set(['c', 'g']);

    const result = await collectExploreMatches({
      processIds,
      cursor: 0,
      targetMatches: 2,
      chunkSize: 2,
      concurrency: 2,
      mapProcessId: async (processId) => (eligible.has(processId) ? processId : null),
    });

    expect(result.items).toEqual(['c', 'g']);
    expect(result.nextCursor).toBe(8);
    expect(result.hasMore).toBe(false);
  });

  it('updates cursor and hasMore when page target is reached early', async () => {
    const processIds = ['a', 'b', 'c'];
    const result = await collectExploreMatches({
      processIds,
      cursor: 0,
      targetMatches: 2,
      chunkSize: 2,
      concurrency: 1,
      mapProcessId: async (processId) => processId,
    });

    expect(result.items).toEqual(['a', 'b']);
    expect(result.nextCursor).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it('sorts process ids by newest start time first', () => {
    const sorted = sortProcessIdsNewestFirst([
      { processId: '0x3', startTimeMs: 50 },
      { processId: '0x1', startTimeMs: 120 },
      { processId: '0x2', startTimeMs: 120 },
    ]);

    expect(sorted).toEqual(['0x1', '0x2', '0x3']);
  });
});
