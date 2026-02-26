export function normalizeProcessId(value: unknown): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

export function isValidProcessId(value: unknown): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

export function normalizeCountry(value: unknown): string {
  return String(value || '').trim().toUpperCase();
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
