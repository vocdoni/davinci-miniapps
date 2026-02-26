import { ACTIVE_NETWORK, encodeWeightOf } from '../lib/occ';

export async function ethCall(to: string, data: string, rpcUrl = ACTIVE_NETWORK.rpcUrl): Promise<string> {
  if (!rpcUrl) {
    throw new Error('RPC unavailable for active network.');
  }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });

  const json = (await response.json()) as { error?: { message?: string }; result?: string };
  if (json.error) {
    throw new Error(json.error.message || 'eth_call failed');
  }

  return json.result || '0x0';
}

export async function fetchOnchainWeight(contractAddress: string, address: string): Promise<bigint> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
    return 0n;
  }

  const result = await ethCall(contractAddress, encodeWeightOf(address));
  return BigInt(result || '0x0');
}
