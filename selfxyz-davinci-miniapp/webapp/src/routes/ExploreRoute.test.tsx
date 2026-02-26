import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
  },
  DavinciSDK: class MockDavinciSDK {},
}));

import ExploreRoute from './ExploreRoute';

const mockCreateSequencerSdk = vi.fn();
const mockListProcessesFromSequencer = vi.fn();
const mockGetProcessFromSequencer = vi.fn();
const mockFetchProcessMetadata = vi.fn();

vi.mock('../services/sequencer', () => ({
  createSequencerSdk: (...args: unknown[]) => mockCreateSequencerSdk(...args),
  listProcessesFromSequencer: (...args: unknown[]) => mockListProcessesFromSequencer(...args),
  getProcessFromSequencer: (...args: unknown[]) => mockGetProcessFromSequencer(...args),
  fetchProcessMetadata: (...args: unknown[]) => mockFetchProcessMetadata(...args),
}));

function processIdFrom(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function makeProcess(processId: string, options?: { status?: number; startTime?: string; duration?: number }) {
  return {
    id: processId,
    status: options?.status ?? 0,
    startTime: options?.startTime || '2026-02-26T10:00:00Z',
    duration: options?.duration ?? 3600,
    metadataURI: `https://meta/${processId}`,
  };
}

function makeMetadata(questionTitle: string, countries: string[] = ['ESP']) {
  return {
    title: { default: questionTitle },
    questions: [
      {
        title: { default: questionTitle },
        choices: [
          { title: { default: 'Yes' }, value: 0 },
          { title: { default: 'No' }, value: 1 },
        ],
      },
    ],
    meta: {
      selfConfig: {
        scope: 'ESP_18_abcde',
        minAge: 18,
        countries,
      },
    },
  };
}

describe('ExploreRoute', () => {
  beforeEach(() => {
    mockCreateSequencerSdk.mockReset();
    mockListProcessesFromSequencer.mockReset();
    mockGetProcessFromSequencer.mockReset();
    mockFetchProcessMetadata.mockReset();
    mockCreateSequencerSdk.mockReturnValue({ api: { sequencer: {} } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders compatible rows and links each item to vote page', async () => {
    const id1 = processIdFrom(1);
    const id2 = processIdFrom(2);

    mockListProcessesFromSequencer.mockResolvedValue([id1, id2]);
    mockGetProcessFromSequencer.mockImplementation(async (_sdk, processId: string) =>
      makeProcess(processId, {
        startTime: processId === id1 ? '2026-02-26T12:00:00Z' : '2026-02-26T11:00:00Z',
      })
    );
    mockFetchProcessMetadata.mockImplementation(async (_sdk, process: { id: string }) => {
      if (process.id === id1) return makeMetadata('Question A');
      return {
        title: { default: 'Invalid process' },
        meta: { selfConfig: { minAge: 18 } },
      };
    });

    render(<ExploreRoute />);

    await waitFor(() => {
      expect(screen.getByText('Question A')).toBeInTheDocument();
    });

    expect(screen.queryByText('Invalid process')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /question a/i });
    expect(link).toHaveAttribute('href', `/vote/${encodeURIComponent(id1)}`);
  });

  it('supports paginated load more for additional compatible rows', async () => {
    const processIds = Array.from({ length: 25 }, (_, index) => processIdFrom(index + 1));
    mockListProcessesFromSequencer.mockResolvedValue(processIds);
    mockGetProcessFromSequencer.mockImplementation(async (_sdk, processId: string) => makeProcess(processId));
    mockFetchProcessMetadata.mockImplementation(async (_sdk, process: { id: string }) =>
      makeMetadata(`Question ${process.id.slice(-4)}`)
    );

    render(<ExploreRoute />);

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(20);
    });

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(25);
    });
  });

  it('shows empty state when no compatible processes are found', async () => {
    const id = processIdFrom(1);
    mockListProcessesFromSequencer.mockResolvedValue([id]);
    mockGetProcessFromSequencer.mockResolvedValue(makeProcess(id));
    mockFetchProcessMetadata.mockResolvedValue({
      title: { default: 'Invalid process' },
      meta: { selfConfig: { scope: '', minAge: 18, countries: [] } },
    });

    render(<ExploreRoute />);

    await waitFor(() => {
      expect(screen.getByText('No compatible processes found.')).toBeInTheDocument();
    });
  });

  it('shows error state and retry action on sequencer failure', async () => {
    mockListProcessesFromSequencer.mockRejectedValue(new Error('sequencer down'));

    render(<ExploreRoute />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('sequencer down');
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('refreshes loaded rows and updates status labels', async () => {
    const id = processIdFrom(1);
    mockListProcessesFromSequencer.mockResolvedValue([id]);
    const activeStartTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let intervalCallback: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation(
      ((callback: (...args: any[]) => void) => {
        intervalCallback = () => callback();
        return 1 as any;
      }) as typeof window.setInterval
    );
    vi.spyOn(window, 'clearInterval').mockImplementation((() => {}) as typeof window.clearInterval);

    let currentStatus = 0;
    mockGetProcessFromSequencer.mockImplementation(async (_sdk, processId: string) =>
      makeProcess(processId, { status: currentStatus, startTime: activeStartTime })
    );
    mockFetchProcessMetadata.mockResolvedValue(makeMetadata('Question A'));

    render(<ExploreRoute />);

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    currentStatus = 1;
    expect(intervalCallback).toBeDefined();
    if (!intervalCallback) throw new Error('Missing explore refresh interval callback');
    intervalCallback();

    await waitFor(() => {
      expect(screen.getByText('Ended')).toBeInTheDocument();
    });
  });
});
