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
