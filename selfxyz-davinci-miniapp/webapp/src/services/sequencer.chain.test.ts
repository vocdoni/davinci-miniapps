import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/occ', () => ({
  ACTIVE_NETWORK: { chainId: 42220 },
}));

const sdkInstances: Array<Record<string, unknown>> = [];

vi.mock('@vocdoni/davinci-sdk', () => ({
  DavinciSDK: class MockSdk {
    config: unknown;
    api: { sequencer: { listProcesses: ReturnType<typeof vi.fn> } };
    constructor(config: unknown) {
      this.config = config;
      this.api = {
        sequencer: { listProcesses: vi.fn().mockResolvedValue([]) },
      };
      sdkInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));

let createSequencerSdk: typeof import('./sequencer').createSequencerSdk;
let listProcessesFromSequencer: typeof import('./sequencer').listProcessesFromSequencer;

beforeEach(async () => {
  sdkInstances.length = 0;
  vi.resetModules();
  const globalScope = globalThis as unknown as { Worker?: typeof Worker };
  if (typeof globalScope.Worker === 'undefined') {
    globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
  }
  ({ createSequencerSdk, listProcessesFromSequencer } = await import('./sequencer'));
});

describe('createSequencerSdk', () => {
  it('returns an SDK without awaiting any chain probe when no signer is passed', async () => {
    const sdk = await createSequencerSdk({ sequencerUrl: 'https://seq.example' });
    expect(sdk).toBeDefined();
  });

  it('throws when the signer is on a different chain than ACTIVE_NETWORK.chainId', async () => {
    const signer = {
      provider: {
        getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
      },
    };
    await expect(
      createSequencerSdk({ sequencerUrl: 'https://seq.example', signer: signer as unknown as never })
    ).rejects.toThrow(/chain.*1.*expected.*42220/i);
  });

  it('returns the SDK when the signer is on the configured chain', async () => {
    const signer = {
      provider: {
        getNetwork: vi.fn().mockResolvedValue({ chainId: 42220n }),
      },
    };
    const sdk = await createSequencerSdk({
      sequencerUrl: 'https://seq.example',
      signer: signer as unknown as never,
    });
    expect(sdk).toBeDefined();
    expect(signer.provider.getNetwork).toHaveBeenCalledTimes(1);
  });
});

describe('listProcessesFromSequencer', () => {
  it('forwards the chainId argument to the SDK listProcesses call', async () => {
    const sdk = await createSequencerSdk({ sequencerUrl: 'https://seq.example' });
    const listProcesses = (sdk.api.sequencer as unknown as { listProcesses: ReturnType<typeof vi.fn> }).listProcesses;
    listProcesses.mockResolvedValue([
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    ]);

    const result = await listProcessesFromSequencer(sdk, 42220);

    expect(result).toEqual(['0x1111111111111111111111111111111111111111111111111111111111111111']);
    expect(listProcesses).toHaveBeenCalledWith(42220);
  });

  it('returns [] when listProcesses returns a non-array', async () => {
    const sdk = await createSequencerSdk({ sequencerUrl: 'https://seq.example' });
    const listProcesses = (sdk.api.sequencer as unknown as { listProcesses: ReturnType<typeof vi.fn> }).listProcesses;
    listProcesses.mockResolvedValue(undefined);

    const result = await listProcessesFromSequencer(sdk, 42220);

    expect(result).toEqual([]);
  });
});
