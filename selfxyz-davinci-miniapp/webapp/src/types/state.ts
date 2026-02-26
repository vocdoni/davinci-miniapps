export interface IndexerContractPayload {
  chainId: number;
  address: string;
  startBlock: number;
  expiresAt: string;
}

export interface SequencerProcessTiming {
  startDate: Date;
  duration: number;
}

export interface SequencerProcessConfigDTO {
  metadataUri: string;
  maxVoters: number;
  timing: SequencerProcessTiming;
}
