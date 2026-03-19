export type VoteSubmitGateResult = 'ready' | 'needs_registration' | 'blocked';

type RegistrationModalStatus = 'idle' | 'waiting' | 'ready' | 'submitting' | 'error';

type RegistrationModalDismissReason =
  | ''
  | 'backdrop'
  | 'close'
  | 'process_changed'
  | 'wallet_changed'
  | 'process_closed'
  | 'submitted'
  | 'error';

export interface PendingVoteIntent {
  processId: string;
  walletAddress: string;
  choiceSnapshot: number[];
  createdAt: number;
}

export interface RegistrationModalState {
  open: boolean;
  dismissReason: RegistrationModalDismissReason;
  isMobile: boolean;
  status: RegistrationModalStatus;
}
