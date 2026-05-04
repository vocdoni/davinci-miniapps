import { AbiCoder, Interface, Wallet, keccak256, randomBytes, sha256, toUtf8Bytes } from 'ethers';
import { ProcessStatus } from '@vocdoni/davinci-sdk';
import type { BallotMode } from '@vocdoni/davinci-sdk';
import type { SequencerMetadata, SequencerProcess } from '../services/sequencer';

import artifact from '../artifacts/OpenCitizenCensus.json';
import { COPY } from '../copy';
import { isAsciiText, isValidCountryCode, normalizeCountry, normalizeMinAge, normalizeProcessId, normalizeScope } from '../utils/normalization';
import { toRecord } from '../utils/records';
import { toDateFromUnknown, toDurationMs, toRfc3339Timestamp } from '../utils/timing';

const env = import.meta.env;
export const BASE_URL = env.BASE_URL || '/';

export interface NetworkConfig {
  chainId: number;
  chainHex: string;
  label: string;
  hubAddress: string;
  poseidonT3Address: string;
  rpcUrl: string;
  explorerBaseUrl: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  celo: {
    chainId: 42220,
    chainHex: '0xa4ec',
    label: 'Celo Mainnet',
    hubAddress: '0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF',
    poseidonT3Address: '0xF134707a4C4a3a76b8410fC0294d620A7c341581',
    rpcUrl: 'https://forno.celo.org',
    explorerBaseUrl: 'https://celoscan.io',
  },
  staging_celo: {
    chainId: 44787,
    chainHex: '0xaef3',
    label: 'Celo Sepolia',
    hubAddress: '0x16ECBA51e18a4a7e61fdC417f0d47AFEeDfbed74',
    poseidonT3Address: '0x0A782f7F9f8AaC6E0BACAF3cd4Aa292C3275c6F2',
    rpcUrl: 'https://forno.celo-sepolia.celo-testnet.org',
    explorerBaseUrl: 'https://celo-sepolia.blockscout.com',
  },
};

export const CONFIG = {
  network: String(env.VITE_NETWORK || 'celo').trim(),
  onchainIndexerUrl: String(env.VITE_ONCHAIN_CENSUS_INDEXER_URL || '').trim(),
  davinciSequencerUrl: String(env.VITE_DAVINCI_SEQUENCER_URL || '').trim(),
  walletConnectProjectId: String(env.VITE_WALLETCONNECT_PROJECT_ID || '').trim(),
  selfAppName: String(env.VITE_SELF_APP_NAME || COPY.brand.documentTitle).trim(),
  txExplorerBaseUrl: String(env.VITE_TX_EXPLORER_BASE_URL || '').trim(),
};

export const ACTIVE_NETWORK = NETWORKS[CONFIG.network] || NETWORKS.celo;

export const EMPTY_COUNTRIES = [0n, 0n, 0n, 0n] as const;
export const EMPTY_OFAC = [false, false, false] as const;
export const VOTE_POLL_MS = 10_000;
export const WEIGHT_OF_SELECTOR = '0xdd4bc101';
export const LAST_SCOPE_SEED_KEY = 'occ.lastScopeSeed.v1';
export const MASTER_SECRET_KEY = 'occ.masterSecret.v1';
export const VOTE_SUBMISSION_STORAGE_PREFIX = 'occ.voteSubmission.v1';
export const INTERNAL_RPC_RETRY_MAX_ATTEMPTS = 4;
export const INTERNAL_RPC_RETRY_DELAY_MS = 1_500;

export const DEFAULT_DOCUMENT_TITLE = COPY.brand.documentTitle;
export const CREATE_HEADER_TITLE = COPY.occ.createHeaderTitle;
export const VOTE_HEADER_TITLE = COPY.occ.voteHeaderTitle;

export const CENSUS_MEMBERS_QUERY = `
  query GetWeightChangeEvents($first: Int!, $skip: Int!) {
    weightChangeEvents(
      first: $first
      skip: $skip
      orderBy: blockNumber
      orderDirection: asc
    ) {
      account {
        id
      }
      previousWeight
      newWeight
    }
  }
`;

export const HUB_INTERFACE = new Interface([
  'function setVerificationConfigV2((bool olderThanEnabled,uint256 olderThan,bool forbiddenCountriesEnabled,uint256[4] forbiddenCountriesListPacked,bool[3] ofacEnabled)) returns (bytes32)',
  'function verificationConfigV2Exists(bytes32) view returns (bool)',
]);

export const CENSUS_INTERFACE = new Interface([
  'function minAge() view returns (uint256)',
]);

export interface PipelineStageDef {
  id: string;
  label: string;
}

export interface PipelineStageState {
  id: string;
  status: 'pending' | 'running' | 'success' | 'error';
  message: string;
}

export const PIPELINE_STAGES: PipelineStageDef[] = [
  { id: 'validate_form', label: COPY.occ.pipelineStages.validateForm },
  { id: 'connect_creator_wallet_walletconnect', label: COPY.occ.pipelineStages.connectCreatorWallet },
  { id: 'ensure_self_config_registered', label: COPY.occ.pipelineStages.ensureSelfConfigRegistered },
  { id: 'deploy_census_contract', label: COPY.occ.pipelineStages.deployCensusContract },
  { id: 'start_indexer', label: COPY.occ.pipelineStages.startIndexer },
  { id: 'wait_indexer_ready', label: COPY.occ.pipelineStages.waitIndexerReady },
  { id: 'create_davinci_process', label: COPY.occ.pipelineStages.createDavinciProcess },
  { id: 'wait_process_ready_in_sequencer', label: COPY.occ.pipelineStages.waitProcessReadyInSequencer },
  { id: 'done', label: COPY.occ.pipelineStages.done },
];

export function newPipelineState(): PipelineStageState[] {
  return PIPELINE_STAGES.map((stage) => ({
    id: stage.id,
    status: 'pending',
    message: COPY.shared.pending,
  }));
}

export const VOTE_STATUS_FLOW = ['pending', 'verified', 'aggregated', 'processed', 'settled'] as const;
export type VoteStatusKey = (typeof VOTE_STATUS_FLOW)[number] | 'error';

export const VOTE_STATUS_INFO: Record<VoteStatusKey, { label: string; description: string }> = {
  pending: {
    label: COPY.occ.voteStatusInfo.pending.label,
    description: COPY.occ.voteStatusInfo.pending.description,
  },
  verified: {
    label: COPY.occ.voteStatusInfo.verified.label,
    description: COPY.occ.voteStatusInfo.verified.description,
  },
  aggregated: {
    label: COPY.occ.voteStatusInfo.aggregated.label,
    description: COPY.occ.voteStatusInfo.aggregated.description,
  },
  processed: {
    label: COPY.occ.voteStatusInfo.processed.label,
    description: COPY.occ.voteStatusInfo.processed.description,
  },
  settled: {
    label: COPY.occ.voteStatusInfo.settled.label,
    description: COPY.occ.voteStatusInfo.settled.description,
  },
  error: {
    label: COPY.occ.voteStatusInfo.error.label,
    description: COPY.occ.voteStatusInfo.error.description,
  },
};

export interface ProcessStatusInfo {
  key: string;
  label: string;
  title: string;
  description: string;
  closed: boolean;
}

export const PROCESS_STATUS_INFO: Record<number, ProcessStatusInfo> = {
  [ProcessStatus.READY]: {
    key: 'ready',
    label: COPY.occ.processStatusInfo.ready.label,
    title: COPY.occ.processStatusInfo.ready.title,
    description: COPY.occ.processStatusInfo.ready.description,
    closed: false,
  },
  [ProcessStatus.ENDED]: {
    key: 'ended',
    label: COPY.occ.processStatusInfo.ended.label,
    title: COPY.occ.processStatusInfo.ended.title,
    description: COPY.occ.processStatusInfo.ended.description,
    closed: true,
  },
  [ProcessStatus.CANCELED]: {
    key: 'canceled',
    label: COPY.occ.processStatusInfo.canceled.label,
    title: COPY.occ.processStatusInfo.canceled.title,
    description: COPY.occ.processStatusInfo.canceled.description,
    closed: true,
  },
  [ProcessStatus.PAUSED]: {
    key: 'paused',
    label: COPY.occ.processStatusInfo.paused.label,
    title: COPY.occ.processStatusInfo.paused.title,
    description: COPY.occ.processStatusInfo.paused.description,
    closed: true,
  },
  [ProcessStatus.RESULTS]: {
    key: 'results',
    label: COPY.occ.processStatusInfo.results.label,
    title: COPY.occ.processStatusInfo.results.title,
    description: COPY.occ.processStatusInfo.results.description,
    closed: true,
  },
};

export interface CreateQuestionChoice {
  title: string;
  value: number;
}

export interface CreateQuestion {
  title: string;
  description: string;
  choices: CreateQuestionChoice[];
}

export interface CreateValues {
  countries: string[];
  country: string;
  minAge: number;
  scopeSeed: string;
  title: string;
  description: string;
  maxVoters: number;
  duration: number;
  startDate: Date;
  listInExplore: boolean;
  question: CreateQuestion;
  ballot: BallotMode;
}

export interface ProcessMetaSnapshot {
  contractAddress?: string;
  censusUri?: string;
  title?: string;
  scopeSeed?: string;
  countries?: string[];
  country?: string;
  minAge?: number;
  network?: string;
  listInExplore?: boolean;
  updatedAt?: string;
}

export interface ConnectedWalletPreference {
  address: string;
  sourceLabel: string;
  connectorType: 'injected' | 'walletconnect';
}

export function normalizeVoteStatus(status: unknown): VoteStatusKey | '' {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized in VOTE_STATUS_INFO) {
    return normalized as VoteStatusKey;
  }
  return '';
}

export function isVoteStatusTerminal(status: unknown): boolean {
  const normalized = normalizeVoteStatus(status);
  return normalized === 'settled' || normalized === 'error';
}

export function formatVoteStatusLabel(status: unknown): string {
  const normalized = normalizeVoteStatus(status);
  if (!normalized) return '-';
  return VOTE_STATUS_INFO[normalized].label;
}

export function formatProcessTypeLabel(typeName: unknown): string {
  const raw = String(typeName || '').trim();
  if (!raw) return '';
  if (/single[-_\s]?choice/i.test(raw)) return 'Single Choice';
  if (/quadratic/i.test(raw)) return 'Quadratic';
  if (/approval/i.test(raw)) return 'Approval';
  return raw
    .split(/[-_]/g)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

export function formatVotePercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function formatRemainingTimeFromEndMs(endDateMs: number | null): string {
  if (!Number.isFinite(Number(endDateMs))) return '-';
  const remainingMs = Number(endDateMs) - Date.now();
  if (remainingMs <= 0) return COPY.occ.format.ended;

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return COPY.occ.format.lessThanOneMinute;
}

export function formatDurationMs(durationMs: number | null): string {
  if (!Number.isFinite(Number(durationMs))) return '-';
  const safeDurationMs = Math.max(0, Math.round(Number(durationMs)));
  const totalMinutes = Math.floor(safeDurationMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return COPY.occ.format.lessThanOneMinute;
}

export function formatReadinessCheckTime(timestampMs: number | null): string {
  if (!Number.isFinite(Number(timestampMs)) || Number(timestampMs) <= 0) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(Number(timestampMs)));
  } catch {
    return '';
  }
}

export function toDateTimeLocal(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function trimTrailingSlash(value: unknown): string {
  return String(value || '').replace(/\/+$/, '');
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureAsciiField(value: unknown, label: string): void {
  if (!isAsciiText(value)) {
    throw new Error(COPY.occ.errors.asciiField(label));
  }
}

export function voteScopeStorageKey(processId: string): string {
  const normalized = normalizeProcessId(processId);
  return `occ.voteScope.${(normalized || 'default').toLowerCase()}`;
}

export function processMetaStorageKey(processId: string): string {
  const normalized = normalizeProcessId(processId);
  return `occ.processMeta.${(normalized || 'default').toLowerCase()}`;
}

export function voteSubmissionStorageKey(processId: string, address: string): string {
  const normalizedProcessId = normalizeProcessId(processId);
  const normalizedAddress = String(address || '').trim().toLowerCase();
  if (!normalizedProcessId || !/^0x[a-f0-9]{40}$/.test(normalizedAddress)) return '';
  return `${VOTE_SUBMISSION_STORAGE_PREFIX}.${normalizedProcessId.toLowerCase()}.${normalizedAddress}`;
}

export function getWalletOverrideKey(processId: string): string {
  return `occ.walletOverride.${processId || 'default'}`;
}

export function getConnectedWalletPreferenceKey(processId: string): string {
  return `occ.connectedWallet.${processId || 'default'}`;
}

export function persistProcessMeta(processId: string, payload: ProcessMetaSnapshot): void {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return;
  try {
    localStorage.setItem(processMetaStorageKey(normalized), JSON.stringify(payload || {}));
  } catch {
    // Ignore storage errors.
  }
}

export function loadProcessMeta(processId: string): ProcessMetaSnapshot | null {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return null;

  try {
    const raw = localStorage.getItem(processMetaStorageKey(normalized));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ProcessMetaSnapshot) : null;
  } catch {
    return null;
  }
}

export function persistVoteScopeSeed(processId: string, scopeSeed: string): void {
  const normalizedScope = normalizeScope(scopeSeed);
  if (!normalizedScope) return;

  try {
    localStorage.setItem(voteScopeStorageKey(processId), normalizedScope);
    localStorage.setItem(LAST_SCOPE_SEED_KEY, normalizedScope);
  } catch {
    // Ignore storage errors.
  }
}

export function loadVoteScopeSeed(processId: string): string {
  try {
    const perProcess = localStorage.getItem(voteScopeStorageKey(processId));
    if (perProcess) return normalizeScope(perProcess);
    return normalizeScope(localStorage.getItem(LAST_SCOPE_SEED_KEY) || '');
  } catch {
    return '';
  }
}

export interface VoteSubmissionSnapshot {
  voteId: string;
  status: string;
}

export function persistVoteSubmission(processId: string, address: string, payload: VoteSubmissionSnapshot): void {
  const key = voteSubmissionStorageKey(processId, address);
  if (!key) return;

  const voteId = String(payload?.voteId || '').trim();
  const status = normalizeVoteStatus(payload?.status || '');
  if (!voteId) return;

  try {
    localStorage.setItem(key, JSON.stringify({
      voteId,
      status: status || 'pending',
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Ignore storage errors.
  }
}

export function loadVoteSubmission(processId: string, address: string): VoteSubmissionSnapshot | null {
  const key = voteSubmissionStorageKey(processId, address);
  if (!key) return null;

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoteSubmissionSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    const voteId = String(parsed.voteId || '').trim();
    const status = normalizeVoteStatus(parsed.status || '');
    if (!voteId) return null;
    return { voteId, status: status || 'pending' };
  } catch {
    return null;
  }
}

export function normalizePrivateKey(value: unknown): string {
  const trimmed = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error('Private key must be 0x-prefixed 64 hex chars.');
  }
  return trimmed;
}

export function getOrCreateMasterSecret(): string {
  const existing = localStorage.getItem(MASTER_SECRET_KEY);
  if (existing && /^0x[a-fA-F0-9]{64}$/.test(existing)) {
    return existing;
  }

  const generated = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const secret = `0x${generated}`;
  localStorage.setItem(MASTER_SECRET_KEY, secret);
  return secret;
}

export function derivePrivateKey(processId: string): string {
  const seed = getOrCreateMasterSecret();
  const normalizedProcessId = normalizeProcessId(processId || 'default');
  const material = `${seed}:${normalizedProcessId.toLowerCase()}`;
  let candidate = keccak256(toUtf8Bytes(material));

  try {
    // eslint-disable-next-line no-new
    new Wallet(candidate);
  } catch {
    candidate = keccak256(toUtf8Bytes(`${material}:fallback`));
  }

  return normalizePrivateKey(candidate);
}

export function getWalletOverride(processId: string): string {
  const raw = localStorage.getItem(getWalletOverrideKey(processId));
  if (!raw) return '';
  try {
    return normalizePrivateKey(raw);
  } catch {
    return '';
  }
}

export function loadConnectedWalletPreference(processId: string): ConnectedWalletPreference | null {
  const key = getConnectedWalletPreferenceKey(processId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const address = String(parsed?.address || '').trim();
    const sourceLabel = String(parsed?.sourceLabel || '').trim();
    const connectorType = parsed?.connectorType === 'walletconnect' ? 'walletconnect' : parsed?.connectorType === 'injected' ? 'injected' : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !connectorType) return null;
    return {
      address,
      sourceLabel,
      connectorType,
    };
  } catch {
    return null;
  }
}

export function persistConnectedWalletPreference(processId: string, preference: ConnectedWalletPreference): void {
  const key = getConnectedWalletPreferenceKey(processId);
  const address = String(preference?.address || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
  const connectorType = preference.connectorType === 'walletconnect' ? 'walletconnect' : 'injected';
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        address,
        sourceLabel: String(preference?.sourceLabel || '').trim(),
        connectorType,
      })
    );
  } catch {
    // Ignore storage errors.
  }
}

export function clearConnectedWalletPreference(processId: string): void {
  try {
    localStorage.removeItem(getConnectedWalletPreferenceKey(processId));
  } catch {
    // Ignore storage errors.
  }
}

export function setWalletOverride(processId: string, privateKey: string): void {
  localStorage.setItem(getWalletOverrideKey(processId), normalizePrivateKey(privateKey));
}

export function clearWalletOverride(processId: string): void {
  localStorage.removeItem(getWalletOverrideKey(processId));
}

export function loadManagedWallet(processId: string): { address: string; privateKey: string; source: 'imported' | 'derived' } {
  const imported = getWalletOverride(processId);
  if (imported) {
    const wallet = new Wallet(imported);
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      source: 'imported',
    };
  }

  const derived = derivePrivateKey(processId);
  const wallet = new Wallet(derived);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    source: 'derived',
  };
}

export function getVerificationConfig(minAge: number): {
  olderThanEnabled: boolean;
  olderThan: bigint;
  forbiddenCountriesEnabled: boolean;
  forbiddenCountriesListPacked: readonly [bigint, bigint, bigint, bigint];
  ofacEnabled: readonly [boolean, boolean, boolean];
} {
  return {
    olderThanEnabled: minAge > 0,
    olderThan: BigInt(minAge),
    forbiddenCountriesEnabled: false,
    forbiddenCountriesListPacked: EMPTY_COUNTRIES,
    ofacEnabled: EMPTY_OFAC,
  };
}

export function computeConfigId(minAge: number): string {
  const config = getVerificationConfig(minAge);
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['bool', 'uint256', 'bool', 'uint256[4]', 'bool[3]'],
    [
      config.olderThanEnabled,
      config.olderThan,
      config.forbiddenCountriesEnabled,
      config.forbiddenCountriesListPacked,
      config.ofacEnabled,
    ]
  );
  return sha256(encoded);
}

interface BytecodeLinkReference {
  start: number;
  length: number;
}

type BytecodeLinkReferences = Record<string, Record<string, BytecodeLinkReference[]>>;

interface ArtifactBytecode {
  object?: string;
  linkReferences?: BytecodeLinkReferences;
}

function normalizeHexAddress(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 20-byte hex address.`);
  }
  return normalized.toLowerCase();
}

function linkBytecodeLibraries(
  bytecode: string,
  linkReferences: BytecodeLinkReferences | undefined,
  libraries: Record<string, string>
): string {
  if (!linkReferences || !Object.keys(linkReferences).length) {
    return bytecode;
  }

  const hasPrefix = bytecode.startsWith('0x');
  let hexData = hasPrefix ? bytecode.slice(2) : bytecode;

  for (const [sourceName, refsByLibrary] of Object.entries(linkReferences)) {
    for (const [libraryName, refs] of Object.entries(refsByLibrary)) {
      const libraryKey = `${sourceName}:${libraryName}`;
      const linkedAddress = libraries[libraryKey] || libraries[libraryName];
      if (!linkedAddress) {
        throw new Error(`Missing linked address for library "${libraryName}".`);
      }

      const addressHex = normalizeHexAddress(linkedAddress, `Library ${libraryName}`).slice(2);
      for (const ref of refs) {
        const offset = Number(ref.start) * 2;
        const length = Number(ref.length) * 2;
        if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
          throw new Error(`Invalid link reference for library "${libraryName}".`);
        }
        const replacement = addressHex.padStart(length, '0').slice(-length);
        hexData = `${hexData.slice(0, offset)}${replacement}${hexData.slice(offset + length)}`;
      }
    }
  }

  return hasPrefix ? `0x${hexData}` : hexData;
}

function ensureValidHexBytecode(bytecode: string): void {
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error('Contract bytecode contains unresolved placeholders. Rebuild artifacts and linked libraries.');
  }
  if (bytecode.length % 2 !== 0) {
    throw new Error('Contract bytecode hex length is invalid.');
  }
}

export function buildDeployData(input: {
  scopeSeed: string;
  countries: string[];
  country: string;
  minAge: number;
  configId: string;
}): string {
  const artifactBytecode = (artifact as { bytecode?: ArtifactBytecode | string }).bytecode;
  const rawBytecode = typeof artifactBytecode === 'string' ? artifactBytecode : artifactBytecode?.object;
  if (!rawBytecode) throw new Error('Contract artifact bytecode is missing.');

  const linkedBytecode = linkBytecodeLibraries(rawBytecode, typeof artifactBytecode === 'string' ? undefined : artifactBytecode?.linkReferences, {
    PoseidonT3: ACTIVE_NETWORK.poseidonT3Address,
    'lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3': ACTIVE_NETWORK.poseidonT3Address,
  });

  if (/__\$[a-fA-F0-9]{34}\$__/.test(linkedBytecode)) {
    throw new Error('Contract bytecode still contains unresolved library placeholders.');
  }
  ensureValidHexBytecode(linkedBytecode);

  const countries = Array.isArray(input.countries)
    ? input.countries.map((country) => normalizeCountry(country)).filter((country) => isValidCountryCode(country))
    : [];
  const fallbackCountry = normalizeCountry(input.country);
  const targetCountries = countries.length ? countries : isValidCountryCode(fallbackCountry) ? [fallbackCountry] : [];
  if (!targetCountries.length) {
    throw new Error('At least one country is required to deploy the census contract.');
  }

  const encodedArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'string', 'bytes32', 'string[]', 'uint256'],
    [ACTIVE_NETWORK.hubAddress, input.scopeSeed, input.configId, targetCountries, BigInt(input.minAge)]
  );

  return `${linkedBytecode}${encodedArgs.slice(2)}`;
}

export function buildCensusUri(contractAddress: string): string {
  const base = trimTrailingSlash(CONFIG.onchainIndexerUrl);
  if (!base) {
    throw new Error('Missing VITE_ONCHAIN_CENSUS_INDEXER_URL.');
  }

  return `${base}/${ACTIVE_NETWORK.chainId}/${String(contractAddress).toLowerCase()}/graphql`;
}

export function toHttpCensusUri(censusUri: string): string {
  const value = String(censusUri || '').trim();
  if (!value) return '';
  if (/^graphql:\/\//i.test(value)) {
    return value.replace(/^graphql:\/\//i, 'https://');
  }
  return value;
}

export function toSequencerCensusUri(censusUri: string): string {
  const value = String(censusUri || '').trim();
  if (!value) return '';
  if (/^graphql:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^https?:\/\//i, 'graphql://');
  }
  return `graphql://${value.replace(/^\/+/, '')}`;
}

export type StringifiedMetaValue = string | StringifiedMetaObject | StringifiedMetaValue[];

export interface StringifiedMetaObject {
  [key: string]: StringifiedMetaValue;
}

export function stringifyMetaValues(value: null | undefined): '';
export function stringifyMetaValues(value: unknown[]): StringifiedMetaValue[];
export function stringifyMetaValues(value: Record<string, unknown>): StringifiedMetaObject;
export function stringifyMetaValues(value: unknown): StringifiedMetaValue | '';
export function stringifyMetaValues(value: unknown): StringifiedMetaValue | '' {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => stringifyMetaValues(item));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => [String(key), stringifyMetaValues(nested)]);
    return Object.fromEntries(entries);
  }
  return String(value);
}

export function toSelfEndpointType(network: string): 'staging_celo' | 'celo' {
  return network === 'staging_celo' ? 'staging_celo' : 'celo';
}

export function computeIndexerExpiresAt(values: { startDate: Date; duration: number }): string {
  const startDate = values?.startDate instanceof Date ? values.startDate : new Date(values?.startDate);
  const durationSeconds = Number(values?.duration);

  if (Number.isNaN(startDate.getTime()) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Cannot compute indexer expiration timestamp from process timing.');
  }

  const expiresAt = new Date(startDate.getTime() + Math.round(durationSeconds * 1000));
  return toRfc3339Timestamp(expiresAt);
}

export function collectErrorMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 3) return [];

  const candidate = error as Record<string, unknown>;
  const messages: string[] = [];
  if (typeof error === 'string') messages.push(error);
  if (typeof candidate.message === 'string') messages.push(candidate.message);
  if (typeof candidate.shortMessage === 'string') messages.push(candidate.shortMessage);
  if (typeof candidate.reason === 'string') messages.push(candidate.reason);
  if (typeof candidate.details === 'string') messages.push(candidate.details);

  if (candidate.error) {
    messages.push(...collectErrorMessages(candidate.error, depth + 1));
  }
  if (candidate.cause) {
    messages.push(...collectErrorMessages(candidate.cause, depth + 1));
  }
  if (candidate.data) {
    messages.push(...collectErrorMessages(candidate.data, depth + 1));
  }

  return messages;
}

export function isInternalJsonRpcError(error: unknown): boolean {
  const messages = collectErrorMessages(error);
  return messages.some((message) => /internal json-rpc error/i.test(String(message)));
}

export function toSafeInteger(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

export function normalizeProcessStatus(status: unknown): number | null {
  const fromNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
    if (!Number.isFinite(parsed)) return null;
    const normalized = Math.trunc(parsed);
    return Object.prototype.hasOwnProperty.call(PROCESS_STATUS_INFO, normalized) ? normalized : null;
  };

  const fromName = (value: unknown): number | null => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^processstatus\./, '');

    if (!normalized) return null;

    const aliases: Record<string, number> = {
      ready: ProcessStatus.READY,
      active: ProcessStatus.READY,
      ended: ProcessStatus.ENDED,
      closed: ProcessStatus.ENDED,
      canceled: ProcessStatus.CANCELED,
      cancelled: ProcessStatus.CANCELED,
      paused: ProcessStatus.PAUSED,
      results: ProcessStatus.RESULTS,
      result: ProcessStatus.RESULTS,
    };

    if (Object.prototype.hasOwnProperty.call(aliases, normalized)) {
      return aliases[normalized];
    }
    return null;
  };

  const numericStatus = fromNumber(status);
  if (numericStatus !== null) return numericStatus;

  const namedStatus = fromName(status);
  if (namedStatus !== null) return namedStatus;

  if (status && typeof status === 'object') {
    const record = status as Record<string, unknown>;
    const nestedCandidates = [
      record.value,
      record.status,
      record.code,
      record.id,
      record.enumValue,
      record.name,
      record.key,
      record.label,
      record.state,
    ];

    for (const candidate of nestedCandidates) {
      if (candidate === status) continue;
      const nested = normalizeProcessStatus(candidate);
      if (nested !== null) return nested;
    }
  }

  return null;
}

export function getProcessStatusInfo(statusCode: number | null): ProcessStatusInfo | null {
  const normalized = normalizeProcessStatus(statusCode);
  if (normalized === null) return null;
  return PROCESS_STATUS_INFO[normalized] || null;
}

export function isProcessAcceptingVotes(process: unknown): boolean {
  return Boolean(process && typeof process === 'object' && (process as Record<string, unknown>).isAcceptingVotes === true);
}

export function getLocalizedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const valueObject = value as Record<string, unknown>;
  if (typeof valueObject.default === 'string') return valueObject.default;
  const first = Object.values(valueObject).find((item) => typeof item === 'string');
  return typeof first === 'string' ? first : '';
}

export function normalizeVoteQuestions(rawQuestions: unknown): Array<{
  title: string;
  description: string;
  choices: Array<{ value: number; title: string }>;
}> {
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions
    .map((question, questionIndex) => {
      const q = question as Record<string, unknown>;
      const title = String(getLocalizedText(q.title) || COPY.occ.errors.questionFallback(questionIndex)).trim();
      const description = String(getLocalizedText(q.description) || '').trim();
      const rawChoices = Array.isArray(q.choices) ? q.choices : [];
      const choices = rawChoices.map((choice, choiceIndex) => {
        const c = choice as Record<string, unknown>;
        const titleValue = String(getLocalizedText(c.title) || COPY.occ.errors.choiceFallback(choiceIndex)).trim();
        const parsedValue = Number(c.value);
        const value = Number.isInteger(parsedValue) ? parsedValue : choiceIndex;
        return { value, title: titleValue };
      });

      return {
        title,
        description,
        choices: choices.length ? choices : [{ value: 0, title: COPY.occ.errors.optionFallback }],
      };
    })
    .filter((question) => question.choices.length > 0);
}

export function extractCensusContract(process: SequencerProcess | null): string {
  const census = toRecord(process?.census);
  const metadata = toRecord(process?.metadata);
  const candidates = [
    process?.censusContract,
    census?.contractAddress,
    census?.address,
    process?.censusAddress,
    metadata?.censusContract,
    metadata?.censusContractAddress,
  ].map((value) => String(value || '').trim());

  return candidates.find((value) => /^0x[a-fA-F0-9]{40}$/.test(value)) || '';
}

export function extractCensusUri(process: SequencerProcess | null, contractAddress: string): string {
  const census = toRecord(process?.census);
  const metadata = toRecord(process?.metadata);
  const candidates = [
    process?.censusUri,
    census?.uri,
    census?.censusUri,
    metadata?.censusUri,
  ].map((value) => String(value || '').trim());

  const existing = candidates.find((value) => /^https?:\/\//i.test(value) || /^graphql:\/\//i.test(value));
  if (existing) return existing;
  if (contractAddress) return buildCensusUri(contractAddress);
  return '';
}

export function extractProcessDescription(
  process: SequencerProcess | null,
  metadata: SequencerMetadata | null
): string {
  const processMetadata = toRecord(process?.metadata);
  const candidates = [
    getLocalizedText(metadata?.description),
    getLocalizedText(process?.description),
    getLocalizedText(processMetadata?.description),
  ];
  return String(candidates.find((value) => String(value || '').trim()) || '').trim();
}

export function extractProcessEndDateMs(
  process: SequencerProcess | null,
  metadata: SequencerMetadata | null
): number | null {
  const processTiming = toRecord(process?.timing);
  const metadataTiming = toRecord(metadata?.timing);
  const endCandidates = [
    processTiming?.endDate,
    processTiming?.endTime,
    processTiming?.endsAt,
    process?.endDate,
    process?.endTime,
    process?.endsAt,
    metadataTiming?.endDate,
    metadataTiming?.endTime,
    metadataTiming?.endsAt,
    metadata?.endDate,
    metadata?.endTime,
    metadata?.endsAt,
  ];

  for (const candidate of endCandidates) {
    const parsed = toDateFromUnknown(candidate);
    if (parsed) return parsed.getTime();
  }

  const startCandidates = [
    processTiming?.startDate,
    processTiming?.startTime,
    processTiming?.startsAt,
    process?.startDate,
    process?.startTime,
    process?.startsAt,
    metadataTiming?.startDate,
    metadataTiming?.startTime,
    metadataTiming?.startsAt,
    metadata?.startDate,
    metadata?.startTime,
    metadata?.startsAt,
  ];
  const durationCandidates = [
    processTiming?.duration,
    processTiming?.durationSeconds,
    processTiming?.durationMs,
    process?.duration,
    process?.durationSeconds,
    process?.durationMs,
    metadataTiming?.duration,
    metadataTiming?.durationSeconds,
    metadataTiming?.durationMs,
    metadata?.duration,
    metadata?.durationSeconds,
    metadata?.durationMs,
  ];

  let durationMs: number | null = null;
  for (const durationCandidate of durationCandidates) {
    const parsedDurationMs = toDurationMs(durationCandidate);
    if (!parsedDurationMs) continue;
    durationMs = parsedDurationMs;
    break;
  }
  if (!durationMs) return null;

  for (const startCandidate of startCandidates) {
    const startDate = toDateFromUnknown(startCandidate);
    if (!startDate) continue;
    return startDate.getTime() + durationMs;
  }

  return null;
}

export function extractProcessDurationMs(
  process: SequencerProcess | null,
  metadata: SequencerMetadata | null
): number | null {
  const processTiming = toRecord(process?.timing);
  const metadataTiming = toRecord(metadata?.timing);
  const durationCandidates = [
    processTiming?.duration,
    processTiming?.durationSeconds,
    processTiming?.durationMs,
    process?.duration,
    process?.durationSeconds,
    process?.durationMs,
    metadataTiming?.duration,
    metadataTiming?.durationSeconds,
    metadataTiming?.durationMs,
    metadata?.duration,
    metadata?.durationSeconds,
    metadata?.durationMs,
  ];

  for (const durationCandidate of durationCandidates) {
    const durationMs = toDurationMs(durationCandidate);
    if (durationMs) return durationMs;
  }
  return null;
}

export function extractVoteContextFromMetadata(metadata: SequencerMetadata | null): {
  scopeSeed: string;
  minAge: number | null;
  countries: string[];
  country: string;
  network: string;
} {
  const meta = toRecord(metadata?.meta) || {};
  const selfConfig = toRecord(meta.selfConfig) || {};

  const scopeSeed = normalizeScope(selfConfig.scope ?? selfConfig.scopeSeed ?? '');
  const minAge = normalizeMinAge(selfConfig.minAge);
  const rawCountries = Array.isArray(selfConfig.countries) ? selfConfig.countries : [];
  const countries: string[] = [];
  for (const rawCountry of rawCountries) {
    const country = normalizeCountry(rawCountry);
    if (!isValidCountryCode(country)) continue;
    if (countries.includes(country)) continue;
    countries.push(country);
  }
  const legacyCountry = normalizeCountry(selfConfig.country || '');
  if (!countries.length && isValidCountryCode(legacyCountry)) {
    countries.push(legacyCountry);
  }
  const network = String(meta.network || '').trim();

  return {
    scopeSeed: scopeSeed && isAsciiText(scopeSeed) && scopeSeed.length <= 31 ? scopeSeed : '',
    minAge: minAge || null,
    countries,
    country: countries[0] || '',
    network: NETWORKS[network] ? network : '',
  };
}

export function hasProcessEndedByTime(endDateMs: number | null): boolean {
  if (!Number.isFinite(Number(endDateMs))) return false;
  return Number(endDateMs) <= Date.now();
}

export function encodeWeightOf(address: string): string {
  const normalized = String(address || '').toLowerCase().replace(/^0x/, '');
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(COPY.occ.errors.invalidWeightAddress);
  }
  return WEIGHT_OF_SELECTOR + normalized.padStart(64, '0');
}

export function encodeBasePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const baseNoSlash = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
  if (!baseNoSlash || baseNoSlash === '/') return normalized;
  return `${baseNoSlash}${normalized}`;
}

export function buildVoteUrl(processId: string): string {
  const normalized = normalizeProcessId(processId);
  if (!normalized || !/^0x[a-fA-F0-9]{62}$/.test(normalized)) {
    return `${window.location.origin}${encodeBasePath('/vote')}`;
  }
  return `${window.location.origin}${encodeBasePath(`/vote/${encodeURIComponent(normalized)}`)}`;
}

export function buildTxExplorerUrl(txHash: string): string {
  const normalized = String(txHash || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) return '';

  const configuredBase = trimTrailingSlash(CONFIG.txExplorerBaseUrl);
  const networkBase = trimTrailingSlash(ACTIVE_NETWORK.explorerBaseUrl);
  const base = configuredBase || networkBase;
  if (!base) return '';

  return `${base}/tx/${normalized}`;
}

export function normalizeProcessResultValues(rawResult: unknown): bigint[] {
  if (!Array.isArray(rawResult)) return [];
  return rawResult.map((item) => {
    try {
      const parsed = BigInt(String(item ?? '0').trim() || '0');
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  });
}
