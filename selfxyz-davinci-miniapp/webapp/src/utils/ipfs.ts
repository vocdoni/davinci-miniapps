const DEFAULT_PUBLIC_IPFS_GATEWAY_URL = 'https://gateway.pinata.cloud';

function sanitizeCidSegment(value: string): string {
  return String(value || '').trim().split(/[/?#]/, 1)[0] || '';
}

export function normalizeIpfsGatewayBaseUrl(value: string): string {
  const trimmed = String(value || '').trim();
  const normalized = trimmed || DEFAULT_PUBLIC_IPFS_GATEWAY_URL;
  const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  return withProtocol.replace(/\/+$/, '');
}

export function buildPublicIpfsGatewayUrl(cid: string, gatewayBaseUrl?: string): string {
  const safeCid = sanitizeCidSegment(cid);
  return `${normalizeIpfsGatewayBaseUrl(gatewayBaseUrl || DEFAULT_PUBLIC_IPFS_GATEWAY_URL)}/ipfs/${safeCid}`;
}

export function extractCidFromIpfsUrl(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('ipfs://')) {
    return sanitizeCidSegment(trimmed.slice('ipfs://'.length));
  }

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    const ipfsIndex = segments.findIndex((segment) => segment === 'ipfs');
    if (ipfsIndex >= 0 && segments[ipfsIndex + 1]) {
      return sanitizeCidSegment(segments[ipfsIndex + 1]);
    }

    const hostMatch = url.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
    if (hostMatch?.[1]) {
      return sanitizeCidSegment(hostMatch[1]);
    }
  } catch {
    return '';
  }

  return '';
}

export function buildMetadataFetchCandidates(metadataUri: string, publicGatewayBaseUrl?: string): string[] {
  const primary = String(metadataUri || '').trim();
  if (!primary) return [];

  const candidates = [primary];
  const cid = extractCidFromIpfsUrl(primary);
  if (!cid) return candidates;

  const fallback = buildPublicIpfsGatewayUrl(cid, publicGatewayBaseUrl);
  if (!candidates.includes(fallback)) {
    candidates.push(fallback);
  }

  return candidates;
}
