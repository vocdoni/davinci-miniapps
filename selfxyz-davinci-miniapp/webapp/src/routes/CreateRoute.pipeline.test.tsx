import { Interface } from 'ethers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnectBrowserWallet = vi.fn();
const mockResumeConnectedBrowserWallet = vi.fn();
const mockDisconnectWalletConnection = vi.fn();
const mockGetInjectedProvider = vi.fn();
const mockCreateSequencerSdk = vi.fn();
const mockGetProcessFromSequencer = vi.fn();
const mockListProcessesFromSequencer = vi.fn();
const mockComputeConfigId = vi.fn();

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
  },
  ElectionResultsTypeNames: {
    SINGLE_CHOICE_MULTIQUESTION: 'SINGLE_CHOICE_MULTIQUESTION',
  },
  OnchainCensus: class MockOnchainCensus {},
  DavinciSDK: class MockDavinciSDK {},
}));

vi.mock('../services/wallet', () => ({
  connectBrowserWallet: (...args: unknown[]) => mockConnectBrowserWallet(...args),
  resumeConnectedBrowserWallet: (...args: unknown[]) => mockResumeConnectedBrowserWallet(...args),
  disconnectWalletConnection: (...args: unknown[]) => mockDisconnectWalletConnection(...args),
  getInjectedProvider: (...args: unknown[]) => mockGetInjectedProvider(...args),
}));

vi.mock('../services/sequencer', () => ({
  createSequencerSdk: (...args: unknown[]) => mockCreateSequencerSdk(...args),
  getProcessFromSequencer: (...args: unknown[]) => mockGetProcessFromSequencer(...args),
  listProcessesFromSequencer: (...args: unknown[]) => mockListProcessesFromSequencer(...args),
}));

vi.mock('../lib/occ', async () => {
  const actual = await vi.importActual('../lib/occ');
  return {
    ...actual,
    computeConfigId: (...args: unknown[]) => mockComputeConfigId(...args),
  };
});

import CreateRoute from './CreateRoute';

describe('CreateRoute pipeline retries', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });

    mockConnectBrowserWallet.mockReset();
    mockResumeConnectedBrowserWallet.mockReset();
    mockDisconnectWalletConnection.mockReset();
    mockGetInjectedProvider.mockReset();
    mockCreateSequencerSdk.mockReset();
    mockGetProcessFromSequencer.mockReset();

    mockGetInjectedProvider.mockReturnValue(null);
    mockResumeConnectedBrowserWallet.mockResolvedValue(null);
    mockComputeConfigId.mockReset();
    mockComputeConfigId.mockReturnValue(`0x${'1'.repeat(64)}`);
    mockListProcessesFromSequencer.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it(
    'retries the failed stage without restarting successful earlier stages',
    async () => {
      const verificationInterface = new Interface(['function verificationConfigV2Exists(bytes32) view returns (bool)']);
      const providerRequest = vi
        .fn()
        .mockResolvedValue(verificationInterface.encodeFunctionResult('verificationConfigV2Exists', [true]));
      const signerSendTransaction = vi.fn().mockResolvedValue({ hash: '0xdeploytx' });
      const browserProvider = {
        getBalance: vi.fn().mockResolvedValue(1n),
        getTransactionReceipt: vi.fn().mockResolvedValue({
          contractAddress: '0x1111111111111111111111111111111111111111',
          blockNumber: 123n,
        }),
      };

      mockConnectBrowserWallet.mockResolvedValue({
        provider: { request: providerRequest },
        browserProvider,
        signer: { sendTransaction: signerSendTransaction },
        address: '0x8888888888888888888888888888888888888888',
        sourceLabel: 'MetaMask',
        connectorType: 'injected' as const,
      });

      const sdk = {
        init: vi.fn().mockResolvedValue(undefined),
        api: {
          sequencer: {
            pushMetadata: vi.fn().mockResolvedValue('metadata-hash'),
            getMetadataUrl: vi.fn().mockReturnValue('ipfs://metadata-hash'),
          },
        },
        createProcess: vi.fn().mockResolvedValue({
          processId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          transactionHash: '0xprocesstx',
        }),
      };

      mockCreateSequencerSdk.mockReturnValue(sdk);
      mockListProcessesFromSequencer.mockResolvedValue([
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ]);
      mockGetProcessFromSequencer.mockResolvedValue({ isAcceptingVotes: true });

      let contractsAttempts = 0;
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/contracts')) {
          contractsAttempts += 1;
          if (contractsAttempts === 1) {
            return {
              ok: false,
              status: 503,
              text: vi.fn().mockResolvedValue('temporarily unavailable'),
            } as unknown as Response;
          }

          return {
            ok: true,
            status: 200,
            text: vi.fn().mockResolvedValue(''),
          } as unknown as Response;
        }

        if (url.includes('/graphql')) {
          return {
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ data: { weightChangeEvents: [] } }),
          } as unknown as Response;
        }

        throw new Error(`Unexpected fetch call: ${url}`);
      });

      render(<CreateRoute />);

      fireEvent.click(document.getElementById('createWalletWidget') as HTMLButtonElement);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create the voting process' })).toBeEnabled();
      });

      fireEvent.change(screen.getByPlaceholderText('Type your question here...'), {
        target: { value: 'Should we adopt retries?' },
      });
      fireEvent.change(screen.getByPlaceholderText('Option 1'), {
        target: { value: 'Yes' },
      });
      fireEvent.change(screen.getByPlaceholderText('Option 2'), {
        target: { value: 'No' },
      });

      const countryInput = screen.getByRole('combobox', { name: 'Choose allowed countries' });
      fireEvent.focus(countryInput);
      const firstCountryOption = await waitFor(() => {
        const option = document.querySelector('#countryList button');
        expect(option).not.toBeNull();
        return option;
      });
      fireEvent.click(firstCountryOption as Element);

      fireEvent.click(screen.getByRole('button', { name: 'Create the voting process' }));

      await waitFor(() => {
        expect(document.getElementById('retryCreateStageBtn-start_indexer')).not.toBeNull();
      });

      expect(signerSendTransaction).toHaveBeenCalledTimes(1);
      expect(providerRequest).toHaveBeenCalledTimes(1);

      const timelinePanel = document.getElementById('createTimelineCard') as HTMLDetailsElement | null;
      if (timelinePanel) {
        timelinePanel.open = true;
      }

      const retryButton = document.getElementById('retryCreateStageBtn-start_indexer');
      expect(retryButton).not.toBeNull();
      fireEvent.click(retryButton as HTMLElement);

      await waitFor(() => {
        expect(contractsAttempts).toBe(2);
      });

      await waitFor(() => {
        expect(sdk.createProcess).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(mockListProcessesFromSequencer).toHaveBeenCalledTimes(1);
        expect(mockGetProcessFromSequencer).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Your voting process is live and ready for the world.' })).toBeInTheDocument();
      });

      expect(signerSendTransaction).toHaveBeenCalledTimes(1);
      expect(providerRequest).toHaveBeenCalledTimes(1);
      expect(contractsAttempts).toBe(2);

      cleanup();
      render(<CreateRoute />);

      expect(screen.getByPlaceholderText('Type your question here...')).toHaveValue('');
      expect(screen.getByPlaceholderText('Option 1')).toHaveValue('');
      expect(screen.getByPlaceholderText('Option 2')).toHaveValue('');
    },
    10_000
  );
});
