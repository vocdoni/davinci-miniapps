import { describe, expect, it } from 'vitest';

import { buildSelfApp, getQrLink, getUniversalLink } from './selfApp';

describe('selfApp utilities', () => {
  it('builds a self app payload and normalizes hex user id', () => {
    const selfApp = buildSelfApp({
      appName: 'Ask The World - DAVINCI',
      scope: 'open-citizen-census',
      endpoint: '0x2E6C3D4ED7dA2bAD613A3Ea30961db7bF8452b29',
      endpointType: 'celo',
      userId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userIdType: 'hex',
      disclosures: {
        minimumAge: 18,
        nationality: true,
      },
    });

    expect(selfApp.userId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(selfApp.chainID).toBe(42220);
    expect(selfApp.sessionId).toBeTruthy();
  });

  it('creates deep links for self app payloads', () => {
    const selfApp = buildSelfApp({
      appName: 'Ask The World - DAVINCI',
      scope: 'open-citizen-census',
      endpoint: '0x2E6C3D4ED7dA2bAD613A3Ea30961db7bF8452b29',
      endpointType: 'staging_celo',
      userId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userIdType: 'hex',
    });

    const universal = getUniversalLink(selfApp);
    const qr = getQrLink(selfApp);

    expect(universal).toContain('https://redirect.self.xyz?selfApp=');
    expect(qr).toContain(`https://redirect.self.xyz?sessionId=${encodeURIComponent(selfApp.sessionId)}`);
  });
});
