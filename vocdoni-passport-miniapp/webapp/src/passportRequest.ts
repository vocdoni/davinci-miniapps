// Vocdoni Passport proof request payload builder.

export interface PassportRequestPayload {
  kind: 'vocdoni-passport-request';
  version: number;
  aggregateUrl: string;
  processId?: string;
  censusContract: string;
  // Voter's Ethereum address. Triggers the bind_evm circuit in the passport app,
  // linking the proof to this address on-chain.
  walletAddress?: string;
  // Chain name for the bind_evm circuit (e.g. "ethereum_sepolia").
  bindChain?: string;
  service: {
    name: string;
    purpose?: string;
    scope: string;
    mode?: string;
  };
  query?: Record<string, unknown>;
}

export function buildPassportPayload(params: {
  backendUrl: string;
  processId?: string;
  censusContract: string;
  walletAddress?: string;
  bindChain?: string;
  scope: string;
  appName?: string;
}): PassportRequestPayload {
  return {
    kind: 'vocdoni-passport-request',
    version: 1,
    aggregateUrl: `${params.backendUrl.replace(/\/+$/, '')}/api/proofs/aggregate`,
    processId: params.processId || undefined,
    censusContract: params.censusContract,
    walletAddress: params.walletAddress || undefined,
    bindChain: params.bindChain || undefined,
    service: {
      name: params.appName || 'Vocdoni Passport',
      scope: params.scope || 'davinci-census',
    },
  };
}

// Returns an <img> src URL for a server-rendered QR code of the payload.
export function buildPassportQRUrl(backendUrl: string, payload: PassportRequestPayload): string {
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${backendUrl.replace(/\/+$/, '')}/api/request-qr.png?payload=${encodeURIComponent(b64)}`;
}

// Returns the deep-link URL to open in the Vocdoni Passport mobile app.
export function buildPassportDeepLink(backendUrl: string, payload: PassportRequestPayload): string {
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${backendUrl.replace(/\/+$/, '')}/passport?request=${b64}`;
}
