import { beforeEach, describe, expect, it, vi } from 'vitest';

let fetchProcessMetadata: typeof import('./sequencer').fetchProcessMetadata;

describe('fetchProcessMetadata', () => {
  beforeEach(async () => {
    vi.resetModules();
    const globalScope = globalThis as unknown as { Worker?: typeof Worker };
    if (typeof globalScope.Worker === 'undefined') {
      globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
    }

    ({ fetchProcessMetadata } = await import('./sequencer'));
  });

  it('returns embedded process metadata without calling the sequencer metadata endpoint', async () => {
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
        metadataURI: 'ipfs://metadata-hash',
        metadata: { title: { default: 'Embedded metadata' } },
      }
    );

    expect(metadata).toEqual({ title: { default: 'Embedded metadata' } });
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('requests the metadata exactly from the URI returned by the sequencer', async () => {
    const getMetadata = vi.fn().mockResolvedValue({ title: { default: 'Remote metadata' } });

    const metadata = await fetchProcessMetadata(
      {
        api: {
          sequencer: {
            getMetadata,
          },
        },
      } as any,
      {
        metadataURI: 'ipfs://metadata-hash',
      }
    );

    expect(metadata).toEqual({ title: { default: 'Remote metadata' } });
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(getMetadata).toHaveBeenCalledWith('ipfs://metadata-hash');
  });

  it('returns null when the metadata endpoint fails', async () => {
    const getMetadata = vi.fn().mockRejectedValue(new Error('metadata unavailable'));

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
          metadataURI: 'ipfs://metadata-hash',
        }
      )
    ).resolves.toBeNull();
  });
});
