import { DavinciSDK } from '@vocdoni/davinci-sdk';
import type { ElectionMetadata, GetProcessResponse } from '@vocdoni/davinci-sdk';

import { normalizeProcessId } from '../utils/normalization';

const METADATA_CACHE_STORAGE_PREFIX = 'sequencer.metadata.v1:';
const METADATA_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_PUBLIC_IPFS_GATEWAY_URL = 'https://ipfs.io';

interface SequencerWeightResponse {
  weight: string | number | bigint;
}

interface LegacyMetadataUriCarrier {
  metadataUri?: string;
}

export type SequencerMetadata = Partial<ElectionMetadata> & Record<string, unknown>;

export type SequencerProcess = Partial<GetProcessResponse> &
  Record<string, unknown> &
  LegacyMetadataUriCarrier & {
    metadata?: SequencerMetadata | null;
    title?: unknown;
    description?: unknown;
  };

type LegacySequencerApi = DavinciSDK['api']['sequencer'] & {
  getProcessAddressWeight?: (processId: string, address: string) => Promise<string | number | bigint | SequencerWeightResponse>;
};

const metadataCache = new Map<string, SequencerMetadata>();
const metadataInFlightRequests = new Map<string, Promise<SequencerMetadata | null>>();
const metadataRateLimitCooldowns = new Map<string, number>();

function sanitizeCidSegment(value: string): string {
  return String(value || '').trim().split(/[/?#]/, 1)[0] || '';
}

function normalizeIpfsGatewayBaseUrl(value: string): string {
  const trimmed = String(value || '').trim();
  const normalized = trimmed || DEFAULT_PUBLIC_IPFS_GATEWAY_URL;
  const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  return withProtocol.replace(/\/+$/, '');
}

function buildPublicIpfsGatewayUrl(cid: string, gatewayBaseUrl?: string): string {
  const safeCid = sanitizeCidSegment(cid);
  return `${normalizeIpfsGatewayBaseUrl(gatewayBaseUrl || DEFAULT_PUBLIC_IPFS_GATEWAY_URL)}/ipfs/${safeCid}`;
}

function extractCidFromIpfsUrl(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('ipfs://')) {
    return sanitizeCidSegment(trimmed.slice('ipfs://'.length));
  }

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    const ipfsIndex = segments.findIndex((segment) => segment === 'ipfs');
    if (ipfsIndex >= 0 && segments[ipfsIndex + 1]) {
      return sanitizeCidSegment(segments[ipfsIndex + 1]);
    }

    const hostMatch = url.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
    if (hostMatch?.[1]) {
      return sanitizeCidSegment(hostMatch[1]);
    }
  } catch {
    return '';
  }

  return '';
}

function buildMetadataFetchCandidates(metadataUri: string, publicGatewayBaseUrl?: string): string[] {
  const primary = String(metadataUri || '').trim();
  if (!primary) return [];

  const candidates = [primary];
  const cid = extractCidFromIpfsUrl(primary);
  if (!cid) return candidates;

  const fallback = buildPublicIpfsGatewayUrl(cid, publicGatewayBaseUrl);
  if (!candidates.includes(fallback)) {
    candidates.push(fallback);
  }

  return candidates;
}

function isSequencerMetadata(value: unknown): value is SequencerMetadata {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getMetadataCacheKey(metadataUri: string): string {
  return `${METADATA_CACHE_STORAGE_PREFIX}${String(metadataUri || '').trim()}`;
}

function readStorageMetadata(storage: Storage | undefined, cacheKey: string): SequencerMetadata | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isSequencerMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStorageMetadata(storage: Storage | undefined, cacheKey: string, metadata: SequencerMetadata): void {
  if (!storage) return;
  try {
    storage.setItem(cacheKey, JSON.stringify(metadata));
  } catch {
    // Ignore storage quota and availability issues.
  }
}

function readPersistedMetadata(cacheKey: string): SequencerMetadata | null {
  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey) || null;
  }

  const persisted =
    readStorageMetadata(globalThis.localStorage, cacheKey) || readStorageMetadata(globalThis.sessionStorage, cacheKey);
  if (persisted) {
    metadataCache.set(cacheKey, persisted);
    return persisted;
  }

  return null;
}

export function cacheProcessMetadata(metadataUri: string, metadata: SequencerMetadata | ElectionMetadata): void {
  const normalizedMetadataUri = String(metadataUri || '').trim();
  if (!normalizedMetadataUri || !isSequencerMetadata(metadata)) return;
  const cacheKey = getMetadataCacheKey(normalizedMetadataUri);
  const normalizedMetadata = metadata as SequencerMetadata;
  metadataCache.set(cacheKey, normalizedMetadata);
  writeStorageMetadata(globalThis.localStorage, cacheKey, normalizedMetadata);
  writeStorageMetadata(globalThis.sessionStorage, cacheKey, normalizedMetadata);
}

function isTooManyRequestsError(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null
      ? Number(
          (
            error as {
              status?: unknown;
              response?: { status?: unknown };
            }
          ).response?.status ?? (error as { status?: unknown }).status
        )
      : NaN;

  if (status === 429) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error || '');
  return /\b429\b|too many requests/i.test(message);
}

export function createSequencerSdk(options: { sequencerUrl: string; signer?: unknown; censusUrl?: string }): DavinciSDK {
  return new DavinciSDK(options as any);
}

export async function pingSequencer(sdk: DavinciSDK): Promise<void> {
  const ping = sdk?.api?.sequencer?.ping;
  if (typeof ping !== 'function') {
    throw new Error('Sequencer ping is unavailable.');
  }
  await ping.call(sdk.api.sequencer);
}

export async function getProcessFromSequencer(sdk: DavinciSDK, processId: string): Promise<SequencerProcess> {
  const normalized = normalizeProcessId(processId);
  try {
    return (await sdk.api.sequencer.getProcess(normalized)) as SequencerProcess;
  } catch (error) {
    const withoutPrefix = normalized.replace(/^0x/, '');
    if (withoutPrefix === normalized) throw error;
    return (await sdk.api.sequencer.getProcess(withoutPrefix)) as SequencerProcess;
  }
}

export async function fetchProcessMetadata(sdk: DavinciSDK, process: SequencerProcess): Promise<SequencerMetadata | null> {
  const metadataUri = String(process.metadataURI || (process as LegacyMetadataUriCarrier).metadataUri || '').trim();

  if (isSequencerMetadata(process?.metadata)) {
    cacheProcessMetadata(metadataUri, process.metadata);
    return process.metadata;
  }

  if (!metadataUri || !sdk?.api?.sequencer?.getMetadata) return null;
  const cacheKey = getMetadataCacheKey(metadataUri);

  const cachedMetadata = readPersistedMetadata(cacheKey);
  if (cachedMetadata) {
    return cachedMetadata;
  }

  const rateLimitedUntil = metadataRateLimitCooldowns.get(cacheKey) || 0;
  if (rateLimitedUntil > Date.now()) {
    return null;
  }

  const inFlightRequest = metadataInFlightRequests.get(cacheKey);
  if (inFlightRequest) {
    return inFlightRequest;
  }

  const request = (async () => {
    const candidates = buildMetadataFetchCandidates(metadataUri);
    let hitRateLimit = false;

    for (const candidate of candidates) {
      try {
        const metadata = await sdk.api.sequencer.getMetadata(candidate);
        if (isSequencerMetadata(metadata)) {
          cacheProcessMetadata(metadataUri, metadata);
          metadataRateLimitCooldowns.delete(cacheKey);
          return metadata;
        }
      } catch (error) {
        hitRateLimit = hitRateLimit || isTooManyRequestsError(error);
      }
    }

    if (hitRateLimit) {
      metadataRateLimitCooldowns.set(cacheKey, Date.now() + METADATA_RATE_LIMIT_COOLDOWN_MS);
    }

    return null;
  })();

  metadataInFlightRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    metadataInFlightRequests.delete(cacheKey);
  }
}

export async function listProcessesFromSequencer(sdk: DavinciSDK): Promise<string[]> {
  const list = await sdk?.api?.sequencer?.listProcesses?.();
  if (!Array.isArray(list)) return [];
  return list.map((processId) => normalizeProcessId(processId)).filter(Boolean);
}

export async function fetchSequencerWeight(sdk: DavinciSDK | null, processId: string, address: string): Promise<bigint> {
  if (!sdk) return 0n;
  const api = sdk.api?.sequencer as LegacySequencerApi | undefined;

  const normalized = normalizeProcessId(processId);
  const withoutPrefix = normalized.replace(/^0x/, '');

  const callCandidates = [
    () => sdk.getAddressWeight?.(normalized, address),
    () => sdk.getAddressWeight?.(withoutPrefix, address),
    () => api?.getAddressWeight?.(normalized, address),
    () => api?.getAddressWeight?.(withoutPrefix, address),
    () => api?.getProcessAddressWeight?.(normalized, address),
  ];

  for (const call of callCandidates) {
    try {
      const value = await call();
      if (value === undefined || value === null) continue;
      if (typeof value === 'object' && 'weight' in value && value.weight !== undefined) return BigInt(value.weight);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return BigInt(value);
    } catch {
      // Continue trying candidate methods.
    }
  }

  return 0n;
}
