import { Wallet } from 'ethers';

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
