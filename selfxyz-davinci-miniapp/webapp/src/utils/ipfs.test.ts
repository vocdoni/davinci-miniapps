import { describe, expect, it } from 'vitest';

import {
  buildMetadataFetchCandidates,
  buildPublicIpfsGatewayUrl,
  extractCidFromIpfsUrl,
  normalizeIpfsGatewayBaseUrl,
} from './ipfs';

describe('ipfs helpers', () => {
  it('normalizes gateway base URLs', () => {
    expect(normalizeIpfsGatewayBaseUrl('gateway.pinata.cloud')).toBe('https://gateway.pinata.cloud');
    expect(normalizeIpfsGatewayBaseUrl('https://gateway.pinata.cloud/')).toBe('https://gateway.pinata.cloud');
  });

  it('builds a public gateway URL from a CID', () => {
    expect(buildPublicIpfsGatewayUrl('bafy-test', 'gateway.pinata.cloud')).toBe(
      'https://gateway.pinata.cloud/ipfs/bafy-test'
    );
  });

  it('extracts a CID from ipfs scheme and path-based gateway URLs', () => {
    expect(extractCidFromIpfsUrl('ipfs://bafy-test')).toBe('bafy-test');
    expect(extractCidFromIpfsUrl('https://example-gateway.mypinata.cloud/ipfs/bafy-test')).toBe('bafy-test');
  });

  it('adds a public-gateway fallback candidate when a CID is present', () => {
    expect(
      buildMetadataFetchCandidates('https://example-gateway.mypinata.cloud/ipfs/bafy-test', 'https://gateway.pinata.cloud')
    ).toEqual([
      'https://example-gateway.mypinata.cloud/ipfs/bafy-test',
      'https://gateway.pinata.cloud/ipfs/bafy-test',
    ]);
  });

  it('keeps only the original URL when no CID can be extracted', () => {
    expect(buildMetadataFetchCandidates('https://example.com/metadata.json', 'https://gateway.pinata.cloud')).toEqual([
      'https://example.com/metadata.json',
    ]);
  });
});
