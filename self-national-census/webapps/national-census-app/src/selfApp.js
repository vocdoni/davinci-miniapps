const REDIRECT_URL = 'https://redirect.self.xyz';
const WS_DB_RELAYER = 'wss://websocket.self.xyz';

const ASCII_RE = /^[\x00-\x7F]*$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getUniversalLink(selfApp) {
  return `${REDIRECT_URL}?selfApp=${encodeURIComponent(JSON.stringify(selfApp))}`;
}

export function getQrLink(selfApp) {
  return `${REDIRECT_URL}?sessionId=${encodeURIComponent(selfApp.sessionId)}`;
}

export { WS_DB_RELAYER };
function formatEndpoint(endpoint) {
  if (!endpoint) return '';
  return endpoint.replace(/^https?:\/\//, '').split('/')[0];
}

function validateUserId(userId, type) {
  if (type === 'hex') return HEX_RE.test(userId);
  if (type === 'uuid') return UUID_RE.test(userId);
  return false;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
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
}) {
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
