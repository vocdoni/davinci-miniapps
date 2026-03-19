import { beforeEach, describe, expect, it, vi } from 'vitest';

let fetchProcessMetadata: typeof import('./sequencer').fetchProcessMetadata;
let cacheProcessMetadata: typeof import('./sequencer').cacheProcessMetadata;

describe('fetchProcessMetadata', () => {
  beforeEach(async () => {
    vi.resetModules();
    const globalScope = globalThis as unknown as { Worker?: typeof Worker };
    if (typeof globalScope.Worker === 'undefined') {
      globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
    }

    globalThis.sessionStorage?.clear();
    ({ fetchProcessMetadata, cacheProcessMetadata } = await import('./sequencer'));
  });

  it('returns embedded process metadata without calling the gateway', async () => {
    const getMetadata = vi.fn();
    const metadata = await fetchProcessMetadata(
      {
        api: {
          sequencer: {
            getMetadata,
          },
        },
      } as any,
      {
        metadataURI: 'https://gateway.example.org/ipfs/bafy-test',
        metadata: { title: { default: 'Embedded metadata' } },
      }
    );

    expect(metadata).toEqual({ title: { default: 'Embedded metadata' } });
    expect(getMetadata).not.toHaveBeenCalled();
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
        metadataURI: 'https://gateway.example.org/ipfs/bafy-test',
      }
    );

    expect(metadata).toEqual({ title: { default: 'Recovered metadata' } });
    expect(getMetadata).toHaveBeenNthCalledWith(1, 'https://gateway.example.org/ipfs/bafy-test');
    expect(getMetadata).toHaveBeenNthCalledWith(2, 'https://ipfs.io/ipfs/bafy-test');
  });

  it('reuses cached metadata for the same URI without calling the gateway again', async () => {
    const getMetadata = vi.fn().mockResolvedValue({ title: { default: 'Cached metadata' } });
    const sdk = {
      api: {
        sequencer: {
          getMetadata,
        },
      },
    } as any;
    const process = {
      metadataURI: 'https://gateway.example.org/ipfs/bafy-test',
    };

    const first = await fetchProcessMetadata(sdk, process);
    const second = await fetchProcessMetadata(sdk, process);

    expect(first).toEqual({ title: { default: 'Cached metadata' } });
    expect(second).toEqual({ title: { default: 'Cached metadata' } });
    expect(getMetadata).toHaveBeenCalledTimes(1);
  });

  it('uses browser-persisted metadata before calling the gateway', async () => {
    cacheProcessMetadata('https://gateway.example.org/ipfs/bafy-test', {
      title: { default: 'Persisted metadata' },
    });

    const getMetadata = vi.fn();
    const metadata = await fetchProcessMetadata(
      {
        api: {
          sequencer: {
            getMetadata,
          },
        },
      } as any,
      {
        metadataURI: 'https://gateway.example.org/ipfs/bafy-test',
      }
    );

    expect(metadata).toEqual({ title: { default: 'Persisted metadata' } });
    expect(getMetadata).not.toHaveBeenCalled();
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
          metadataURI: 'https://gateway.example.org/ipfs/bafy-test',
        }
      )
    ).resolves.toBeNull();
  });
});
