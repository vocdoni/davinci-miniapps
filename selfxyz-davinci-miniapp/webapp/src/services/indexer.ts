import type { IndexerContractPayload } from '../types/state';
import { computeExpiresAtFromStartAndDuration } from '../utils/timing';

export interface BuildIndexerPayloadInput {
  chainId: number;
  address: string;
  startBlock: number;
  startDate: Date;
  duration: number;
}

export function buildIndexerPayload(input: BuildIndexerPayloadInput): IndexerContractPayload {
  return {
    chainId: input.chainId,
    address: String(input.address || '').trim(),
    startBlock: Number(input.startBlock || 0),
    expiresAt: computeExpiresAtFromStartAndDuration(input.startDate, input.duration),
  };
}

export async function pingIndexer(indexerUrl: string): Promise<void> {
  const baseUrl = String(indexerUrl || '').replace(/\/+$/, '').trim();
  if (!baseUrl) {
    throw new Error('Indexer URL is unavailable.');
  }

  const response = await fetch(baseUrl, {
    method: 'GET',
    cache: 'no-store',
  });

  if (response.status >= 500) {
    throw new Error(`Indexer ping failed (${response.status})`);
  }
}

export async function bootstrapIndexer(indexerUrl: string, payload: IndexerContractPayload): Promise<void> {
  const url = `${String(indexerUrl || '').replace(/\/+$/, '')}/contracts`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Indexer bootstrap failed (${response.status}) ${text}`.trim());
  }
}
