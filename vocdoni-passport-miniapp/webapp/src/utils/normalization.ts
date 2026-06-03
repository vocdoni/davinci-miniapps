export function normalizeProcessId(value: unknown): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

export function isValidProcessId(value: unknown): boolean {
  return /^0x[a-fA-F0-9]{62}$/.test(String(value || '').trim());
}

export function normalizeCountry(value: unknown): string {
  const normalized = String(value || '').trim().toUpperCase();
  // Canonicalize Germany to the Self SDK special code used in passport flows.
  if (normalized === 'DEU') {
    return 'D<<';
  }
  // German passports can use D<< (or variants with <); collapse to the canonical token.
  if (normalized.startsWith('D') && normalized.includes('<')) {
    return 'D<<';
  }
  return normalized;
}

export function isValidCountryCode(value: unknown): boolean {
  const normalized = normalizeCountry(value);
  return normalized === 'D<<' || /^[A-Z]{2,3}$/.test(normalized);
}

export function normalizeScope(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeMinAge(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0 || normalized > 99) return null;
  return normalized;
}

export function isAsciiText(value: unknown): boolean {
  return /^[\x00-\x7F]*$/.test(String(value || ''));
}

export function stripNonAscii(value: unknown): string {
  return String(value || '').replace(/[^\x00-\x7F]/g, '');
}
