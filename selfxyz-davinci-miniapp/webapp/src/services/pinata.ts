import { PinataSDK } from 'pinata';
import type { ElectionMetadata } from '@vocdoni/davinci-sdk';

import { COPY } from '../copy';
import { CONFIG } from '../lib/occ';
import { buildPublicIpfsGatewayUrl } from '../utils/ipfs';

interface PinataGatewayApi {
}

interface PinataUploadApi {
  upload: {
    public: {
      json: (metadata: ElectionMetadata) => Promise<{ cid?: string | null }>;
    };
  };
  gateways?: PinataGatewayApi;
}

export interface PinataConfigInput {
  pinataJwt?: string;
  pinataGatewayUrl?: string;
  pinataPublicGatewayUrl?: string;
  pinataUploadUrl?: string;
}

interface ResolvedPinataConfig {
  pinataJwt: string;
  pinataGatewayUrl: string;
  pinataPublicGatewayUrl: string;
  pinataUploadUrl?: string;
}

let cachedClient: PinataUploadApi | null = null;
let cachedClientKey = '';

export function normalizePinataGatewayUrl(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function resolvePinataConfig(input: PinataConfigInput = {}): ResolvedPinataConfig {
  const pinataJwt = String(input.pinataJwt ?? import.meta.env.VITE_PINATA_JWT ?? '').trim();
  const pinataGatewayUrl = normalizePinataGatewayUrl(
    String(input.pinataGatewayUrl ?? import.meta.env.VITE_PINATA_GATEWAY_URL ?? '').trim()
  );
  const pinataPublicGatewayUrl = String(
    input.pinataPublicGatewayUrl ?? CONFIG.pinataPublicGatewayUrl ?? 'https://gateway.pinata.cloud'
  ).trim();
  const pinataUploadUrl = String(input.pinataUploadUrl ?? (import.meta.env.DEV ? '/pinata-upload' : '')).trim();

  if (!pinataJwt) {
    throw new Error(COPY.create.errors.missingPinataJwt);
  }
  if (!pinataGatewayUrl) {
    throw new Error(COPY.create.errors.missingPinataGatewayUrl);
  }

  return {
    pinataJwt,
    pinataGatewayUrl,
    pinataPublicGatewayUrl,
    pinataUploadUrl: pinataUploadUrl || undefined,
  };
}

function createPinataClient(config: ResolvedPinataConfig): PinataUploadApi {
  return new PinataSDK({
    pinataJwt: config.pinataJwt,
    pinataGateway: config.pinataGatewayUrl,
    uploadUrl: config.pinataUploadUrl,
  }) as unknown as PinataUploadApi;
}

function getPinataClient(config: ResolvedPinataConfig): PinataUploadApi {
  const cacheKey = `${config.pinataJwt}::${config.pinataGatewayUrl}::${config.pinataPublicGatewayUrl}::${config.pinataUploadUrl || ''}`;
  if (cachedClient && cachedClientKey === cacheKey) {
    return cachedClient;
  }

  cachedClient = createPinataClient(config);
  cachedClientKey = cacheKey;
  return cachedClient;
}

export function convertCidToPinataGatewayUrl(cid: string, gatewayUrl: string): string {
  return buildPublicIpfsGatewayUrl(cid, gatewayUrl);
}

export async function uploadElectionMetadata(
  metadata: ElectionMetadata,
  input: PinataConfigInput = {}
): Promise<string> {
  const config = resolvePinataConfig(input);
  const client = getPinataClient(config);

  try {
    const upload = await client.upload.public.json(metadata);
    const cid = String(upload?.cid || '').trim();
    if (!cid) {
      throw new Error('Pinata upload did not return a CID.');
    }

    return convertCidToPinataGatewayUrl(cid, config.pinataPublicGatewayUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Pinata upload error.';
    throw new Error(`${COPY.create.errors.pinataMetadataUploadFailed} ${message}`.trim());
  }
}
