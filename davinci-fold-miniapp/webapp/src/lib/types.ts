export type ElectionStatus =
  | 'created'
  | 'active'
  | 'ended'
  | 'decrypting'
  | 'finalizing'
  | 'results'
  | 'paused'
  | 'canceled';

export type VoteStatus = 'pending' | 'batched' | 'folded' | 'settled' | 'error';

export interface InfoResponse {
  version: string;
  batchSize: number;
  foldEvery: number;
  workers: number;
  elections: number;
}

export interface ElectionResponse {
  id: string;
  status: ElectionStatus;
  batchSize: number;
  foldEvery: number;
  endTime?: string;
  createdAt: string;
}

export interface ElectionListResponse {
  elections: ElectionResponse[];
}

export interface VoteResponse {
  voteID: string;
  status: VoteStatus;
  seq: number;
}

export interface ResultsResponse {
  electionID: string;
  tally: number[];
  programVK: string;
  rootCVadcopFinal: string;
  publicValues: string;
  proofBytes: string;
}

export interface WorkerInfo {
  address: string;
  name: string;
  healthy: boolean;
  queueLen: number;
  banned: boolean;
  successCount: number;
  failedCount: number;
}

export interface WorkerListResponse {
  workers: WorkerInfo[];
}

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
}

export interface ECDSASignature {
  r: string;
  s: string;
  v: number;
}

export interface CensusProof {
  root: string;
  siblings: string[];
  index: number;
}

export interface VoteSubmission {
  vote_id: string;
  address: string;
  census_idx: number;
  address_lo16: number;
  vote_id_key: string;
  ballot: string;
  proof: Groth16Proof;
  public_inputs: string[];
  sig: ECDSASignature;
  census: CensusProof;
}

export interface CreateElectionRequest {
  processID: string;
  ballotMode: string;
  encX: string;
  encY: string;
  censusOrigin: number;
  censusRoot: string;
  vk: Record<string, unknown>;
  batchSize?: number;
  foldEvery?: number;
  endTime?: string;
}

export interface FoldApiError {
  error: {
    code: number;
    message: string;
  };
}

export interface CensusEntry {
  address: string;
  weight: bigint;
}

export interface ElectionMeta {
  title: string;
  description: string;
  options: string[];
  censusAddresses: string[];
}
