import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vocdoni/davinci-sdk', () => ({
  ProcessStatus: {
    READY: 0,
    ENDED: 1,
    CANCELED: 2,
    PAUSED: 3,
    RESULTS: 4,
  },
}));

const mockUseParams = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => mockUseParams(),
  };
});

const mockCreateSequencerSdk = vi.fn();
const mockGetProcessFromSequencer = vi.fn();
const mockFetchProcessMetadata = vi.fn();
const mockFetchSequencerWeight = vi.fn();

vi.mock('../services/sequencer', () => ({
  createSequencerSdk: (...args: unknown[]) => mockCreateSequencerSdk(...args),
  getProcessFromSequencer: (...args: unknown[]) => mockGetProcessFromSequencer(...args),
  fetchProcessMetadata: (...args: unknown[]) => mockFetchProcessMetadata(...args),
  fetchSequencerWeight: (...args: unknown[]) => mockFetchSequencerWeight(...args),
}));

const mockFetchOnchainWeight = vi.fn();
const mockEthCall = vi.fn();

vi.mock('../services/readiness', () => ({
  fetchOnchainWeight: (...args: unknown[]) => mockFetchOnchainWeight(...args),
  ethCall: (...args: unknown[]) => mockEthCall(...args),
}));

const mockConnectBrowserWallet = vi.fn();
const mockResumeConnectedBrowserWallet = vi.fn();
const mockSelfAppBuilderInputs = vi.fn();

vi.mock('../services/wallet', () => ({
  connectBrowserWallet: (...args: unknown[]) => mockConnectBrowserWallet(...args),
  resumeConnectedBrowserWallet: (...args: unknown[]) => mockResumeConnectedBrowserWallet(...args),
}));

vi.mock('@selfxyz/qrcode', () => ({
  SelfAppBuilder: class MockSelfAppBuilder {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
      mockSelfAppBuilderInputs(input);
    }

    build() {
      return { userId: this.input.userId };
    }
  },
  SelfQRcodeWrapper: () => <div data-testid="self-qr" />,
}));

import VoteRoute from './VoteRoute';

const PROCESS_ID = `0x${'1'.padStart(62, '0')}`;
const CENSUS_ADDRESS = '0x1111111111111111111111111111111111111111';

function makeProcess() {
  const startDate = new Date(Date.now() - 60_000).toISOString();
  return {
    id: PROCESS_ID,
    status: 0,
    metadataURI: `https://meta/${PROCESS_ID}`,
    censusContract: CENSUS_ADDRESS,
    votersCount: 0,
    maxVoters: 100,
    isAcceptingVotes: true,
    startDate,
    duration: 3600,
  };
}

function makeMetadata() {
  return {
    title: { default: 'Question A' },
    questions: [
      {
        title: { default: 'Question A' },
        choices: [
          { title: { default: 'Yes' }, value: 0 },
          { title: { default: 'No' }, value: 1 },
        ],
      },
    ],
    meta: {
      selfConfig: {
        scope: 'vote_scope_seed',
        minAge: 18,
        countries: ['ESP'],
      },
    },
  };
}

describe('VoteRoute identity popup', () => {
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
    mockUseParams.mockReturnValue({ processId: PROCESS_ID });
    mockCreateSequencerSdk.mockReset();
    mockGetProcessFromSequencer.mockReset();
    mockFetchProcessMetadata.mockReset();
    mockFetchSequencerWeight.mockReset();
    mockFetchOnchainWeight.mockReset();
    mockEthCall.mockReset();
    mockConnectBrowserWallet.mockReset();
    mockResumeConnectedBrowserWallet.mockReset();
    mockSelfAppBuilderInputs.mockReset();

    mockCreateSequencerSdk.mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      api: { sequencer: {} },
      hasAddressVoted: vi.fn().mockResolvedValue(false),
    });
    mockGetProcessFromSequencer.mockResolvedValue(makeProcess());
    mockFetchProcessMetadata.mockResolvedValue(makeMetadata());
    mockFetchSequencerWeight.mockResolvedValue(0n);
    mockFetchOnchainWeight.mockResolvedValue(0n);
    mockEthCall.mockRejectedValue(new Error('minAge lookup not needed in this test'));
    mockResumeConnectedBrowserWallet.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the redesigned derived-wallet popup and previews the imported address', async () => {
    render(<VoteRoute />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));

    expect(screen.getByRole('dialog', { name: 'Identity Wallet' })).toBeInTheDocument();
    expect(screen.getByText(/creates a local wallet automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps the vote accessible for web2 users/i)).toBeInTheDocument();
    expect(screen.getByText(/private key is exposed/i)).toBeInTheDocument();

    const addressInput = document.getElementById('walletAddressInput') as HTMLInputElement;
    expect(addressInput.value).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(addressInput).toHaveAttribute('readonly');
    expect(document.getElementById('walletSource')).toHaveTextContent('Derived');
    expect(screen.getByRole('button', { name: 'Copy private key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect browser wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use derived key' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import private key' }));

    const privateKey = '0x59c6995e998f97a5a0044966f0945382f3d3d6db7c1b4a1af9da6af7d2f40991';
    fireEvent.change(screen.getByLabelText('Paste private key'), { target: { value: privateKey } });

    const expectedAddress = new Wallet(privateKey).address;
    await waitFor(() => {
      expect(screen.getByText('Detected address')).toBeInTheDocument();
      expect(screen.getByText(expectedAddress)).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Use derived key' })).not.toBeInTheDocument();

    fireEvent.click(document.getElementById('closeVoteIdentityBtn') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.getElementById('voteIdentityDialog')).not.toBeVisible();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));

    expect((screen.getByLabelText('Paste private key') as HTMLInputElement).value).toBe('');
    expect(document.getElementById('identityImportPanel')).not.toBeVisible();
    expect(screen.queryByText('Detected address')).not.toBeInTheDocument();
  });

  it('switches the identity source to a connected browser wallet', async () => {
    const connectedAddress = '0x2222222222222222222222222222222222222222';
    mockConnectBrowserWallet.mockResolvedValue({
      provider: { request: vi.fn() },
      browserProvider: {},
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
    });

    render(<VoteRoute />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));
    const connectWalletButton = screen.getByRole('button', { name: 'Connect browser wallet' });
    expect(connectWalletButton).not.toHaveClass('identity-action-btn-muted');
    fireEvent.click(connectWalletButton);

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Connected');
      expect(screen.getByText(/Connected with MetaMask/i)).toBeInTheDocument();
      expect((document.getElementById('walletAddressInput') as HTMLInputElement).value).toBe(connectedAddress);
    });

    expect(screen.queryByRole('button', { name: 'Copy private key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect browser wallet' })).not.toBeInTheDocument();
    const restoreLocalWalletButton = screen.getByRole('button', { name: 'Use local derived wallet' });
    expect(restoreLocalWalletButton).toHaveClass('identity-action-btn-muted');

    fireEvent.click(restoreLocalWalletButton);

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Derived');
      expect(screen.getByRole('button', { name: 'Connect browser wallet' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Use local derived wallet' })).not.toBeInTheDocument();
  });

  it('shows a clickable wallet widget in the registration popup', async () => {
    const connectedAddress = '0x2222222222222222222222222222222222222222';
    mockConnectBrowserWallet.mockResolvedValue({
      provider: { request: vi.fn() },
      browserProvider: {},
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
    });

    render(<VoteRoute />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser wallet' }));

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Connected');
    });

    fireEvent.click(document.getElementById('closeVoteIdentityBtn') as HTMLButtonElement);

    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit vote' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Complete Self verification to continue' })).toBeInTheDocument();
    });

    const registrationWalletWidget = document.getElementById('registrationWalletWidget') as HTMLButtonElement;
    expect(registrationWalletWidget).toBeInTheDocument();
    expect(registrationWalletWidget).toHaveTextContent('Connected');
    expect(registrationWalletWidget).toHaveTextContent('0x222222...2222');

    fireEvent.click(registrationWalletWidget);

    await waitFor(() => {
      expect(document.getElementById('voteRegistrationPopup')).not.toBeVisible();
      expect(screen.getByRole('dialog', { name: 'Identity Wallet' })).toBeInTheDocument();
      expect((document.getElementById('walletAddressInput') as HTMLInputElement).value).toBe(connectedAddress);
    });
  });

  it('regenerates the registration self qr when the popup is reopened with a different wallet', async () => {
    const connectedAddress = '0x3333333333333333333333333333333333333333';
    mockConnectBrowserWallet.mockResolvedValue({
      provider: { request: vi.fn() },
      browserProvider: {},
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
    });

    render(<VoteRoute />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));

    const derivedAddress = (document.getElementById('walletAddressInput') as HTMLInputElement).value;
    fireEvent.click(document.getElementById('closeVoteIdentityBtn') as HTMLButtonElement);

    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit vote' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Complete Self verification to continue' })).toBeInTheDocument();
      expect(mockSelfAppBuilderInputs).toHaveBeenCalledWith(expect.objectContaining({ userId: derivedAddress }));
    });

    fireEvent.click(document.querySelector('#voteRegistrationPopup .app-popup-close') as HTMLButtonElement);

    await waitFor(() => {
      expect(document.getElementById('voteRegistrationPopup')).not.toBeVisible();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser wallet' }));

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Connected');
    });

    fireEvent.click(document.getElementById('closeVoteIdentityBtn') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: 'Submit vote' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Complete Self verification to continue' })).toBeInTheDocument();
      expect(mockSelfAppBuilderInputs).toHaveBeenCalledWith(expect.objectContaining({ userId: connectedAddress }));
    });

    expect(mockSelfAppBuilderInputs).toHaveBeenCalledTimes(2);
  });

  it('restores a connected wallet after refresh when the provider can resume silently', async () => {
    const connectedAddress = '0x4444444444444444444444444444444444444444';
    const connectedWallet = {
      provider: { request: vi.fn() },
      browserProvider: {},
      signer: { signMessage: vi.fn() },
      address: connectedAddress,
      sourceLabel: 'MetaMask',
      connectorType: 'injected' as const,
    };

    mockConnectBrowserWallet.mockResolvedValue(connectedWallet);

    const firstRender = render(<VoteRoute />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser wallet' }));

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Connected');
    });

    firstRender.unmount();

    mockResumeConnectedBrowserWallet.mockResolvedValue(connectedWallet);

    render(<VoteRoute />);

    await waitFor(() => {
      expect(mockResumeConnectedBrowserWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          address: connectedAddress,
          sourceLabel: 'MetaMask',
          connectorType: 'injected',
        }),
        undefined
      );
      expect(screen.getByRole('button', { name: 'Identity' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identity' }));

    await waitFor(() => {
      expect(document.getElementById('walletSource')).toHaveTextContent('Connected');
      expect((document.getElementById('walletAddressInput') as HTMLInputElement).value).toBe(connectedAddress);
    });
  });
});
