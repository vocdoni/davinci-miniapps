import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { COPY } from './copy';

const mockCreateSequencerSdk = vi.fn();
const mockPingSequencer = vi.fn();
const mockPingIndexer = vi.fn();

vi.mock('./lib/occ', () => ({
  CONFIG: {
    davinciSequencerUrl: 'https://sequencer.example',
    onchainIndexerUrl: 'https://indexer.example',
  },
}));

vi.mock('./services/sequencer', () => ({
  createSequencerSdk: (...args: unknown[]) => mockCreateSequencerSdk(...args),
  pingSequencer: (...args: unknown[]) => mockPingSequencer(...args),
}));

vi.mock('./services/indexer', () => ({
  pingIndexer: (...args: unknown[]) => mockPingIndexer(...args),
}));

vi.mock('./routes/CreateRoute', () => ({
  default: () => <div>Create route</div>,
}));

vi.mock('./routes/VoteRoute', () => ({
  default: () => <div>Vote route</div>,
}));

vi.mock('./routes/ExploreRoute', () => ({
  default: () => <div>Explore route</div>,
}));

vi.mock('./components/SupportPopup', () => ({
  default: ({ open }: { open: boolean }) => <div data-testid="support-popup">{open ? 'open' : 'closed'}</div>,
}));

describe('App sequencer maintenance guard', () => {
  const flushRender = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockCreateSequencerSdk.mockReset();
    mockPingSequencer.mockReset();
    mockPingIndexer.mockReset();
    mockCreateSequencerSdk.mockReturnValue({ api: { sequencer: {} } });
    mockPingSequencer.mockResolvedValue(undefined);
    mockPingIndexer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('redirects to maintenance when the sequencer ping fails', async () => {
    mockPingSequencer.mockRejectedValue(new Error('sequencer down'));

    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();
  });

  it('redirects to maintenance when the indexer ping fails', async () => {
    mockPingIndexer.mockRejectedValue(new Error('indexer down'));

    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();
  });

  it('retries from maintenance and returns to the app after the indexer recovers', async () => {
    mockPingIndexer
      .mockImplementationOnce(async () => {
        throw new Error('indexer down');
      })
      .mockImplementation(async () => undefined);

    render(
      <MemoryRouter initialEntries={['/maintenance']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    await flushRender();

    expect(screen.getByText('Create route')).toBeInTheDocument();
  });

  it('shows the support popup on the maintenance route', async () => {
    render(
      <MemoryRouter initialEntries={['/maintenance']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByTestId('support-popup')).toHaveTextContent('open');
  });
});
