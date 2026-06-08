// Vocdoni Passport proof request payload builder.

export interface PassportRequestPayload {
  kind: 'vocdoni-passport-request';
  version: number;
  aggregateUrl: string;
  processId?: string;
  censusContract?: string;
  // Voter's Ethereum address. Relayed by the Android app to the backend so the
  // backend knows which address to register in the census contract.
  walletAddress?: string;
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
  censusContract?: string;
  walletAddress?: string;
  scope: string;
  appName?: string;
}): PassportRequestPayload {
  return {
    kind: 'vocdoni-passport-request',
    version: 1,
    aggregateUrl: `${params.backendUrl.replace(/\/+$/, '')}/api/proofs/aggregate`,
    processId: params.processId || undefined,
    censusContract: params.censusContract || undefined,
    walletAddress: params.walletAddress || undefined,
    service: {
      name: params.appName || 'Vocdoni Passport',
      scope: params.scope || 'davinci-census',
    },
    query: { gender: { disclose: true } },
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
