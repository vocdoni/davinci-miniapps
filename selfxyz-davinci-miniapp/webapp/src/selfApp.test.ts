import { describe, expect, it } from 'vitest';

import { buildPassportPayload, buildPassportDeepLink, buildPassportQRUrl } from './passportRequest';

describe('passportRequest utilities', () => {
  const backendUrl = 'https://passport.example.com';

  it('builds a payload with age and nationality query', () => {
    const payload = buildPassportPayload({
      backendUrl,
      processId: '0xabc',
      censusContract: '0xdef',
      scope: 'davinci-census',
      minAge: 18,
      countries: ['ESP', 'FRA'],
    });

    expect(payload.kind).toBe('vocdoni-passport-request');
    expect(payload.version).toBe(1);
    expect(payload.aggregateUrl).toBe('https://passport.example.com/api/proofs/aggregate');
    expect(payload.processId).toBe('0xabc');
    expect(payload.censusContract).toBe('0xdef');
    expect(payload.query?.['age']).toEqual({ gte: 18 });
    expect((payload.query?.['nationality'] as { in: string[] }).in).toEqual(['ESP', 'FRA']);
  });

  it('omits query when no age or countries', () => {
    const payload = buildPassportPayload({ backendUrl, scope: 'davinci-census' });
    expect(payload.query).toBeUndefined();
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
