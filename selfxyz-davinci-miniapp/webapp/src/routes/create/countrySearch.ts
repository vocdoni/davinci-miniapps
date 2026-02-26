import type { CountryOption } from './constants';

interface RankedCountryOption {
  option: CountryOption;
  tier: number;
  editDistance: number;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let col = 1; col <= b.length; col += 1) {
      const substitution = previous[col - 1] + (a[row - 1] === b[col - 1] ? 0 : 1);
      const insertion = current[col - 1] + 1;
      const deletion = previous[col] + 1;
      current[col] = Math.min(substitution, insertion, deletion);
    }
    for (let col = 0; col <= b.length; col += 1) {
      previous[col] = current[col] as number;
    }
  }

  return previous[b.length] as number;
}

function isSubsequence(query: string, value: string): boolean {
  if (!query.length) return true;
  let pointer = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === query[pointer]) {
      pointer += 1;
      if (pointer >= query.length) return true;
    }
  }
  return false;
}

function buildRankedCountryOption(option: CountryOption, query: string): RankedCountryOption | null {
  const normalizedCode = normalizeSearchText(option.code);
  const normalizedLabel = normalizeSearchText(option.label);

  if (normalizedCode === query) {
    return { option, tier: 1, editDistance: 0 };
  }
  if (normalizedCode.startsWith(query)) {
    return { option, tier: 2, editDistance: normalizedCode.length - query.length };
  }
  if (normalizedCode.includes(query)) {
    return { option, tier: 3, editDistance: normalizedCode.length - query.length };
  }
  if (normalizedLabel === query) {
    return { option, tier: 4, editDistance: 0 };
  }
  if (normalizedLabel.startsWith(query)) {
    return { option, tier: 5, editDistance: normalizedLabel.length - query.length };
  }
  if (normalizedLabel.includes(query)) {
    return { option, tier: 6, editDistance: normalizedLabel.length - query.length };
  }

  const labelParts = normalizedLabel.split(/[\s'()-]+/g).filter(Boolean);
  const candidates = [normalizedCode, normalizedLabel, ...labelParts];
  const bestDistance = candidates.reduce((minimum, candidate) => {
    const distance = levenshteinDistance(query, candidate);
    return Math.min(minimum, distance);
  }, Number.POSITIVE_INFINITY);

  const maxTypos = Math.max(1, Math.floor(query.length / 3));
  const subsequenceMatch = isSubsequence(query, normalizedCode) || isSubsequence(query, normalizedLabel);
  if (subsequenceMatch || bestDistance <= maxTypos) {
    return { option, tier: 7, editDistance: bestDistance };
  }

  return null;
}

export function searchCountryOptions(options: CountryOption[], queryValue: string): CountryOption[] {
  const query = normalizeSearchText(queryValue);
  if (!query) {
    return options;
  }

  const ranked: RankedCountryOption[] = [];
  for (const option of options) {
    const entry = buildRankedCountryOption(option, query);
    if (entry) ranked.push(entry);
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.editDistance !== b.editDistance) return a.editDistance - b.editDistance;

    const labelOrder = a.option.label.localeCompare(b.option.label, undefined, { sensitivity: 'base' });
    if (labelOrder !== 0) return labelOrder;
    return a.option.code.localeCompare(b.option.code, undefined, { sensitivity: 'base' });
  });

  return ranked.map((entry) => entry.option);
}

export const countrySearchInternal = {
  normalizeSearchText,
  levenshteinDistance,
  isSubsequence,
  buildRankedCountryOption,
};
