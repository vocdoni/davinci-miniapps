import { DavinciSDK } from '@vocdoni/davinci-sdk';
import type { ElectionMetadata, GetProcessResponse } from '@vocdoni/davinci-sdk';

import { CONFIG } from '../lib/occ';
import { buildMetadataFetchCandidates } from '../utils/ipfs';
import { normalizeProcessId } from '../utils/normalization';
import type { SequencerProcessConfigDTO } from '../types/state';

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

export function buildSequencerProcessConfig(input: SequencerProcessConfigDTO): SequencerProcessConfigDTO {
  return {
    metadataUri: String(input.metadataUri || '').trim(),
    maxVoters: Math.max(1, Math.trunc(Number(input.maxVoters || 0))),
    timing: {
      startDate: input.timing.startDate,
      duration: Math.max(1, Math.trunc(Number(input.timing.duration || 0))),
    },
  };
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
  if (!metadataUri || !sdk?.api?.sequencer?.getMetadata) return null;

  const candidates = buildMetadataFetchCandidates(metadataUri, CONFIG.pinataPublicGatewayUrl);
  for (const candidate of candidates) {
    try {
      const metadata = await sdk.api.sequencer.getMetadata(candidate);
      if (metadata && typeof metadata === 'object') {
        return metadata as SequencerMetadata;
      }
    } catch {
      // Try the next candidate URL, if any.
    }
  }

  return null;
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
