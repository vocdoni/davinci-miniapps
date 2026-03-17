import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pinataState = vi.hoisted(() => ({
  uploadJson: vi.fn(),
  constructorArgs: [] as unknown[],
}));

vi.mock('pinata', () => ({
  PinataSDK: class MockPinataSDK {
    upload = {
      public: {
        json: (metadata: unknown) => pinataState.uploadJson(metadata),
      },
    };

    constructor(config: unknown) {
      pinataState.constructorArgs.push(config);
    }
  },
}));

let convertCidToPinataGatewayUrl: typeof import('./pinata').convertCidToPinataGatewayUrl;
let normalizePinataGatewayUrl: typeof import('./pinata').normalizePinataGatewayUrl;
let resolvePinataConfig: typeof import('./pinata').resolvePinataConfig;
let uploadElectionMetadata: typeof import('./pinata').uploadElectionMetadata;

describe('pinata service', () => {
  beforeAll(async () => {
    const globalScope = globalThis as unknown as { Worker?: typeof Worker };
    if (typeof globalScope.Worker === 'undefined') {
      globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
    }

    ({ convertCidToPinataGatewayUrl, normalizePinataGatewayUrl, resolvePinataConfig, uploadElectionMetadata } =
      await import('./pinata'));
  });

  beforeEach(() => {
    pinataState.uploadJson.mockReset();
    pinataState.constructorArgs.length = 0;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes gateway values to host-only format', () => {
    expect(normalizePinataGatewayUrl('https://gateway.example.mypinata.cloud/')).toBe(
      'gateway.example.mypinata.cloud'
    );
    expect(normalizePinataGatewayUrl('gateway.example.mypinata.cloud///')).toBe('gateway.example.mypinata.cloud');
  });

  it('requires a Pinata JWT', () => {
    vi.stubEnv('VITE_PINATA_JWT', '');
    vi.stubEnv('VITE_PINATA_GATEWAY_URL', 'gateway.example.mypinata.cloud');

    expect(() => resolvePinataConfig()).toThrow('Missing VITE_PINATA_JWT.');
  });

  it('requires a Pinata gateway URL', () => {
    vi.stubEnv('VITE_PINATA_JWT', 'pinata-jwt');
    vi.stubEnv('VITE_PINATA_GATEWAY_URL', '');

    expect(() => resolvePinataConfig()).toThrow('Missing VITE_PINATA_GATEWAY_URL.');
  });

  it('builds the final HTTP metadata URL from the returned CID', async () => {
    pinataState.uploadJson.mockResolvedValue({ cid: 'bafy-metadata' });

    await expect(
      uploadElectionMetadata(
        { title: { default: 'Question' } } as any,
        {
          pinataJwt: 'pinata-jwt',
          pinataGatewayUrl: 'https://gateway.example.mypinata.cloud/',
          pinataPublicGatewayUrl: 'https://gateway.pinata.cloud',
          pinataUploadUrl: '/pinata-upload',
        }
      )
    ).resolves.toBe('https://gateway.pinata.cloud/ipfs/bafy-metadata');

    expect(pinataState.constructorArgs).toEqual([
      {
        pinataJwt: 'pinata-jwt',
        pinataGateway: 'gateway.example.mypinata.cloud',
        uploadUrl: '/pinata-upload',
      },
    ]);
    expect(pinataState.uploadJson).toHaveBeenCalledTimes(1);
  });

  it('builds a gateway URL directly from the CID', () => {
    const url = convertCidToPinataGatewayUrl('bafy-metadata', 'gateway.example.mypinata.cloud');

    expect(url).toBe('https://gateway.example.mypinata.cloud/ipfs/bafy-metadata');
  });

  it('surfaces upload failures with a Pinata-specific error', async () => {
    pinataState.uploadJson.mockRejectedValue(new Error('upstream failed'));

    await expect(
      uploadElectionMetadata(
        { title: { default: 'Question' } } as any,
        {
          pinataJwt: 'pinata-jwt',
          pinataGatewayUrl: 'gateway.example.mypinata.cloud',
          pinataPublicGatewayUrl: 'https://gateway.pinata.cloud',
          pinataUploadUrl: '/pinata-upload',
        }
      )
    ).rejects.toThrow('Pinata metadata upload failed. upstream failed');
  });
});
