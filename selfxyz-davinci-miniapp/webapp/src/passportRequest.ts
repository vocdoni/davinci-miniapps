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
  walletAddress?: string;
  scope: string;
  minAge?: number | null;
  countries?: string[];
  appName?: string;
}): PassportRequestPayload {
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
