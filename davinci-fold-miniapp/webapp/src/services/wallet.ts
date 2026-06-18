import { BrowserProvider, type Eip1193Provider, type JsonRpcSigner } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { WALLETCONNECT_PROJECT_ID } from '../lib/dfc';

export interface FoldProvider extends Eip1193Provider {
  enable?: () => Promise<unknown>;
  disconnect?: () => Promise<void>;
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: FoldProvider[];
}

export interface WalletConnection {
  provider: FoldProvider;
  browserProvider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  sourceLabel: string;
  connectorType: 'injected' | 'walletconnect';
}

function getInjectedProvider(): FoldProvider | null {
  const ethereum = (window as Window & { ethereum?: FoldProvider }).ethereum;
  if (!ethereum) return null;
  if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
    const mm = ethereum.providers.find((p) => p?.isMetaMask && !p?.isBraveWallet);
    return mm || ethereum.providers[0] || null;
  }
  return ethereum;
}

function sourceLabel(provider: FoldProvider, fallback = 'WalletConnect'): string {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  return fallback;
}

async function createWalletConnectProvider(): Promise<FoldProvider> {
  if (!WALLETCONNECT_PROJECT_ID) throw new Error('VITE_WALLETCONNECT_PROJECT_ID is not set.');
  return (await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [1],
    optionalChains: [1],
    showQrModal: true,
    metadata: {
      name: 'Fold Vote - DAVINCI',
      description: 'Wallet-based voting powered by DAVINCI Fold',
      url: window.location.origin,
      icons: [],
    },
    methods: ['eth_sign', 'personal_sign', 'eth_accounts', 'eth_chainId'],
  })) as FoldProvider;
}

async function connectInjected(provider: FoldProvider): Promise<WalletConnection> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('No wallet account selected.');
  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner(accounts[0]);
  const address = await signer.getAddress();
  return { provider, browserProvider, signer, address, sourceLabel: sourceLabel(provider, 'Browser wallet'), connectorType: 'injected' };
}

async function connectWC(existing?: FoldProvider | null): Promise<WalletConnection> {
  const provider = existing || (await createWalletConnectProvider());
  await provider.enable?.();
  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();
  return { provider, browserProvider, signer, address, sourceLabel: 'WalletConnect', connectorType: 'walletconnect' };
}

export async function connectBrowserWallet(existing?: FoldProvider | null): Promise<WalletConnection> {
  const injected = getInjectedProvider();
  if (injected) return connectInjected(injected);
  return connectWC(existing);
}

export async function disconnectWallet(provider: FoldProvider | null | undefined): Promise<void> {
  if (!provider) return;
  if (typeof provider.disconnect === 'function' && typeof provider.enable === 'function') {
    try {
      await provider.disconnect();
    } catch {
      // ignore
    }
  }
}
