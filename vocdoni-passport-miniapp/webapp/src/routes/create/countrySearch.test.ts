import { describe, expect, it } from 'vitest';

import type { CountryOption } from './constants';
import { searchCountryOptions } from './countrySearch';

describe('countrySearch', () => {
  it('prioritizes exact country code over label-only matches', () => {
    const options: CountryOption[] = [
      { code: 'MEX', label: 'Usa Federation' },
      { code: 'USA', label: 'United States' },
    ];

    const result = searchCountryOptions(options, 'usa');
    expect(result.map((option) => option.code)).toEqual(['USA', 'MEX']);
  });

  it('prioritizes code prefix over code contains', () => {
    const options: CountryOption[] = [
      { code: 'AUS', label: 'Australia' },
      { code: 'RUS', label: 'Rusland' },
      { code: 'USA', label: 'United States' },
    ];

    const result = searchCountryOptions(options, 'us');
    expect(result.map((option) => option.code)).toEqual(['USA', 'AUS', 'RUS']);
  });

  it('returns typo-tolerant matches', () => {
    const options: CountryOption[] = [
      { code: 'USA', label: 'United States' },
      { code: 'GBR', label: 'United Kingdom' },
      { code: 'ESP', label: 'Spain' },
    ];

    const result = searchCountryOptions(options, 'unted sttes');
    expect(result[0]?.code).toBe('USA');
  });

  it('matches labels ignoring diacritics', () => {
    const options: CountryOption[] = [
      { code: 'CIV', label: "Côte d'Ivoire" },
      { code: 'ESP', label: 'Spain' },
    ];

    const result = searchCountryOptions(options, 'cote');
    expect(result[0]?.code).toBe('CIV');
  });

  it('keeps stable alphabetical ordering for ties', () => {
    const options: CountryOption[] = [
      { code: 'BBB', label: 'Aay' },
      { code: 'AAA', label: 'Aax' },
    ];

    const result = searchCountryOptions(options, 'aa');
    expect(result.map((option) => option.code)).toEqual(['AAA', 'BBB']);
  });
});
