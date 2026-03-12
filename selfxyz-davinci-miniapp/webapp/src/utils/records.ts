export type UnknownRecord = Record<string, unknown>;

export function toRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null;
}
