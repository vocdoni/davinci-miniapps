import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CreateRoute from './CreateRoute';

vi.mock('@vocdoni/davinci-sdk', () => {
  return {
    ProcessStatus: {
      READY: 0,
      ENDED: 1,
      CANCELED: 2,
      PAUSED: 3,
      RESULTS: 4,
    },
    OnchainCensus: class MockOnchainCensus {},
    DavinciSDK: class MockDavinciSDK {},
  };
});

function getCountryInput(): HTMLInputElement {
  return screen.getByRole('combobox', { name: /choose allowed countries/i }) as HTMLInputElement;
}

function openAndTypeCountryQuery(query: string): HTMLInputElement {
  const input = getCountryInput();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: query } });
  return input;
}

function selectCountry(label: string, code: string): HTMLInputElement {
  const input = openAndTypeCountryQuery(code);
  const option = screen.getByRole('option', { name: new RegExp(`${label}\\s*\\(${code}\\)`, 'i') });
  fireEvent.click(option);
  return input;
}

describe('CreateRoute country selector', () => {
  afterEach(() => {
    cleanup();
  });

  it('filters country options while typing', () => {
    render(<CreateRoute />);

    openAndTypeCountryQuery('spa');

    expect(screen.getByRole('option', { name: /Spain \(ESP\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Germany \(DEU\)/i })).not.toBeInTheDocument();
  });

  it('selects country, closes dropdown and clears search query', () => {
    render(<CreateRoute />);

    const input = openAndTypeCountryQuery('spa');
    fireEvent.click(screen.getByRole('option', { name: /Spain \(ESP\)/i }));

    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('adds a new option when pressing Enter on the last option input', () => {
    render(<CreateRoute />);

    const beforeInputs = document.querySelectorAll('input.option-input');
    expect(beforeInputs).toHaveLength(2);

    const lastInput = beforeInputs[beforeInputs.length - 1] as HTMLInputElement;
    fireEvent.keyDown(lastInput, { key: 'Enter', code: 'Enter' });

    const afterInputs = document.querySelectorAll('input.option-input');
    expect(afterInputs).toHaveLength(3);
    expect(screen.getByPlaceholderText(/Option 3/i)).toBeInTheDocument();
  });

  it('moves focus to next option when pressing Enter on a non-last option input', () => {
    render(<CreateRoute />);

    const optionInputs = document.querySelectorAll('input.option-input');
    expect(optionInputs).toHaveLength(2);

    const firstInput = optionInputs[0] as HTMLInputElement;
    const secondInput = optionInputs[1] as HTMLInputElement;

    firstInput.focus();
    fireEvent.keyDown(firstInput, { key: 'Enter', code: 'Enter' });

    expect(secondInput).toHaveFocus();
    expect(document.querySelectorAll('input.option-input')).toHaveLength(2);
  });

  it('moves focus to previous option when pressing Shift+Enter (circular)', () => {
    render(<CreateRoute />);

    const optionInputs = document.querySelectorAll('input.option-input');
    expect(optionInputs).toHaveLength(2);

    const firstInput = optionInputs[0] as HTMLInputElement;
    const secondInput = optionInputs[1] as HTMLInputElement;

    firstInput.focus();
    fireEvent.keyDown(firstInput, { key: 'Enter', code: 'Enter', shiftKey: true });

    expect(secondInput).toHaveFocus();
  });

  it('removes an empty option with Backspace when there are more than two options and focuses previous', async () => {
    render(<CreateRoute />);

    const initialInputs = document.querySelectorAll('input.option-input');
    const lastInput = initialInputs[initialInputs.length - 1] as HTMLInputElement;
    fireEvent.keyDown(lastInput, { key: 'Enter', code: 'Enter' });

    let currentInputs = document.querySelectorAll('input.option-input');
    expect(currentInputs).toHaveLength(3);

    const thirdInput = currentInputs[2] as HTMLInputElement;
    thirdInput.focus();
    fireEvent.keyDown(thirdInput, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      currentInputs = document.querySelectorAll('input.option-input');
      expect(currentInputs).toHaveLength(2);
      expect(currentInputs[1]).toHaveFocus();
    });
  });

  it('does not remove option with Backspace when only two options exist', () => {
    render(<CreateRoute />);

    const optionInputs = document.querySelectorAll('input.option-input');
    expect(optionInputs).toHaveLength(2);

    const secondInput = optionInputs[1] as HTMLInputElement;
    secondInput.focus();
    fireEvent.keyDown(secondInput, { key: 'Backspace', code: 'Backspace' });

    expect(document.querySelectorAll('input.option-input')).toHaveLength(2);
  });

  it('shows days input when duration exceeds 24 hours', () => {
    render(<CreateRoute />);

    const durationHoursInput = document.querySelector('#durationHours') as HTMLInputElement;
    expect(document.querySelector('#durationDays')).toBeNull();

    fireEvent.change(durationHoursInput, { target: { value: '25' } });

    const durationDaysInput = document.querySelector('#durationDays') as HTMLInputElement;
    expect(durationDaysInput).toBeInTheDocument();
    expect(durationDaysInput.value).toBe('1');
    expect(durationHoursInput.value).toBe('1');
  });

  it('updates duration total when changing days and keeps extra hours', () => {
    render(<CreateRoute />);

    const durationHoursInput = document.querySelector('#durationHours') as HTMLInputElement;
    fireEvent.change(durationHoursInput, { target: { value: '49' } });

    let durationDaysInput = document.querySelector('#durationDays') as HTMLInputElement;
    expect(durationDaysInput).toBeInTheDocument();
    expect(durationDaysInput.value).toBe('2');
    expect(durationHoursInput.value).toBe('1');

    fireEvent.change(durationDaysInput, { target: { value: '3' } });
    durationDaysInput = document.querySelector('#durationDays') as HTMLInputElement;
    expect(durationDaysInput.value).toBe('3');
    expect(durationHoursInput.value).toBe('1');

    fireEvent.change(durationDaysInput, { target: { value: '0' } });
    expect(document.querySelector('#durationDays')).toBeNull();
    expect(durationHoursInput.value).toBe('1');
  });

  it('enforces max selected countries and re-enables options after chip removal', () => {
    render(<CreateRoute />);

    selectCountry('Argentina', 'ARG');
    selectCountry('Australia', 'AUS');
    selectCountry('Austria', 'AUT');
    selectCountry('Belgium', 'BEL');
    selectCountry('Brazil', 'BRA');

    openAndTypeCountryQuery('can');
    const canadaOption = screen.getByRole('option', { name: /Canada \(CAN\)/i });
    expect(canadaOption).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /remove argentina/i }));

    openAndTypeCountryQuery('can');
    const enabledCanadaOption = screen.getByRole('option', { name: /Canada \(CAN\)/i });
    expect(enabledCanadaOption).not.toBeDisabled();
  });

  it('shows no-results state for unmatched query', () => {
    render(<CreateRoute />);

    openAndTypeCountryQuery('zzzzzzzz');

    expect(screen.getByText('No countries found')).toBeInTheDocument();
  });
});
