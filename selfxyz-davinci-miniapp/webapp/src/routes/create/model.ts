import type { CreateValues } from '../../lib/occ';
import { isAsciiText, isValidCountryCode, normalizeCountry, normalizeMinAge, normalizeScope, stripNonAscii } from '../../utils/normalization';
import {
  DEFAULT_DURATION_HOURS,
  DEFAULT_MAX_VOTERS,
  DEFAULT_MIN_AGE,
  MAX_NATIONALITIES,
  MAX_OPTIONS,
  MIN_OPTIONS,
  SCOPE_CHARSET,
  SCOPE_RANDOM_LENGTH,
} from './constants';
import type { CreateFormState, CreateOption, CreateOverlayState } from './types';

export type RandomIndexGenerator = (maxExclusive: number) => number;

function ensureAsciiField(value: unknown, label: string): void {
  if (!isAsciiText(value)) {
    throw new Error(`${label} accepts ASCII characters only. Check browser console for technical details.`);
  }
}

function buildBallotFromChoices(numChoices: number): CreateValues['ballot'] {
  const maxValue = Math.max(0, numChoices - 1);
  return {
    numFields: 1,
    groupSize: 1,
    maxValue: String(maxValue),
    minValue: '0',
    uniqueValues: false,
    costExponent: 1,
    maxValueSum: String(maxValue),
    minValueSum: '0',
  };
}

function defaultRandomIndex(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;

  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    const bytes = new Uint32Array(1);
    cryptoRef.getRandomValues(bytes);
    return Number(bytes[0] % maxExclusive);
  }

  return Math.floor(Math.random() * maxExclusive);
}

export function createDefaultOptions(): CreateOption[] {
  return [
    { title: '', value: 0 },
    { title: '', value: 1 },
  ];
}

export function createInitialFormState(): CreateFormState {
  return {
    processTitle: '',
    options: createDefaultOptions(),
    countries: [],
    minAge: DEFAULT_MIN_AGE,
    durationHours: DEFAULT_DURATION_HOURS,
    maxVoters: DEFAULT_MAX_VOTERS,
    listInExplore: true,
  };
}

export function createInitialOverlayState(): CreateOverlayState {
  return { dismissed: false };
}

export function addOption(options: CreateOption[], maxOptions = MAX_OPTIONS): CreateOption[] {
  if (options.length >= maxOptions) return options;
  return [...options, { title: '', value: options.length }];
}

export function removeOption(options: CreateOption[], removeIndex: number, minOptions = MIN_OPTIONS): CreateOption[] {
  if (options.length <= minOptions) return options;
  const filtered = options.filter((_, index) => index !== removeIndex);
  return filtered.map((option, index) => ({ ...option, value: index }));
}

export function updateOption(options: CreateOption[], optionIndex: number, value: string): CreateOption[] {
  return options.map((option, index) => (index === optionIndex ? { ...option, title: stripNonAscii(value) } : option));
}

export function generateScopeSeed(
  countryCode: string,
  minAge: number,
  randomIndex: RandomIndexGenerator = defaultRandomIndex,
  randomLength = SCOPE_RANDOM_LENGTH
): string {
  const country = normalizeCountry(countryCode);
  let randomSuffix = '';

  for (let index = 0; index < randomLength; index += 1) {
    const position = randomIndex(SCOPE_CHARSET.length);
    randomSuffix += SCOPE_CHARSET[position] || SCOPE_CHARSET[0];
  }

  return `${country}_${minAge}_${randomSuffix}`;
}

export function parseOptions(options: CreateOption[]): Array<{ title: string; value: number }> {
  if (options.length > MAX_OPTIONS) {
    throw new Error(`You can add up to ${MAX_OPTIONS} options.`);
  }

  const parsed = options.map((option, index) => {
    const title = String(option.title || '').trim();
    if (!title) {
      throw new Error(`Option ${index + 1} is empty.`);
    }
    ensureAsciiField(title, `Option ${index + 1}`);
    return { title, value: index };
  });

  if (parsed.length < MIN_OPTIONS) {
    throw new Error('Add at least two options.');
  }

  return parsed;
}

export function parseCountries(countries: string[]): string[] {
  const deduped: string[] = [];

  for (const rawCountry of countries) {
    const country = normalizeCountry(rawCountry);
    if (!isValidCountryCode(country)) {
      throw new Error('Each country must use a valid country code.');
    }
    if (!deduped.includes(country)) {
      deduped.push(country);
    }
  }

  if (deduped.length === 0) {
    throw new Error('Please select at least one country.');
  }
  if (deduped.length > MAX_NATIONALITIES) {
    throw new Error(`Select up to ${MAX_NATIONALITIES} countries.`);
  }

  return deduped;
}

export function deriveCreateValuesFromForm(
  form: CreateFormState,
  nowMs = Date.now(),
  randomIndex: RandomIndexGenerator = defaultRandomIndex
): CreateValues {
  const countries = parseCountries(form.countries);
  const country = countries[0] || '';
  const minAge = normalizeMinAge(form.minAge);
  const title = String(form.processTitle || '').trim();
  const maxVoters = Number(form.maxVoters);
  const durationHours = Number(form.durationHours);

  if (!title) {
    throw new Error('Please type your question above.');
  }
  ensureAsciiField(title, 'Question');

  if (!minAge) {
    throw new Error('Minimum age must be between 1 and 99.');
  }
  if (!Number.isFinite(maxVoters) || maxVoters <= 0) {
    throw new Error('Maximum voters must be a positive number.');
  }
  if (!Number.isFinite(durationHours) || durationHours < 1) {
    throw new Error('Duration must be at least 1 hour.');
  }

  const choices = parseOptions(form.options);
  const question = {
    title,
    description: '',
    choices,
  };

  const startDate = new Date(nowMs);
  const scopeSeed = generateScopeSeed(country, minAge, randomIndex);

  if (!normalizeScope(scopeSeed) || scopeSeed.length > 31) {
    throw new Error('Scope seed must contain 1-31 characters.');
  }
  if (!isAsciiText(scopeSeed)) {
    throw new Error('Scope seed must contain ASCII characters only.');
  }

  return {
    countries,
    country,
    minAge,
    scopeSeed,
    title,
    description: '',
    maxVoters: Math.trunc(maxVoters),
    duration: Math.round(durationHours * 3600),
    startDate,
    listInExplore: form.listInExplore !== false,
    question,
    ballot: buildBallotFromChoices(choices.length),
  };
}
