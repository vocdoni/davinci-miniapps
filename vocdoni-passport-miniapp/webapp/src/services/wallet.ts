import { BrowserProvider, type Eip1193Provider, type JsonRpcSigner } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';

import { COPY } from '../copy';
import type { ConnectedWalletPreference } from '../lib/occ';
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
  connectorType: 'injected' | 'walletconnect';
}

function getInjectedProvider(): OCCProvider | null {
  const ethereum = (window as Window & { ethereum?: OCCProvider }).ethereum;
  if (!ethereum) return null;

  if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
    const metamaskProvider = ethereum.providers.find((provider) => provider?.isMetaMask && !provider?.isBraveWallet);
    return metamaskProvider || ethereum.providers[0] || null;
  }

  return ethereum;
}

function getWalletSourceLabel(provider: OCCProvider, fallback: string = COPY.walletService.walletConnectFallbackSource): string {
  if (provider?.isMetaMask) return COPY.walletService.metaMask;
  if (provider?.isCoinbaseWallet) return COPY.walletService.coinbaseWallet;
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

async function createWalletConnectProvider(): Promise<OCCProvider> {
  if (!CONFIG.walletConnectProjectId) {
    throw new Error(COPY.walletService.missingProjectId);
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
      name: COPY.brand.documentTitle,
      description: COPY.walletService.appDescription,
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

async function connectInjectedWallet(provider: OCCProvider): Promise<CreatorWalletConnection> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error(COPY.walletService.noWalletAccount);
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
    sourceLabel: getWalletSourceLabel(provider, COPY.walletService.browserWallet),
    connectorType: 'injected',
  };
}

async function connectWalletConnect(existingProvider?: OCCProvider | null): Promise<CreatorWalletConnection> {
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
    sourceLabel: COPY.walletService.walletConnectFallbackSource,
    connectorType: 'walletconnect',
  };
}

export async function connectBrowserWallet(existingProvider?: OCCProvider | null): Promise<CreatorWalletConnection> {
  const injectedProvider = getInjectedProvider();
  if (injectedProvider) {
    return connectInjectedWallet(injectedProvider);
  }
  return connectWalletConnect(existingProvider);
}

async function getAuthorizedAccounts(provider: OCCProvider): Promise<string[]> {
  try {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts)) return [];
    return accounts.map((account) => String(account || '').trim()).filter((account) => /^0x[a-fA-F0-9]{40}$/.test(account));
  } catch {
    return [];
  }
}

export async function resumeConnectedBrowserWallet(
  preference: ConnectedWalletPreference,
  existingProvider?: OCCProvider | null
): Promise<CreatorWalletConnection | null> {
  const expectedAddress = String(preference?.address || '').trim().toLowerCase();
  if (!expectedAddress) return null;

  if (preference.connectorType === 'injected') {
    const provider = getInjectedProvider();
    if (!provider) return null;
    const accounts = await getAuthorizedAccounts(provider);
    if (!accounts.length) return null;

    await ensureProviderChain(provider);

    const preferredAccount = accounts.find((account) => account.toLowerCase() === expectedAddress) || accounts[0];
    const browserProvider = new BrowserProvider(provider, 'any');
    const signer = await browserProvider.getSigner(preferredAccount);
    const address = await signer.getAddress();

    return {
      provider,
      browserProvider,
      signer,
      address,
      sourceLabel: getWalletSourceLabel(provider, preference.sourceLabel || COPY.walletService.browserWallet),
      connectorType: 'injected',
    };
  }

  let provider = existingProvider || null;
  if (!provider) {
    try {
      provider = await createWalletConnectProvider();
    } catch {
      return null;
    }
  }

  const walletConnectProvider = provider as OCCProvider & { session?: unknown; accounts?: unknown };
  const accounts =
    Array.isArray(walletConnectProvider.accounts) && walletConnectProvider.accounts.length
      ? walletConnectProvider.accounts.map((account) => String(account || '').trim())
      : await getAuthorizedAccounts(provider);

  if (!walletConnectProvider.session || !accounts.length) return null;

  await ensureProviderChain(provider);

  const preferredAccount = accounts.find((account) => account.toLowerCase() === expectedAddress) || accounts[0];
  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner(preferredAccount);
  const address = await signer.getAddress();

  return {
    provider,
    browserProvider,
    signer,
    address,
    sourceLabel: preference.sourceLabel || COPY.walletService.walletConnectFallbackSource,
    connectorType: 'walletconnect',
  };
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
