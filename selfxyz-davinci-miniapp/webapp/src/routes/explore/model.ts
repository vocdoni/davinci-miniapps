import { ProcessStatus } from '@vocdoni/davinci-sdk';
import { COPY } from '../../copy';

import {
  extractProcessEndDateMs,
  extractVoteContextFromMetadata,
  formatRemainingTimeFromEndMs,
  getLocalizedText,
  getProcessStatusInfo,
  hasProcessEndedByTime,
  normalizeProcessStatus,
  normalizeVoteQuestions,
} from '../../lib/occ';
import { normalizeProcessId } from '../../utils/normalization';
import { toDateFromUnknown } from '../../utils/timing';
import type { ExploreFilterResult, ExplorePageState, ExploreProcessRow } from './types';

export interface MapExploreRowInput {
  processId: string;
  process: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  buildVoteHref: (processId: string) => string;
}

export interface ExploreScanResult<T> {
  items: T[];
  nextCursor: number;
  hasMore: boolean;
}

export interface ExploreScanOptions<T> {
  processIds: string[];
  cursor: number;
  targetMatches: number;
  chunkSize: number;
  concurrency: number;
  mapProcessId: (processId: string) => Promise<T | null>;
}

export interface ExploreStartTimeEntry {
  processId: string;
  startTimeMs: number;
}

export const DEFAULT_EXPLORE_PAGE_STATE: ExplorePageState = {
  loading: true,
  refreshing: false,
  error: '',
  rows: [],
  nextCursor: 0,
  hasMore: false,
  allProcessIds: [],
};

function readSelfConfig(metadata: Record<string, unknown> | null): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const rawMeta = metadata.meta;
  if (!rawMeta || typeof rawMeta !== 'object') return {};
  const selfConfig = (rawMeta as Record<string, unknown>).selfConfig;
  if (!selfConfig || typeof selfConfig !== 'object') return {};
  return selfConfig as Record<string, unknown>;
}

function isAsciiSafe(value: string): boolean {
  return /^[\x00-\x7F]+$/.test(value);
}

export function isExploreEligibleMetadata(metadata: Record<string, unknown> | null): ExploreFilterResult {
  const selfConfig = readSelfConfig(metadata);
  const rawScope = selfConfig.scope ?? selfConfig.scopeSeed;
  const scopeProvided = rawScope !== undefined && rawScope !== null && String(rawScope).trim() !== '';
  if (!scopeProvided) {
    return { accepted: false, reason: 'missing_scope' };
  }

  const context = extractVoteContextFromMetadata(metadata as Record<string, any> | null);
  if (!context.scopeSeed || !isAsciiSafe(context.scopeSeed)) {
    return { accepted: false, reason: 'invalid_scope' };
  }

  const rawMinAge = selfConfig.minAge;
  const minAgeProvided = rawMinAge !== undefined && rawMinAge !== null && String(rawMinAge).trim() !== '';
  if (!minAgeProvided) {
    return { accepted: false, reason: 'missing_min_age' };
  }
  if (!Number.isInteger(context.minAge) || Number(context.minAge) < 1 || Number(context.minAge) > 99) {
    return { accepted: false, reason: 'invalid_min_age' };
  }

  if (!Array.isArray(context.countries) || context.countries.length < 1) {
    return { accepted: false, reason: 'missing_countries' };
  }

  return { accepted: true, reason: 'ok' };
}

export function extractProcessStartTimeMs(process: Record<string, unknown> | null): number {
  if (!process) return 0;
  const candidates = [
    process.startTime,
    process.startDate,
    process.startsAt,
    (process.timing as Record<string, unknown> | undefined)?.startTime,
    (process.timing as Record<string, unknown> | undefined)?.startDate,
    (process.timing as Record<string, unknown> | undefined)?.startsAt,
  ];
  for (const candidate of candidates) {
    const date = toDateFromUnknown(candidate);
    if (date) return date.getTime();
  }
  return 0;
}

export function sortProcessIdsNewestFirst(entries: ExploreStartTimeEntry[]): string[] {
  return [...entries]
    .sort((left, right) => right.startTimeMs - left.startTimeMs || left.processId.localeCompare(right.processId))
    .map((entry) => entry.processId);
}

export function mapExploreProcessRow(input: MapExploreRowInput): ExploreProcessRow | null {
  const normalizedProcessId = normalizeProcessId(input.processId);
  if (!normalizedProcessId) return null;

  const filter = isExploreEligibleMetadata(input.metadata);
  if (!filter.accepted) return null;

  const metadata = input.metadata as Record<string, unknown> | null;
  const context = extractVoteContextFromMetadata(metadata as Record<string, any> | null);
  const endDateMs = extractProcessEndDateMs(input.process as Record<string, any> | null, metadata as Record<string, any> | null);

  const rawStatusCode = normalizeProcessStatus((input.process as Record<string, unknown> | null)?.status ?? null);
  const statusCode =
    rawStatusCode === ProcessStatus.READY && hasProcessEndedByTime(endDateMs) ? ProcessStatus.ENDED : rawStatusCode;
  const statusLabel = getProcessStatusInfo(statusCode)?.label || COPY.shared.unknown;
  const readyTimeRemainingLabel = statusCode === ProcessStatus.READY ? formatRemainingTimeFromEndMs(endDateMs) : '-';

  const questionTitle =
    String(normalizeVoteQuestions((metadata as Record<string, unknown> | null)?.questions || [])[0]?.title || '').trim() ||
    String(getLocalizedText((metadata as Record<string, unknown> | null)?.title) || '').trim() ||
    normalizedProcessId;

  return {
    processId: normalizedProcessId,
    questionTitle,
    statusCode,
    statusLabel,
    countries: context.countries,
    minAge: Number(context.minAge || 0),
    endDateMs,
    readyTimeRemainingLabel,
    voteHref: input.buildVoteHref(normalizedProcessId),
    startTimeMs: extractProcessStartTimeMs(input.process),
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const safeConcurrency = Math.max(1, Math.trunc(concurrency));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  };

  const workers = Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function collectExploreMatches<T>(options: ExploreScanOptions<T>): Promise<ExploreScanResult<T>> {
  const processIds = Array.isArray(options.processIds) ? options.processIds : [];
  const targetMatches = Math.max(1, Math.trunc(options.targetMatches || 0));
  const chunkSize = Math.max(1, Math.trunc(options.chunkSize || 0));
  const concurrency = Math.max(1, Math.trunc(options.concurrency || 0));

  let cursor = Math.max(0, Math.trunc(options.cursor || 0));
  const items: T[] = [];

  while (items.length < targetMatches && cursor < processIds.length) {
    const batch = processIds.slice(cursor, cursor + chunkSize);
    cursor += batch.length;

    const mapped = await mapWithConcurrency(batch, concurrency, options.mapProcessId);
    for (const entry of mapped) {
      if (entry === null || entry === undefined) continue;
      items.push(entry);
      if (items.length >= targetMatches) break;
    }
  }

  return {
    items,
    nextCursor: cursor,
    hasMore: cursor < processIds.length,
  };
}
