import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { COPY } from './copy';
import {
  HEALTH_CHECK_MAX_ATTEMPTS,
  HEALTH_CHECK_RETRY_DELAY_MS,
  HEALTHY_SERVICE_POLL_MS,
  UNHEALTHY_SERVICE_POLL_MS,
} from './services/serviceHealth';

const mockCreateSequencerSdk = vi.fn();
const mockPingSequencer = vi.fn();
const mockPingIndexer = vi.fn();
const FAILED_ROUND_MS = (HEALTH_CHECK_MAX_ATTEMPTS - 1) * HEALTH_CHECK_RETRY_DELAY_MS;

function failMockNTimes(mockFn: ReturnType<typeof vi.fn>, times: number, message: string) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    mockFn.mockImplementationOnce(async () => {
      throw new Error(message);
    });
  }
}

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
      await vi.dynamicImportSettled();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const advanceCheckWindow = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.dynamicImportSettled();
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
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('checks services every 10 seconds while healthy', async () => {
    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByText('Create route')).toBeInTheDocument();
    expect(mockPingSequencer).toHaveBeenCalledTimes(1);
    expect(mockPingIndexer).toHaveBeenCalledTimes(1);

    await advanceCheckWindow(HEALTHY_SERVICE_POLL_MS - 1);
    expect(mockPingSequencer).toHaveBeenCalledTimes(1);
    expect(mockPingIndexer).toHaveBeenCalledTimes(1);

    await advanceCheckWindow(1);
    expect(mockPingSequencer).toHaveBeenCalledTimes(2);
    expect(mockPingIndexer).toHaveBeenCalledTimes(2);
  });

  it('waits for a confirm round before entering maintenance when the sequencer stays down', async () => {
    mockPingSequencer.mockRejectedValue(new Error('sequencer down'));

    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();
    expect(screen.getByText('Create route')).toBeInTheDocument();

    await advanceCheckWindow(FAILED_ROUND_MS);
    expect(screen.queryByRole('heading', { name: COPY.app.maintenance.title })).toBeNull();
    expect(mockPingSequencer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS);

    await advanceCheckWindow(UNHEALTHY_SERVICE_POLL_MS - 1);
    expect(screen.queryByRole('heading', { name: COPY.app.maintenance.title })).toBeNull();
    expect(mockPingSequencer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS);

    await advanceCheckWindow(1 + FAILED_ROUND_MS);
    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();
    expect(mockPingSequencer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS * 2);
  });

  it('redirects to maintenance when the indexer remains unhealthy across both rounds', async () => {
    mockPingIndexer.mockRejectedValue(new Error('indexer down'));

    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();
    expect(screen.getByText('Create route')).toBeInTheDocument();

    await advanceCheckWindow(FAILED_ROUND_MS + UNHEALTHY_SERVICE_POLL_MS + FAILED_ROUND_MS);
    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();
  });

  it('retries from maintenance every second and returns after the first healthy round', async () => {
    failMockNTimes(mockPingIndexer, HEALTH_CHECK_MAX_ATTEMPTS, 'indexer down');
    mockPingIndexer.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={['/maintenance']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();

    expect(screen.getByRole('heading', { name: COPY.app.maintenance.title })).toBeInTheDocument();

    await advanceCheckWindow(FAILED_ROUND_MS);
    expect(mockPingIndexer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS);

    await advanceCheckWindow(UNHEALTHY_SERVICE_POLL_MS - 1);
    expect(mockPingIndexer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS);

    await advanceCheckWindow(1);
    expect(screen.getByText('Create route')).toBeInTheDocument();
    expect(mockPingIndexer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS + 1);
  });

  it('does not redirect to maintenance when the confirm round recovers', async () => {
    failMockNTimes(mockPingSequencer, HEALTH_CHECK_MAX_ATTEMPTS, 'temporary wake-up failure');
    mockPingSequencer.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={['/create']}>
        <App />
      </MemoryRouter>
    );

    await flushRender();
    expect(screen.getByText('Create route')).toBeInTheDocument();

    await advanceCheckWindow(FAILED_ROUND_MS);
    expect(screen.queryByRole('heading', { name: COPY.app.maintenance.title })).toBeNull();

    await advanceCheckWindow(UNHEALTHY_SERVICE_POLL_MS);
    expect(mockPingSequencer).toHaveBeenCalledTimes(HEALTH_CHECK_MAX_ATTEMPTS + 1);

    expect(screen.getByText('Create route')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: COPY.app.maintenance.title })).toBeNull();
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
