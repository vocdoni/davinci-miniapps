// Vocdoni Passport proof request payload builder.
// Replaces the Self.xyz SelfAppBuilder flow.

export interface PassportRequestPayload {
  kind: 'vocdoni-passport-request';
  version: number;
  aggregateUrl: string;
  processId?: string;
  censusContract?: string;
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
  // When provided, generates a bind_evm disclosure (outer_evm_count_4) instead of
  // fast-mode disclosures. Required for census registration.
  walletAddress?: string;
  // zkPassport SupportedChain string for the bind circuit (e.g. "ethereum_sepolia").
  bindChain?: string;
  scope: string;
  minAge?: number | null;
  countries?: string[];
  appName?: string;
}): PassportRequestPayload {
  const walletAddress = params.walletAddress;

  if (walletAddress) {
    // Census-registration mode: exactly 1 disclosure (bind_evm) → outer_evm_count_4.
    // No mode:'fast' and no age/nationality to keep the disclosure count at 1,
    // matching the ZKPassportCensus contract's EXPECTED_PUBLIC_INPUTS=9.
    return {
      kind: 'vocdoni-passport-request',
      version: 1,
      aggregateUrl: `${params.backendUrl.replace(/\/+$/, '')}/api/proofs/aggregate`,
      processId: params.processId || undefined,
      censusContract: params.censusContract || undefined,
      service: {
        name: params.appName || 'Vocdoni Passport',
        scope: params.scope || 'davinci-census',
      },
      query: {
        bind: {
          user_address: walletAddress,
          chain: params.bindChain || 'ethereum_sepolia',
        },
      },
    };
  }

  const query: Record<string, unknown> = {};
  if (params.minAge && params.minAge > 0) {
    query['age'] = { gte: params.minAge };
  }
  if (params.countries && params.countries.length > 0) {
    query['nationality'] = { in: params.countries };
  }
  return {
    kind: 'vocdoni-passport-request',
    version: 1,
    aggregateUrl: `${params.backendUrl.replace(/\/+$/, '')}/api/proofs/aggregate`,
    processId: params.processId || undefined,
    censusContract: params.censusContract || undefined,
    service: {
      name: params.appName || 'Vocdoni Passport',
      scope: params.scope || 'davinci-census',
      mode: 'fast',
    },
    query: Object.keys(query).length > 0 ? query : undefined,
  };
}

// Returns an <img> src URL for a server-rendered QR code of the payload.
// The backend's GET /api/request-qr.png endpoint accepts a ?payload= base64url param.
export function buildPassportQRUrl(backendUrl: string, payload: PassportRequestPayload): string {
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${backendUrl.replace(/\/+$/, '')}/api/request-qr.png?payload=${encodeURIComponent(b64)}`;
}

// Returns the deep-link URL to open in the Vocdoni Passport mobile app.
// Format: {backendUrl}/passport?request=<base64url_payload>
export function buildPassportDeepLink(backendUrl: string, payload: PassportRequestPayload): string {
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${backendUrl.replace(/\/+$/, '')}/passport?request=${b64}`;
}
