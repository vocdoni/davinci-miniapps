import type { PendingVoteIntent, VoteSubmitGateResult } from './types';

export interface VoteSubmitGateInput {
  hasProcessId: boolean;
  hasWalletPrivateKey: boolean;
  isProcessClosed: boolean;
  hasQuestion: boolean;
  hasAllChoices: boolean;
  canOverwriteVote: boolean;
  hasVoteReadiness: boolean;
}

interface VoteSubmitGateMessages {
  missingContext: string;
  processClosed: string;
  missingQuestion: string;
  missingChoices: string;
  voteInProgress: string;
}

export interface VoteSubmitGateDecision {
  result: VoteSubmitGateResult;
  blockMessage: string;
}

const DEFAULT_MESSAGES: VoteSubmitGateMessages = {
  missingContext: 'Resolve process and managed wallet before submitting vote.',
  processClosed: 'This process is not accepting votes.',
  missingQuestion: 'No question available for this process.',
  missingChoices: 'Select one option before submitting.',
  voteInProgress: 'Current vote is still processing. Wait until status becomes Settled or Error before overwriting.',
};

export function evaluateVoteSubmitGate(
  input: VoteSubmitGateInput,
  customMessages: Partial<VoteSubmitGateMessages> = {}
): VoteSubmitGateDecision {
  const messages: VoteSubmitGateMessages = { ...DEFAULT_MESSAGES, ...customMessages };

  if (!input.hasProcessId || !input.hasWalletPrivateKey) {
    return { result: 'blocked', blockMessage: messages.missingContext };
  }
  if (input.isProcessClosed) {
    return { result: 'blocked', blockMessage: messages.processClosed };
  }
  if (!input.hasQuestion) {
    return { result: 'blocked', blockMessage: messages.missingQuestion };
  }
  if (!input.hasAllChoices) {
    return { result: 'blocked', blockMessage: messages.missingChoices };
  }
  if (!input.canOverwriteVote) {
    return { result: 'blocked', blockMessage: messages.voteInProgress };
  }
  if (input.hasVoteReadiness) {
    return { result: 'ready', blockMessage: '' };
  }
  return { result: 'needs_registration', blockMessage: '' };
}

export function createPendingVoteIntent(
  processId: string,
  walletAddress: string,
  choices: ReadonlyArray<number | null>,
  nowMs = Date.now()
): PendingVoteIntent {
  const normalizedProcessId = String(processId || '').trim();
  const normalizedWalletAddress = String(walletAddress || '').trim();
  if (!normalizedProcessId || !normalizedWalletAddress) {
    throw new Error('Pending vote intent requires process ID and wallet address.');
  }

  const choiceSnapshot = choices.map((value, index) => {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < 0) {
      throw new Error(`Question ${index + 1} has no selected option.`);
    }
    return normalized;
  });

  return {
    processId: normalizedProcessId,
    walletAddress: normalizedWalletAddress,
    choiceSnapshot,
    createdAt: nowMs,
  };
}

export function shouldAutoSubmitPendingVote(params: {
  pendingVoteIntent: PendingVoteIntent | null;
  modalOpen: boolean;
  hasReadiness: boolean;
  submitting: boolean;
}): boolean {
  return Boolean(params.pendingVoteIntent && params.modalOpen && params.hasReadiness && !params.submitting);
}
