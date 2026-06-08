import { describe, expect, it } from 'vitest';

import { buildPassportPayload, buildPassportDeepLink, buildPassportQRUrl } from './passportRequest';

describe('passportRequest utilities', () => {
  const backendUrl = 'https://passport.example.com';

  it('builds a payload with all fields', () => {
    const payload = buildPassportPayload({
      backendUrl,
      processId: '0xabc',
      censusContract: '0xdef',
      walletAddress: '0x1234',
      bindChain: 'ethereum_sepolia',
      scope: 'davinci-census',
      appName: 'Test App',
    });

    expect(payload.kind).toBe('vocdoni-passport-request');
    expect(payload.version).toBe(1);
    expect(payload.aggregateUrl).toBe('https://passport.example.com/api/proofs/aggregate');
    expect(payload.processId).toBe('0xabc');
    expect(payload.censusContract).toBe('0xdef');
    expect(payload.walletAddress).toBe('0x1234');
    expect(payload.bindChain).toBe('ethereum_sepolia');
    expect(payload.query).toBeUndefined();
  });

  it('omits optional fields when not provided', () => {
    const payload = buildPassportPayload({ backendUrl, scope: 'davinci-census' });
    expect(payload.query).toBeUndefined();
    expect(payload.bindChain).toBeUndefined();
  });

  it('builds a QR image URL', () => {
    const payload = buildPassportPayload({ backendUrl, scope: 'davinci-census' });
    const qrUrl = buildPassportQRUrl(backendUrl, payload);
    expect(qrUrl).toContain('/api/request-qr.png?payload=');
  });

  it('builds a deep link URL', () => {
    const payload = buildPassportPayload({ backendUrl, scope: 'davinci-census' });
    const link = buildPassportDeepLink(backendUrl, payload);
    expect(link).toContain('/passport?request=');
  });

  it('strips trailing slashes from backendUrl', () => {
    const payload = buildPassportPayload({ backendUrl: 'https://example.com///', scope: 'davinci-census' });
    expect(payload.aggregateUrl).toBe('https://example.com/api/proofs/aggregate');
  });
});
