import { describe, expect, it } from 'vitest';

import { buildIndexerPayload } from './indexer';

describe('indexer service', () => {
  it('builds indexer payload with expiresAt', () => {
    const payload = buildIndexerPayload({
      chainId: 11155111,
      address: '0x2E6C3D4ED7dA2bAD613A3Ea30961db7bF8452b29',
      startBlock: 10085464,
      startDate: new Date('2026-03-01T11:00:00Z'),
      duration: 3600,
    });

    expect(payload).toEqual({
      chainId: 11155111,
      address: '0x2E6C3D4ED7dA2bAD613A3Ea30961db7bF8452b29',
      startBlock: 10085464,
      expiresAt: '2026-03-01T12:00:00Z',
    });
  });
});
