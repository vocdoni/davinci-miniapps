import { isValidCountryCode, normalizeCountry, stripNonAscii } from '../../utils/normalization';
import { DEFAULT_DURATION_HOURS, DEFAULT_MAX_VOTERS, DEFAULT_MIN_AGE, MAX_NATIONALITIES, MAX_OPTIONS, MIN_OPTIONS } from './constants';
import { createDefaultOptions, createInitialFormState } from './model';
import type { CreateFormState, CreateOption } from './types';

const CREATE_FORM_DRAFT_STORAGE_KEY = 'occ.createFormDraft.v1';

function toInputString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function normalizeDraftOptions(rawOptions: unknown): CreateOption[] {
  if (!Array.isArray(rawOptions)) {
    return createDefaultOptions();
  }

  const normalized = rawOptions
    .slice(0, MAX_OPTIONS)
    .map((option, index) => ({
      title: stripNonAscii((option && typeof option === 'object' && 'title' in option ? String(option.title || '') : '').slice(0)),
      value: index,
    }));

  while (normalized.length < MIN_OPTIONS) {
    normalized.push({ title: '', value: normalized.length });
  }

  return normalized;
}

function normalizeDraftCountries(rawCountries: unknown): string[] {
  if (!Array.isArray(rawCountries)) return [];

  const normalized: string[] = [];
  for (const rawCountry of rawCountries) {
    const country = normalizeCountry(rawCountry);
    if (!isValidCountryCode(country)) continue;
    if (normalized.includes(country)) continue;
    normalized.push(country);
    if (normalized.length >= MAX_NATIONALITIES) break;
  }

  return normalized;
}

function normalizeCreateFormDraft(raw: unknown): CreateFormState | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  return {
    processTitle: stripNonAscii(String(record.processTitle || '')),
    options: normalizeDraftOptions(record.options),
    countries: normalizeDraftCountries(record.countries),
    minAge: toInputString(record.minAge, DEFAULT_MIN_AGE),
    durationHours: toInputString(record.durationHours, DEFAULT_DURATION_HOURS),
    maxVoters: toInputString(record.maxVoters, DEFAULT_MAX_VOTERS),
    listInExplore: record.listInExplore !== false,
  };
}

export function hasCreateFormDraftProgress(form: CreateFormState): boolean {
  const initial = createInitialFormState();

  if (String(form.processTitle || '').trim()) return true;
  if (form.options.length !== initial.options.length) return true;
  if (form.options.some((option) => String(option?.title || '').trim())) return true;
  if (form.countries.length > 0) return true;
  if (String(form.minAge || '') !== initial.minAge) return true;
  if (String(form.durationHours || '') !== initial.durationHours) return true;
  if (String(form.maxVoters || '') !== initial.maxVoters) return true;
  if (Boolean(form.listInExplore) !== initial.listInExplore) return true;

  return false;
}

export function persistCreateFormDraft(form: CreateFormState): void {
  if (!hasCreateFormDraftProgress(form)) {
    clearCreateFormDraft();
    return;
  }

  try {
    localStorage.setItem(
      CREATE_FORM_DRAFT_STORAGE_KEY,
      JSON.stringify({
        ...form,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Ignore storage errors.
  }
}

export function loadCreateFormDraft(): CreateFormState | null {
  try {
    const raw = localStorage.getItem(CREATE_FORM_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const draft = normalizeCreateFormDraft(parsed);
    return draft && hasCreateFormDraftProgress(draft) ? draft : null;
  } catch {
    return null;
  }
}

export function clearCreateFormDraft(): void {
  try {
    localStorage.removeItem(CREATE_FORM_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}
