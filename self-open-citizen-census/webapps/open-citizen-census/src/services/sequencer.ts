import { DavinciSDK } from '@vocdoni/davinci-sdk';

import { normalizeProcessId } from '../utils/normalization';
import type { SequencerProcessConfigDTO } from '../types/state';

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

export async function getProcessFromSequencer(sdk: any, processId: string): Promise<any> {
  const normalized = normalizeProcessId(processId);
  try {
    return await sdk.api.sequencer.getProcess(normalized);
  } catch (error) {
    const withoutPrefix = normalized.replace(/^0x/, '');
    if (withoutPrefix === normalized) throw error;
    return sdk.api.sequencer.getProcess(withoutPrefix);
  }
}

export async function fetchProcessMetadata(sdk: any, process: any): Promise<Record<string, unknown> | null> {
  const metadataUri = String(process?.metadataURI || process?.metadataUri || '').trim();
  if (!metadataUri || !sdk?.api?.sequencer?.getMetadata) return null;

  try {
    const metadata = await sdk.api.sequencer.getMetadata(metadataUri);
    return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function fetchSequencerWeight(sdk: any, processId: string, address: string): Promise<bigint> {
  if (!sdk) return 0n;
  const api = sdk.api?.sequencer;

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
      if (typeof value === 'object' && value.weight !== undefined) return BigInt(value.weight);
      return BigInt(value);
    } catch {
      // Continue trying candidate methods.
    }
  }

  return 0n;
}
