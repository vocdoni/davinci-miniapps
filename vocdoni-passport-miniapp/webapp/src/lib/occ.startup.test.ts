import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('occ.ts startup validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const globalScope = globalThis as unknown as { Worker?: typeof Worker };
    if (typeof globalScope.Worker === 'undefined') {
      globalScope.Worker = class WorkerMock {} as unknown as typeof Worker;
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes ACTIVE_NETWORK when VITE_NETWORK and VITE_CHAIN_ID agree', async () => {
    vi.stubEnv('VITE_NETWORK', 'sepolia');
    vi.stubEnv('VITE_CHAIN_ID', '11155111');

    const occ = await import('./occ');
    expect(occ.ACTIVE_NETWORK.chainId).toBe(11155111);
    expect(occ.CONFIG.network).toBe('sepolia');
    expect(occ.CONFIG.chainId).toBe(11155111);
  });

  it('throws when VITE_NETWORK is not a known key', async () => {
    vi.stubEnv('VITE_NETWORK', 'mars');
    vi.stubEnv('VITE_CHAIN_ID', '11155111');

    await expect(import('./occ')).rejects.toThrow(/VITE_NETWORK.*mars/);
  });

  it('throws when VITE_CHAIN_ID is not finite', async () => {
    vi.stubEnv('VITE_NETWORK', 'sepolia');
    vi.stubEnv('VITE_CHAIN_ID', 'not-a-number');

    await expect(import('./occ')).rejects.toThrow(/VITE_CHAIN_ID/);
  });

  it('throws when VITE_NETWORK and VITE_CHAIN_ID disagree', async () => {
    vi.stubEnv('VITE_NETWORK', 'sepolia');
    vi.stubEnv('VITE_CHAIN_ID', '42220');

    await expect(import('./occ')).rejects.toThrow(/chain id mismatch.*11155111.*42220/i);
  });
});
