export type RouteName = 'create' | 'vote';

export interface RouteContext {
  name: RouteName;
  processId: string;
  contextPresent: boolean;
  contextValid: boolean;
}

export interface CreateFlowState {
  step: number;
  submitting: boolean;
  dirty: boolean;
  statusMessage: string;
  statusError: boolean;
}

export interface VoteResolutionState {
  processId: string;
  statusCode: number | null;
  isAcceptingVotes: boolean;
  title: string;
  description: string;
  censusContract: string;
  censusUri: string;
  endDateMs: number | null;
  onchainWeight: string;
  sequencerWeight: string;
  readinessCheckedAt: number | null;
}

export interface VoteSelfState {
  scopeSeed: string;
  minAge: number | null;
  country: string;
  link: string;
  generating: boolean;
  autoTriggerKey: string;
}

export interface VoteBallotState {
  loading: boolean;
  submitting: boolean;
  hasVoted: boolean;
  submissionId: string;
  submissionStatus: string;
}

export interface ManagedWalletState {
  address: string;
  source: string;
  privateVisible: boolean;
}

export interface AppCompatibilityState {
  route: RouteContext;
  create: CreateFlowState;
  voteResolution: VoteResolutionState;
  voteSelf: VoteSelfState;
  voteBallot: VoteBallotState;
  managedWallet: ManagedWalletState;
}

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
