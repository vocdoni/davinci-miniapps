const REDIRECT_URL = 'https://redirect.self.xyz';

const ASCII_RE = /^[\x00-\x7F]*$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SelfEndpointType = 'celo' | 'staging_celo';
export type SelfUserIdType = 'hex' | 'uuid';

export interface SelfDisclosures {
  minimumAge?: number;
  nationality?: boolean;
  [key: string]: unknown;
}

export interface SelfAppPayload {
  appName: string;
  logoBase64: string;
  endpointType: SelfEndpointType;
  endpoint: string;
  deeplinkCallback: string;
  header: string;
  scope: string;
  sessionId: string;
  userId: string;
  userIdType: SelfUserIdType;
  devMode: boolean;
  disclosures: SelfDisclosures;
  version: number;
  chainID: number;
  userDefinedData: string;
  selfDefinedData?: string;
}

export interface BuildSelfAppInput {
  appName: string;
  scope: string;
  endpoint: string;
  endpointType: SelfEndpointType;
  userId: string;
  userIdType?: SelfUserIdType;
  disclosures?: SelfDisclosures;
  userDefinedData?: string;
  deeplinkCallback?: string;
}

export function getUniversalLink(selfApp: unknown): string {
  return `${REDIRECT_URL}?selfApp=${encodeURIComponent(JSON.stringify(selfApp))}`;
}

export function getQrLink(selfApp: { sessionId: string }): string {
  return `${REDIRECT_URL}?sessionId=${encodeURIComponent(selfApp.sessionId)}`;
}

function formatEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  return endpoint.replace(/^https?:\/\//, '').split('/')[0] || '';
}

function validateUserId(userId: string, type: SelfUserIdType): boolean {
  if (type === 'hex') return HEX_RE.test(userId);
  if (type === 'uuid') return UUID_RE.test(userId);
  return false;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `session-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

export function buildSelfApp({
  appName,
  scope,
  endpoint,
  endpointType,
  userId,
  userIdType = 'hex',
  disclosures = {},
  userDefinedData = '',
  deeplinkCallback = '',
}: BuildSelfAppInput): SelfAppPayload {
  assert(appName, 'appName is required');
  assert(scope, 'scope is required');
  assert(endpoint, 'endpoint is required');
  assert(userId, 'userId is required');
  assert(ASCII_RE.test(scope), 'scope must contain only ASCII characters');
  assert(ASCII_RE.test(endpoint), 'endpoint must contain only ASCII characters');
  assert(scope.length <= 31, 'scope must be 31 chars or less');

  const formattedEndpoint = formatEndpoint(endpoint);
  assert(formattedEndpoint.length <= 496, 'endpoint must be less than 496 characters');
  assert(
    !formattedEndpoint.includes('localhost') && !formattedEndpoint.includes('127.0.0.1'),
    'localhost endpoints are not allowed'
  );

  assert(endpointType === 'celo' || endpointType === 'staging_celo', 'invalid endpoint type');
  assert(endpoint.startsWith('0x'), 'endpoint must be a valid address');

  let normalizedUserId = userId.trim();
  if (userIdType === 'hex' && normalizedUserId.startsWith('0x')) {
    normalizedUserId = normalizedUserId.slice(2);
  }

  assert(validateUserId(normalizedUserId, userIdType), 'userId is invalid for userIdType');

  return {
    appName,
    logoBase64: '',
    endpointType,
    endpoint,
    deeplinkCallback,
    header: '',
    scope,
    sessionId: newSessionId(),
    userId: normalizedUserId,
    userIdType,
    devMode: false,
    disclosures,
    version: 2,
    chainID: endpointType === 'staging_celo' ? 11142220 : 42220,
    userDefinedData,
    selfDefinedData: '',
  };
}
