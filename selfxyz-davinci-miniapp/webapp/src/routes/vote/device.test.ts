import { describe, expect, it } from 'vitest';

import { detectRegistrationMobileMode, isRegistrationMobileMode } from './device';

describe('vote device detection', () => {
  it('detects mobile mode using viewport width and pointer capability', () => {
    expect(isRegistrationMobileMode(860, false)).toBe(true);
    expect(isRegistrationMobileMode(1024, true)).toBe(true);
    expect(isRegistrationMobileMode(1024, false)).toBe(false);
  });

  it('detects mobile mode from matchMedia checks', () => {
    const desktop = detectRegistrationMobileMode({
      innerWidth: 1200,
      matchMedia: (query: string) => ({ matches: query.includes('max-width') ? false : false }),
    });
    const mobile = detectRegistrationMobileMode({
      innerWidth: 1200,
      matchMedia: (query: string) => ({ matches: query.includes('pointer: coarse') }),
    });

    expect(desktop).toBe(false);
    expect(mobile).toBe(true);
  });
});
