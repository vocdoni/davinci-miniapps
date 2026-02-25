import { describe, expect, it } from 'vitest';

import { MAX_OPTIONS } from './constants';
import { addOption, createInitialFormState, deriveCreateValuesFromForm, generateScopeSeed, removeOption } from './model';

describe('create route model', () => {
  it('generates scope seed in expected format', () => {
    const positions = [0, 1, 2, 3, 4];
    let cursor = 0;
    const seed = generateScopeSeed('usa', 18, () => positions[cursor++] ?? 0);

    expect(seed).toBe('USA_18_abcde');
  });

  it('maps single-question form to create values', () => {
    const values = deriveCreateValuesFromForm(
      {
        processTitle: 'Should we approve this budget?',
        options: [
          { title: 'Yes', value: 0 },
          { title: 'No', value: 1 },
          { title: 'Abstain', value: 2 },
        ],
        country: 'USA',
        minAge: '18',
        durationHours: '24',
        maxVoters: '1000',
      },
      Date.parse('2026-03-01T10:00:00Z'),
      () => 0
    );

    expect(values.scopeSeed).toBe('USA_18_aaaaa');
    expect(values.startDate.toISOString()).toBe('2026-03-01T10:10:00.000Z');
    expect(values.question).toEqual({
      title: 'Should we approve this budget?',
      description: '',
      choices: [
        { title: 'Yes', value: 0 },
        { title: 'No', value: 1 },
        { title: 'Abstain', value: 2 },
      ],
    });
  });

  it('keeps at least two options and reindexes after removal', () => {
    const initial = createInitialFormState();
    const withThreeOptions = addOption(initial.options);

    expect(withThreeOptions).toHaveLength(3);

    const trimmed = removeOption(withThreeOptions, 1);
    expect(trimmed).toEqual([
      { title: '', value: 0 },
      { title: '', value: 1 },
    ]);

    const cannotGoLower = removeOption(trimmed, 1);
    expect(cannotGoLower).toHaveLength(2);
  });

  it('caps options to MAX_OPTIONS', () => {
    let options = createInitialFormState().options;
    for (let index = 0; index < MAX_OPTIONS + 3; index += 1) {
      options = addOption(options);
    }

    expect(options).toHaveLength(MAX_OPTIONS);
  });
});
