import { describe, expect, it } from 'vitest';

import { createPendingVoteIntent, evaluateVoteSubmitGate, shouldAutoSubmitPendingVote } from './submitFlow';

describe('vote submit flow', () => {
  const baseInput = {
    hasProcessId: true,
    hasWalletPrivateKey: true,
    isProcessClosed: false,
    hasQuestion: true,
    hasAllChoices: true,
    canOverwriteVote: true,
    hasVoteReadiness: true,
  } as const;

  it('returns ready when readiness is available', () => {
    const result = evaluateVoteSubmitGate(baseInput);
    expect(result.result).toBe('ready');
    expect(result.blockMessage).toBe('');
  });

  it('returns needs_registration when readiness is missing', () => {
    const result = evaluateVoteSubmitGate({
      ...baseInput,
      hasVoteReadiness: false,
    });
    expect(result.result).toBe('needs_registration');
    expect(result.blockMessage).toBe('');
  });

  it('creates an immutable vote choice snapshot', () => {
    const liveChoices: Array<number | null> = [0, 2];
    const intent = createPendingVoteIntent('0xprocess', '0xwallet', liveChoices, 123456789);

    liveChoices[0] = 1;
    liveChoices[1] = 0;

    expect(intent.choiceSnapshot).toEqual([0, 2]);
    expect(intent.createdAt).toBe(123456789);
  });

  it('allows auto-submit only when pending intent and readiness are both available', () => {
    const pending = createPendingVoteIntent('0xprocess', '0xwallet', [0], 10);
    expect(
      shouldAutoSubmitPendingVote({
        pendingVoteIntent: pending,
        modalOpen: true,
        hasReadiness: true,
        submitting: false,
      })
    ).toBe(true);

    expect(
      shouldAutoSubmitPendingVote({
        pendingVoteIntent: pending,
        modalOpen: false,
        hasReadiness: true,
        submitting: false,
      })
    ).toBe(false);
  });
});
