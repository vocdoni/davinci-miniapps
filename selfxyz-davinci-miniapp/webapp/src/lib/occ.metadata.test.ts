import { beforeAll, describe, expect, it } from 'vitest';

let extractVoteContextFromMetadata: typeof import('./occ').extractVoteContextFromMetadata;

beforeAll(async () => {
  const globalScope = globalThis as unknown as { Worker?: typeof Worker };
  if (typeof globalScope.Worker === 'undefined') {
    globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
  }
  ({ extractVoteContextFromMetadata } = await import('./occ'));
});

describe('extractVoteContextFromMetadata', () => {
  it('parses countries from new selfConfig.countries format', () => {
    const context = extractVoteContextFromMetadata({
      meta: {
        selfConfig: {
          scope: 'USA_18_abcde',
          minAge: 18,
          countries: ['usa', 'fra', 'USA'],
        },
      },
    });

    expect(context.scopeSeed).toBe('USA_18_abcde');
    expect(context.minAge).toBe(18);
    expect(context.countries).toEqual(['USA', 'FRA']);
    expect(context.country).toBe('USA');
  });

  it('falls back to legacy selfConfig.country when countries is missing', () => {
    const context = extractVoteContextFromMetadata({
      meta: {
        selfConfig: {
          scope: 'ESP_21_qwert',
          minAge: 21,
          country: 'esp',
        },
      },
    });

    expect(context.countries).toEqual(['ESP']);
    expect(context.country).toBe('ESP');
  });

  it('prefers countries array over legacy country when both are present', () => {
    const context = extractVoteContextFromMetadata({
      meta: {
        selfConfig: {
          countries: ['DEU', 'ITA'],
          country: 'USA',
        },
      },
    });

    expect(context.countries).toEqual(['DEU', 'ITA']);
    expect(context.country).toBe('DEU');
  });

  it('filters invalid country codes safely', () => {
    const context = extractVoteContextFromMetadata({
      meta: {
        selfConfig: {
          countries: ['USAA', '', '12', 'fra'],
          country: '!',
        },
      },
    });

    expect(context.countries).toEqual(['FRA']);
    expect(context.country).toBe('FRA');
  });
});
