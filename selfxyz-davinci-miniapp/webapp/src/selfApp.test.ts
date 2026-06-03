import { describe, expect, it } from 'vitest';

import { getUniversalLink } from './selfApp';

describe('selfApp utilities', () => {
  it('creates a deep link for self app payloads', () => {
    const selfApp = {
      sessionId: 'session-123',
      endpointType: 'staging_celo',
      scope: 'open-citizen-census',
    };
    const universal = getUniversalLink(selfApp);

    expect(universal).toContain('https://redirect.self.xyz?selfApp=');
    expect(universal).toContain(encodeURIComponent(JSON.stringify(selfApp)));
  });
});
