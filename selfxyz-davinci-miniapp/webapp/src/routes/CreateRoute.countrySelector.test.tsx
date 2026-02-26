import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
