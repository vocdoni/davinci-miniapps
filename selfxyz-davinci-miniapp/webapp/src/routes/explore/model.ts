import { ProcessStatus } from '@vocdoni/davinci-sdk';
import { COPY } from '../../copy';
import type { SequencerMetadata, SequencerProcess } from '../../services/sequencer';

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
import { toRecord } from '../../utils/records';
import { toDateFromUnknown } from '../../utils/timing';
import type { ExploreFilterResult, ExplorePageState, ExploreProcessRow } from './types';

export interface MapExploreRowInput {
  processId: string;
  process: SequencerProcess | null;
  metadata: SequencerMetadata | null;
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

function readSelfConfig(metadata: SequencerMetadata | null): Record<string, unknown> {
  const rawMeta = toRecord(metadata?.meta);
  const selfConfig = toRecord(rawMeta?.selfConfig);
  return selfConfig || {};
}

function readProcessMeta(metadata: SequencerMetadata | null): Record<string, unknown> {
  return toRecord(metadata?.meta) || {};
}

function isAsciiSafe(value: string): boolean {
  return /^[\x00-\x7F]+$/.test(value);
}

function isTruthyMetadataFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  if (typeof value === 'number') return value === 1;
  return false;
}

export function isExploreEligibleMetadata(metadata: SequencerMetadata | null): ExploreFilterResult {
  const rawMeta = readProcessMeta(metadata);
  if (!isTruthyMetadataFlag(rawMeta.listInExplore)) {
    return { accepted: false, reason: 'not_listed' };
  }

  const selfConfig = readSelfConfig(metadata);
  const rawScope = selfConfig.scope ?? selfConfig.scopeSeed;
  const scopeProvided = rawScope !== undefined && rawScope !== null && String(rawScope).trim() !== '';
  if (!scopeProvided) {
    return { accepted: false, reason: 'missing_scope' };
  }

  const context = extractVoteContextFromMetadata(metadata);
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

export function extractProcessStartTimeMs(process: SequencerProcess | null): number {
  if (!process) return 0;
  const timing = toRecord(process.timing);
  const candidates = [
    process.startTime,
    process.startDate,
    process.startsAt,
    timing?.startTime,
    timing?.startDate,
    timing?.startsAt,
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

  const metadata = input.metadata;
  const context = extractVoteContextFromMetadata(metadata);
  const endDateMs = extractProcessEndDateMs(input.process, metadata);

  const rawStatusCode = normalizeProcessStatus(input.process?.status ?? null);
  const statusCode =
    rawStatusCode === ProcessStatus.READY && hasProcessEndedByTime(endDateMs) ? ProcessStatus.ENDED : rawStatusCode;
  const statusLabel = getProcessStatusInfo(statusCode)?.label || COPY.shared.unknown;
  const readyTimeRemainingLabel = statusCode === ProcessStatus.READY ? formatRemainingTimeFromEndMs(endDateMs) : '-';

  const questionTitle =
    String(normalizeVoteQuestions(metadata?.questions || [])[0]?.title || '').trim() ||
    String(getLocalizedText(metadata?.title) || '').trim() ||
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
