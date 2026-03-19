import { afterEach, describe, expect, it, vi } from 'vitest';

import { pingIndexer } from './indexer';

describe('indexer service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats successful base responses as healthy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pingIndexer('https://indexer.example/')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://indexer.example', {
      method: 'GET',
      cache: 'no-store',
    });
  });

  it('fails the ping when the indexer returns a 5xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(pingIndexer('https://indexer.example')).rejects.toThrow('Indexer ping failed (503)');
  });
});
