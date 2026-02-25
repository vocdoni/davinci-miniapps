import { BrowserProvider, type Eip1193Provider, type JsonRpcSigner, Wallet } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';

import { ACTIVE_NETWORK, CONFIG, NETWORKS } from '../lib/occ';

export interface OCCProvider extends Eip1193Provider {
  enable?: () => Promise<unknown>;
  disconnect?: () => Promise<void>;
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: OCCProvider[];
}

export interface CreatorWalletConnection {
  provider: OCCProvider;
  browserProvider: BrowserProvider;
  signer: JsonRpcSigner;
  address: string;
  sourceLabel: string;
}

export interface ManagedWalletSnapshot {
  address: string;
  privateKey: string;
  source: 'derived' | 'imported';
}

export function walletFromPrivateKey(privateKey: string, source: ManagedWalletSnapshot['source']): ManagedWalletSnapshot {
  const wallet = new Wallet(privateKey);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    source,
  };
}

export function getInjectedProvider(): OCCProvider | null {
  const ethereum = (window as Window & { ethereum?: OCCProvider }).ethereum;
  if (!ethereum) return null;

  if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
    const metamaskProvider = ethereum.providers.find((provider) => provider?.isMetaMask && !provider?.isBraveWallet);
    return metamaskProvider || ethereum.providers[0] || null;
  }

  return ethereum;
}

export function getWalletSourceLabel(provider: OCCProvider, fallback = 'WalletConnect'): string {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  return fallback;
}

export async function ensureProviderChain(provider: OCCProvider, chainHex = ACTIVE_NETWORK.chainHex): Promise<void> {
  const currentChainId = await provider.request({ method: 'eth_chainId' });
  if (String(currentChainId).toLowerCase() === String(chainHex).toLowerCase()) {
    return;
  }

  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: chainHex }],
  });
}

export async function createWalletConnectProvider(): Promise<OCCProvider> {
  if (!CONFIG.walletConnectProjectId) {
    throw new Error('Missing VITE_WALLETCONNECT_PROJECT_ID.');
  }

  const requiredChains = [1];
  const optionalChainsValues = Array.from(
    new Set([1, ACTIVE_NETWORK.chainId, ...Object.values(NETWORKS).map((network) => network.chainId)])
  );
  const optionalChains = (optionalChainsValues.length ? optionalChainsValues : [1]) as [number, ...number[]];

  return (await EthereumProvider.init({
    projectId: CONFIG.walletConnectProjectId,
    chains: requiredChains,
    optionalChains,
    showQrModal: true,
    metadata: {
      name: 'Open Citizen Census',
      description: 'Create and vote on census-based processes',
      url: window.location.origin,
      icons: [],
    },
    rpcMap: ACTIVE_NETWORK.rpcUrl ? { [ACTIVE_NETWORK.chainId]: ACTIVE_NETWORK.rpcUrl } : undefined,
    methods: [
      'eth_sendTransaction',
      'eth_signTransaction',
      'eth_sign',
      'personal_sign',
      'eth_signTypedData',
      'eth_estimateGas',
      'eth_call',
      'eth_chainId',
      'wallet_switchEthereumChain',
    ],
  })) as OCCProvider;
}

export async function connectInjectedWallet(provider: OCCProvider): Promise<CreatorWalletConnection> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error('No wallet account selected.');
  }

  await ensureProviderChain(provider);

  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner(accounts[0]);
  const address = await signer.getAddress();

  return {
    provider,
    browserProvider,
    signer,
    address,
    sourceLabel: getWalletSourceLabel(provider, 'Browser wallet'),
  };
}

export async function connectWalletConnect(existingProvider?: OCCProvider | null): Promise<CreatorWalletConnection> {
  let provider = existingProvider || null;

  if (!provider || typeof provider.enable !== 'function') {
    provider = await createWalletConnectProvider();
  }

  await provider.enable?.();
  await ensureProviderChain(provider);

  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();

  return {
    provider,
    browserProvider,
    signer,
    address,
    sourceLabel: 'WalletConnect',
  };
}

export async function connectBrowserWallet(existingProvider?: OCCProvider | null): Promise<CreatorWalletConnection> {
  const injectedProvider = getInjectedProvider();
  if (injectedProvider) {
    return connectInjectedWallet(injectedProvider);
  }
  return connectWalletConnect(existingProvider);
}

export async function disconnectWalletConnection(provider: OCCProvider | null | undefined): Promise<void> {
  if (!provider) return;

  if (typeof provider.disconnect === 'function' && typeof provider.enable === 'function') {
    try {
      await provider.disconnect();
    } catch {
      // Ignore provider disconnect errors and clear local app state anyway.
    }
  }
}
