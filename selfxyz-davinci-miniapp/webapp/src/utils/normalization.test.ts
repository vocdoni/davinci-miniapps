import { describe, expect, it } from 'vitest';

import {
  isValidCountryCode,
  isAsciiText,
  isValidProcessId,
  normalizeCountry,
  normalizeMinAge,
  normalizeProcessId,
  normalizeScope,
  stripNonAscii,
} from './normalization';

describe('normalization utils', () => {
  it('normalizes and validates process ids', () => {
    const raw = 'ab'.repeat(32);
    const normalized = normalizeProcessId(raw);

    expect(normalized).toBe(`0x${raw}`);
    expect(isValidProcessId(normalized)).toBe(true);
    expect(isValidProcessId('0x1234')).toBe(false);
  });

  it('normalizes country and scope', () => {
    expect(normalizeCountry(' es ')).toBe('ES');
    expect(normalizeCountry(' d<< ')).toBe('D<<');
    expect(normalizeCountry('deu')).toBe('D<<');
    expect(normalizeScope('  scoped  ')).toBe('scoped');
  });

  it('validates country codes including Germany special case', () => {
    expect(isValidCountryCode('USA')).toBe(true);
    expect(isValidCountryCode('d<<')).toBe(true);
    expect(isValidCountryCode('DEU')).toBe(true);
    expect(isValidCountryCode('USAA')).toBe(false);
  });

  it('normalizes min age with limits', () => {
    expect(normalizeMinAge('18')).toBe(18);
    expect(normalizeMinAge(0)).toBeNull();
    expect(normalizeMinAge(120)).toBeNull();
  });

  it('handles ascii sanitization', () => {
    expect(isAsciiText('abc123')).toBe(true);
    expect(isAsciiText('á')).toBe(false);
    expect(stripNonAscii('Año 2026')).toBe('Ao 2026');
  });
});
