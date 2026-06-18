import type { VoteStatus } from '../../lib/types';

export type VotePipelineStage =
  | 'idle'
  | 'resolve_election'
  | 'connect_wallet'
  | 'check_census'
  | 'encrypt_ballot'
  | 'generate_ballot_proof'
  | 'sign_ballot'
  | 'submit_vote'
  | 'track_vote'
  | 'done'
  | 'error';

export interface VoteStatusStep {
  status: VoteStatus;
  label: string;
  description: string;
}

export const VOTE_STATUS_STEPS: VoteStatusStep[] = [
  { status: 'pending', label: 'Pending', description: 'Vote received and queued.' },
  { status: 'batched', label: 'Batched', description: 'Assigned to a proving batch.' },
  { status: 'folded', label: 'Folded', description: 'Batch STARK proved and folded into chain.' },
  { status: 'settled', label: 'Settled', description: 'Vote fully settled in final proof.' },
];
