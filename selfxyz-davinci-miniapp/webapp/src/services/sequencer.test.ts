import { beforeAll, describe, expect, it, vi } from 'vitest';

let fetchProcessMetadata: typeof import('./sequencer').fetchProcessMetadata;

describe('fetchProcessMetadata', () => {
  beforeAll(async () => {
    const globalScope = globalThis as unknown as { Worker?: typeof Worker };
    if (typeof globalScope.Worker === 'undefined') {
      globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
    }

    ({ fetchProcessMetadata } = await import('./sequencer'));
  });

  it('falls back to the public IPFS gateway when the stored gateway URL fails', async () => {
    const getMetadata = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway blocked'))
      .mockResolvedValueOnce({ title: { default: 'Recovered metadata' } });

    const metadata = await fetchProcessMetadata(
      {
        api: {
          sequencer: {
            getMetadata,
          },
        },
      } as any,
      {
        metadataURI: 'https://example-gateway.mypinata.cloud/ipfs/bafy-test',
      }
    );

    expect(metadata).toEqual({ title: { default: 'Recovered metadata' } });
    expect(getMetadata).toHaveBeenNthCalledWith(1, 'https://example-gateway.mypinata.cloud/ipfs/bafy-test');
    expect(getMetadata).toHaveBeenNthCalledWith(2, 'https://gateway.pinata.cloud/ipfs/bafy-test');
  });

  it('returns null when every candidate fails', async () => {
    const getMetadata = vi.fn().mockRejectedValue(new Error('still blocked'));

    await expect(
      fetchProcessMetadata(
        {
          api: {
            sequencer: {
              getMetadata,
            },
          },
        } as any,
        {
          metadataURI: 'https://example-gateway.mypinata.cloud/ipfs/bafy-test',
        }
      )
    ).resolves.toBeNull();
  });
});
