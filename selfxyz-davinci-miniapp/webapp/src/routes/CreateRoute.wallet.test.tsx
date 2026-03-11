import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnectBrowserWallet = vi.fn();
const mockResumeConnectedBrowserWallet = vi.fn();
const mockDisconnectWalletConnection = vi.fn();
const mockGetInjectedProvider = vi.fn();

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
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

import CreateRoute from './CreateRoute';

describe('CreateRoute creator wallet persistence', () => {
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
    mockGetInjectedProvider.mockReturnValue(null);
    mockResumeConnectedBrowserWallet.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores a connected creator wallet after refresh when the provider can resume silently', async () => {
    const connectedAddress = '0x8888888888888888888888888888888888888888';
    const connectedWallet = {
      provider: { request: vi.fn() },
      browserProvider: { getBalance: vi.fn().mockResolvedValue(1n) },
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
      connectorType: 'injected' as const,
    };

    mockConnectBrowserWallet.mockResolvedValue(connectedWallet);

    const firstRender = render(<CreateRoute />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet to create' }));

    await waitFor(() => {
      expect(document.getElementById('creatorWalletNavbarAddress')).toHaveTextContent(connectedAddress);
      expect(screen.getByRole('button', { name: 'Create the voting process' })).toBeInTheDocument();
    });

    firstRender.unmount();

    mockResumeConnectedBrowserWallet.mockResolvedValue(connectedWallet);

    render(<CreateRoute />);

    await waitFor(() => {
      expect(mockResumeConnectedBrowserWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          address: connectedAddress,
          sourceLabel: 'MetaMask',
          connectorType: 'injected',
        }),
        null
      );
      expect(document.getElementById('creatorWalletNavbarAddress')).toHaveTextContent(connectedAddress);
      expect(screen.getByRole('button', { name: 'Create the voting process' })).toBeInTheDocument();
    });
  });

  it('disables creation and shows the CELO faucet when the connected wallet has no balance', async () => {
    const connectedAddress = '0x9999999999999999999999999999999999999999';
    mockConnectBrowserWallet.mockResolvedValue({
      provider: { request: vi.fn() },
      browserProvider: { getBalance: vi.fn().mockResolvedValue(0n) },
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
      connectorType: 'injected' as const,
    });

    render(<CreateRoute />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet to create' }));

    await waitFor(() => {
      expect(document.getElementById('creatorWalletNavbarAddress')).toHaveTextContent(connectedAddress);
      expect(screen.getByRole('button', { name: 'Create the voting process' })).toBeDisabled();
      expect(screen.getByText(/almost there! creating a vote requires a tiny bit of celo/i)).toBeInTheDocument();
    });

    const faucetLink = screen.getByRole('link', { name: 'here' });
    expect(faucetLink).toHaveAttribute('href', 'https://stakely.io/faucet/celo-celo');
  });
});
