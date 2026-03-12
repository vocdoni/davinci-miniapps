import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildIndexerPayload, pingIndexer } from './indexer';

describe('indexer service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('treats non-5xx /contracts responses as healthy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 405 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pingIndexer('https://indexer.example/')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://indexer.example/contracts', {
      method: 'HEAD',
      cache: 'no-store',
    });
  });

  it('fails the ping when the indexer returns a 5xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(pingIndexer('https://indexer.example')).rejects.toThrow('Indexer ping failed (503)');
  });
});
