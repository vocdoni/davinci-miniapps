import type { SequencerMetadata, SequencerProcess } from '../services/sequencer';
import { toRecord } from './records';

export function toDateFromUnknown(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;

    const asMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const fromMs = new Date(asMs);
    return Number.isNaN(fromMs.getTime()) ? null : fromMs;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      const asMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      const numericDate = new Date(asMs);
      if (!Number.isNaN(numericDate.getTime())) return numericDate;
    }

    const parsedDate = new Date(trimmed);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  return null;
}

export function toDurationMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  let parsed: number | null = null;
  if (typeof value === 'bigint') {
    parsed = Number(value);
  } else if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    parsed = Number(value.trim());
  }

  if (parsed === null || !Number.isFinite(parsed) || parsed <= 0) return null;
  // Sequencer duration values are provided in nanoseconds (for example, 1h = 3_600_000_000_000).
  // Treat this range as nanoseconds to avoid inflating short durations in the vote UI.
  if (parsed >= 1_000_000_000_000) return parsed / 1_000_000;
  if (parsed >= 10_000_000_000) return parsed / 1_000;
  if (parsed >= 10_000_000) return parsed;
  return parsed * 1000;
}

export function toRfc3339Timestamp(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid date provided for RFC3339 conversion.');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function computeExpiresAtFromStartAndDuration(startDate: Date, durationSeconds: number): string {
  if (Number.isNaN(startDate.getTime()) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Cannot compute expiration timestamp from process timing.');
  }

  const expiresAt = new Date(startDate.getTime() + Math.round(durationSeconds * 1000));
  return toRfc3339Timestamp(expiresAt);
}

export function extractProcessEndDateMs(
  process: SequencerProcess | null,
  metadata: SequencerMetadata | null
): number | null {
  const processTiming = toRecord(process?.timing);
  const metadataTiming = toRecord(metadata?.timing);
  const endCandidates = [
    processTiming?.endDate,
    processTiming?.endTime,
    processTiming?.endsAt,
    process?.endDate,
    process?.endTime,
    process?.endsAt,
    metadataTiming?.endDate,
    metadataTiming?.endTime,
    metadataTiming?.endsAt,
    metadata?.endDate,
    metadata?.endTime,
    metadata?.endsAt,
  ];

  for (const candidate of endCandidates) {
    const parsed = toDateFromUnknown(candidate);
    if (parsed) return parsed.getTime();
  }

  const startCandidates = [
    processTiming?.startDate,
    processTiming?.startTime,
    processTiming?.startsAt,
    process?.startDate,
    process?.startTime,
    process?.startsAt,
    metadataTiming?.startDate,
    metadataTiming?.startTime,
    metadataTiming?.startsAt,
    metadata?.startDate,
    metadata?.startTime,
    metadata?.startsAt,
  ];

  const durationCandidates = [
    processTiming?.duration,
    processTiming?.durationSeconds,
    processTiming?.durationMs,
    process?.duration,
    process?.durationSeconds,
    process?.durationMs,
    metadataTiming?.duration,
    metadataTiming?.durationSeconds,
    metadataTiming?.durationMs,
    metadata?.duration,
    metadata?.durationSeconds,
    metadata?.durationMs,
  ];

  for (const startCandidate of startCandidates) {
    const startDate = toDateFromUnknown(startCandidate);
    if (!startDate) continue;
    for (const durationCandidate of durationCandidates) {
      const durationMs = toDurationMs(durationCandidate);
      if (!durationMs) continue;
      return startDate.getTime() + durationMs;
    }
  }

  return null;
}
