import { describe, expect, it } from 'vitest';

import {
  buildSingleQuestionBallotValues,
  createPendingVoteIntent,
  evaluateVoteSubmitGate,
  shouldAutoSubmitPendingVote,
} from './submitFlow';

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

  it('builds one-hot ballot values for a selected option', () => {
    expect(buildSingleQuestionBallotValues(2, [0, 1, 2, 3, 4])).toEqual([0, 0, 1, 0, 0]);
  });

  it('builds one-hot ballot values using question option order', () => {
    expect(buildSingleQuestionBallotValues(20, [10, 20, 30])).toEqual([0, 1, 0]);
  });

  it('throws when selected option is not part of available question options', () => {
    expect(() => buildSingleQuestionBallotValues(4, [0, 1, 2])).toThrow(/Selected option is not valid/i);
  });
});
