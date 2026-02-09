import { AbiCoder, BrowserProvider, Interface, Wallet, keccak256, randomBytes, sha256 } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { DavinciSDK, OnchainCensus } from '@vocdoni/davinci-sdk';
import QRCode from 'qrcode';

import artifact from './artifacts/OpenCitizenCensus.json';
import { buildSelfApp, getUniversalLink } from './selfApp.js';
import './style.css';

const env = import.meta.env;
const BASE_URL = env.BASE_URL || '/';

const NETWORKS = {
  celo: {
    chainId: 42220,
    chainHex: '0xa4ec',
    label: 'Celo Mainnet',
    hubAddress: '0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF',
    rpcUrl: 'https://forno.celo.org',
  },
  staging_celo: {
    chainId: 44787,
    chainHex: '0xaef3',
    label: 'Celo Sepolia',
    hubAddress: '0x16ECBA51e18a4a7e61fdC417f0d47AFEeDfbed74',
    rpcUrl: 'https://forno.celo-sepolia.celo-testnet.org',
  },
};

const CONFIG = {
  network: String(env.VITE_NETWORK || 'celo').trim(),
  onchainIndexerUrl: String(env.VITE_ONCHAIN_CENSUS_INDEXER_URL || '').trim(),
  davinciSequencerUrl: String(env.VITE_DAVINCI_SEQUENCER_URL || '').trim(),
  davinciCensusUrl: String(env.VITE_DAVINCI_CENSUS_URL || '').trim(),
  walletConnectProjectId: String(env.VITE_WALLETCONNECT_PROJECT_ID || '').trim(),
  selfAppName: String(env.VITE_SELF_APP_NAME || 'Open Citizen Census').trim(),
};

const ACTIVE_NETWORK = NETWORKS[CONFIG.network] || NETWORKS.celo;
const EMPTY_COUNTRIES = [0n, 0n, 0n, 0n];
const EMPTY_OFAC = [false, false, false];
const WEIGHT_OF_SELECTOR = '0xdd4bc101';
const MASTER_SECRET_KEY = 'occ.masterSecret.v1';
const VOTE_POLL_MS = 10_000;
const LAST_SCOPE_SEED_KEY = 'occ.lastScopeSeed.v1';
const VOTE_LINK_ENV_VERSION = 1;
const VOTE_SUBMISSION_STORAGE_PREFIX = 'occ.voteSubmission.v1';
const VOTE_STATUS_FLOW = ['pending', 'verified', 'aggregated', 'processed', 'settled'];
const VOTE_STATUS_INFO = {
  pending: {
    label: 'Pending',
    description: 'Vote was received and queued by the sequencer.',
  },
  verified: {
    label: 'Verified',
    description: 'Vote proof was verified correctly.',
  },
  aggregated: {
    label: 'Aggregated',
    description: 'Vote was merged into the current aggregation batch.',
  },
  processed: {
    label: 'Processed',
    description: 'Vote was processed and is ready for settlement.',
  },
  settled: {
    label: 'Settled',
    description: 'Vote was fully settled.',
  },
  error: {
    label: 'Error',
    description: 'Vote processing failed. Check the emit status message.',
  },
};
const INTERNAL_RPC_RETRY_MAX_ATTEMPTS = 4;
const INTERNAL_RPC_RETRY_DELAY_MS = 1_500;

const HUB_INTERFACE = new Interface([
  'function setVerificationConfigV2((bool olderThanEnabled,uint256 olderThan,bool forbiddenCountriesEnabled,uint256[4] forbiddenCountriesListPacked,bool[3] ofacEnabled)) returns (bytes32)',
  'function verificationConfigV2Exists(bytes32) view returns (bool)',
]);
const CENSUS_INTERFACE = new Interface([
  'function minAge() view returns (uint256)',
]);

const CENSUS_MEMBERS_QUERY = `
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

const PIPELINE_STAGES = [
  { id: 'validate_form', label: 'Validate form' },
  { id: 'connect_creator_wallet_walletconnect', label: 'Connect creator browser wallet' },
  { id: 'ensure_self_config_registered', label: 'Ensure Self config registered' },
  { id: 'deploy_census_contract', label: 'Deploy census contract' },
  { id: 'start_indexer', label: 'Start indexer' },
  { id: 'wait_indexer_ready', label: 'Wait indexer ready' },
  { id: 'create_davinci_process', label: 'Create Davinci process' },
  { id: 'wait_process_ready_in_sequencer', label: 'Wait process ready in sequencer' },
  { id: 'done', label: 'Done' },
];

const state = {
  route: {
    name: 'create',
    processId: '',
    contextPayload: null,
    contextPresent: false,
    contextValid: false,
  },
  createStep: 1,
  createSubmitting: false,
  createFormDirty: false,
  pipeline: PIPELINE_STAGES.map((stage) => ({
    id: stage.id,
    status: 'pending',
    message: 'Pending',
  })),
  outputs: {
    censusContract: '',
    deploymentTxHash: '',
    censusUri: '',
    processId: '',
    processTxHash: '',
    voteUrl: '',
  },
  creatorWallet: {
    provider: null,
    browserProvider: null,
    signer: null,
    address: '',
  },
  voteManaged: {
    wallet: null,
    privateVisible: false,
  },
  voteResolution: {
    sdk: null,
    process: null,
    processId: '',
    network: CONFIG.network,
    title: '',
    description: '',
    censusContract: '',
    censusUri: '',
    endDateMs: null,
    onchainWeight: 0n,
    sequencerWeight: 0n,
    onchainLookupFailed: false,
    readinessCheckedAt: null,
  },
  voteSelf: {
    scopeSeed: '',
    minAge: null,
    country: '',
    link: '',
    generating: false,
    autoTriggerKey: '',
    autoCollapsedForEligibility: false,
  },
  voteBallot: {
    questions: [],
    choices: [],
    loading: false,
    submitting: false,
    hasVoted: false,
    submissionId: '',
    submissionStatus: '',
    statusWatcherToken: 0,
  },
  votePollId: null,
};

const createView = document.getElementById('createView');
const voteView = document.getElementById('voteView');

const createForm = document.getElementById('createForm');
const createButton = document.getElementById('createBtn');
const createStatusEl = document.getElementById('createStatus');
const timelineEl = document.getElementById('timeline');
const createTimelineCard = document.getElementById('createTimelineCard');
const createOutputsCard = document.getElementById('createOutputsCard');

const stepPanels = Array.from(document.querySelectorAll('[data-step-panel]'));
const stepIndicators = Array.from(document.querySelectorAll('[data-step-indicator]'));
const stepBackBtn = document.getElementById('stepBackBtn');
const stepNextBtn = document.getElementById('stepNextBtn');

const countryInput = document.getElementById('country');
const minAgeInput = document.getElementById('minAge');
const scopeSeedInput = document.getElementById('scopeSeed');
const processTitleInput = document.getElementById('processTitle');
const processDescriptionInput = document.getElementById('processDescription');
const maxVotersInput = document.getElementById('maxVoters');
const startDateInput = document.getElementById('startDate');
const durationHoursInput = document.getElementById('durationHours');

const creatorWalletAddressEl = document.getElementById('creatorWalletAddress');
const creatorWalletStatusEl = document.getElementById('creatorWalletStatus');
const connectCreatorWalletBtn = document.getElementById('connectCreatorWalletBtn');

const addQuestionButton = document.getElementById('addQuestion');
const questionList = document.getElementById('questionList');

const outContract = document.getElementById('outContract');
const outputContractItem = document.getElementById('outputContractItem');
const outDeployTx = document.getElementById('outDeployTx');
const outputDeployTxItem = document.getElementById('outputDeployTxItem');
const outCensusUri = document.getElementById('outCensusUri');
const outputCensusUriItem = document.getElementById('outputCensusUriItem');
const outProcessId = document.getElementById('outProcessId');
const outputProcessIdItem = document.getElementById('outputProcessIdItem');
const outProcessTx = document.getElementById('outProcessTx');
const outputProcessTxItem = document.getElementById('outputProcessTxItem');
const timelineVoteUrlWrap = document.getElementById('timelineVoteUrlWrap');
const outVoteUrl = document.getElementById('outVoteUrl');
const copyVoteUrlBtn = document.getElementById('copyVoteUrlBtn');

const voteStatusEl = document.getElementById('voteStatus');
const voteContextGatePopup = document.getElementById('voteContextGatePopup');
const voteContextGatePopupMessage = document.getElementById('voteContextGatePopupMessage');
const voteProcessIdInput = document.getElementById('voteProcessIdInput');
const showVoteDetailsBtn = document.getElementById('showVoteDetailsBtn');
const closeVoteDetailsBtn = document.getElementById('closeVoteDetailsBtn');
const voteDetailsDialog = document.getElementById('voteDetailsDialog');
const voteFocusProcessTitleEl = document.getElementById('voteFocusProcessTitle');
const voteFocusProcessDescriptionEl = document.getElementById('voteFocusProcessDescription');
const voteFocusRemainingTimeEl = document.getElementById('voteFocusRemainingTime');
const voteProcessIdEl = document.getElementById('voteProcessId');
const voteProcessTitleEl = document.getElementById('voteProcessTitle');
const voteProcessDescriptionEl = document.getElementById('voteProcessDescription');
const voteProcessRemainingTimeEl = document.getElementById('voteProcessRemainingTime');
const voteCensusContractEl = document.getElementById('voteCensusContract');
const voteCensusUriEl = document.getElementById('voteCensusUri');
const voteSequencerUrlEl = document.getElementById('voteSequencerUrl');
const CREATOR_WALLET_STATUS_DEFAULT = creatorWalletStatusEl.textContent;
const voteSelfCardEl = document.getElementById('voteSelfCard');
const voteScopeSeedInfoEl = document.getElementById('voteScopeSeedInfo');
const voteSelfMinAgeInfoEl = document.getElementById('voteSelfMinAgeInfo');
const voteCountryInfoEl = document.getElementById('voteCountryInfo');
const generateVoteSelfQrBtn = document.getElementById('generateVoteSelfQrBtn');
const copyVoteSelfLinkBtn = document.getElementById('copyVoteSelfLinkBtn');
const openVoteSelfLinkBtn = document.getElementById('openVoteSelfLinkBtn');
const voteSelfQrWrapEl = document.getElementById('voteSelfQrWrap');
const voteSelfQrImageEl = document.getElementById('voteSelfQrImage');
const voteSelfRegistrationLayoutEl = document.getElementById('voteSelfRegistrationLayout');
const voteSelfQrActionsEl = document.getElementById('voteSelfQrActions');
const voteAlreadyRegisteredMsgEl = document.getElementById('voteAlreadyRegisteredMsg');
const voteSelfStatusEl = document.getElementById('voteSelfStatus');
const registrationStatusTimelineEl = document.getElementById('registrationStatusTimeline');
const registrationHintEl = document.getElementById('registrationHint');
const voteQuestionsEl = document.getElementById('voteQuestions');
const emitVoteBtn = document.getElementById('emitVoteBtn');
const voteStatusGuideEl = document.getElementById('voteStatusGuide');
const voteStatusFlowIdLineEl = document.getElementById('voteStatusFlowIdLine');
const voteStatusFlowVoteIdEl = document.getElementById('voteStatusFlowVoteId');
const voteStatusTimelineEl = document.getElementById('voteStatusTimeline');

const walletAddressEl = document.getElementById('walletAddress');
const walletSourceEl = document.getElementById('walletSource');
const walletPrivateKeyEl = document.getElementById('walletPrivateKey');
const walletSecretBoxEl = document.getElementById('walletSecretBox');
const revealKeyBtn = document.getElementById('revealKeyBtn');
const copyKeyBtn = document.getElementById('copyKeyBtn');
const importKeyInput = document.getElementById('importKeyInput');
const importKeyBtn = document.getElementById('importKeyBtn');
const clearImportedKeyBtn = document.getElementById('clearImportedKeyBtn');

function setCreateStatus(message, isError = false) {
  createStatusEl.textContent = message;
  createStatusEl.dataset.state = isError ? 'error' : 'ok';
}

function setVoteStatus(message, isError = false) {
  voteStatusEl.textContent = message;
  voteStatusEl.dataset.state = isError ? 'error' : 'ok';
}

function showVoteContextGatePopup(message) {
  if (!voteContextGatePopup || !voteContextGatePopupMessage) return;
  voteContextGatePopupMessage.textContent = message;
  voteContextGatePopup.hidden = false;
  document.body.classList.add('app-blocked');
}

function hideVoteContextGatePopup() {
  if (!voteContextGatePopup) return;
  voteContextGatePopup.hidden = true;
  document.body.classList.remove('app-blocked');
}

function getVoteContextRequiredMessage() {
  const inlineMessage = String(voteContextGatePopupMessage?.textContent || '').trim();
  if (inlineMessage) return inlineMessage;
  return 'Configuration information is required to use this app.';
}

function setVoteSelfStatus(message, isError = false) {
  if (!voteSelfStatusEl) return;
  voteSelfStatusEl.textContent = message;
  voteSelfStatusEl.dataset.state = isError ? 'error' : 'ok';
}

function setButtonLabel(button, label, iconClass) {
  if (!button) return;
  button.textContent = '';

  if (iconClass) {
    const icon = document.createElement('span');
    icon.className = `btn-icon ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
  }

  const text = document.createElement('span');
  text.className = 'btn-text';
  text.textContent = label;
  button.append(text);
}

function applyStaticButtonIcons() {
  setButtonLabel(addQuestionButton, 'Add question', 'iconoir-plus');
  setButtonLabel(stepBackBtn, 'Back', 'iconoir-nav-arrow-left');
  setButtonLabel(stepNextBtn, 'Continue', 'iconoir-nav-arrow-right');
  setButtonLabel(createButton, 'Launch Process', 'iconoir-nav-arrow-right');
  if (showVoteDetailsBtn) setButtonLabel(showVoteDetailsBtn, 'Details', 'iconoir-info-circle');
  if (closeVoteDetailsBtn) setButtonLabel(closeVoteDetailsBtn, 'Close', 'iconoir-xmark');
  setButtonLabel(copyKeyBtn, 'Copy private key', 'iconoir-copy');
  setButtonLabel(importKeyBtn, 'Import key', 'iconoir-key');
  setButtonLabel(clearImportedKeyBtn, 'Use derived key', 'iconoir-refresh');
  if (copyVoteUrlBtn) setButtonLabel(copyVoteUrlBtn, 'Copy link', 'iconoir-copy');
  if (generateVoteSelfQrBtn) setButtonLabel(generateVoteSelfQrBtn, 'Regenerate QR', 'iconoir-refresh');
  if (copyVoteSelfLinkBtn) setButtonLabel(copyVoteSelfLinkBtn, 'Copy Self link', 'iconoir-copy');
  if (openVoteSelfLinkBtn) setButtonLabel(openVoteSelfLinkBtn, 'Open Self link', 'iconoir-link');
  if (emitVoteBtn) setButtonLabel(emitVoteBtn, 'Emit vote', 'iconoir-check');
}

function setVoteProcessDetails({
  processId = '',
  title = '',
  description = '',
  censusContract = '',
  censusUri = '',
  sequencerUrl = '',
  endDateMs = null,
} = {}) {
  const normalizedId = normalizeProcessId(processId);
  const displayId = normalizedId || '-';
  const displayTitle = String(title || '').trim() || '-';
  const displayDescription = String(description || '').trim() || '-';
  const displayContract = String(censusContract || '').trim() || '-';
  const displayUri = String(censusUri || '').trim() || '-';
  const displaySequencer = String(sequencerUrl || '').trim() || CONFIG.davinciSequencerUrl || '-';
  const displayRemaining = formatRemainingTimeFromEndMs(endDateMs);
  const focusTitle = displayTitle === '-' ? 'Questions' : displayTitle;
  const hasDescription = displayDescription !== '-';
  const hasRemaining = displayRemaining !== '-';

  if (voteFocusProcessTitleEl) voteFocusProcessTitleEl.textContent = focusTitle;
  if (voteFocusProcessDescriptionEl) {
    voteFocusProcessDescriptionEl.textContent = displayDescription;
    voteFocusProcessDescriptionEl.hidden = !hasDescription;
  }
  if (voteFocusRemainingTimeEl) {
    voteFocusRemainingTimeEl.textContent = `Remaining time: ${displayRemaining}`;
    voteFocusRemainingTimeEl.hidden = !hasRemaining;
  }

  voteProcessIdEl.textContent = displayId;
  voteProcessTitleEl.textContent = displayTitle;
  if (voteProcessDescriptionEl) voteProcessDescriptionEl.textContent = displayDescription;
  if (voteProcessRemainingTimeEl) voteProcessRemainingTimeEl.textContent = displayRemaining;
  voteCensusContractEl.textContent = displayContract;
  voteCensusUriEl.textContent = displayUri;
  voteSequencerUrlEl.textContent = displaySequencer;

  if (showVoteDetailsBtn) showVoteDetailsBtn.disabled = displayId === '-';
}

function formatRemainingTimeFromEndMs(endDateMs) {
  if (!Number.isFinite(Number(endDateMs))) return '-';
  const remainingMs = Number(endDateMs) - Date.now();
  if (remainingMs <= 0) return 'Ended';

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function refreshVoteRemainingTimeDisplay() {
  setVoteProcessDetails({
    processId: state.voteResolution.processId,
    title: state.voteResolution.title,
    description: state.voteResolution.description,
    censusContract: state.voteResolution.censusContract,
    censusUri: state.voteResolution.censusUri,
    sequencerUrl: CONFIG.davinciSequencerUrl || '',
    endDateMs: state.voteResolution.endDateMs,
  });
}

function openVoteDetailsDialog() {
  if (!voteDetailsDialog) return;
  if (voteDetailsDialog.open) return;
  if (typeof voteDetailsDialog.showModal === 'function') {
    voteDetailsDialog.showModal();
    return;
  }
  voteDetailsDialog.setAttribute('open', '');
}

function closeVoteDetailsDialog() {
  if (!voteDetailsDialog) return;
  if (!voteDetailsDialog.open) return;
  if (typeof voteDetailsDialog.close === 'function') {
    voteDetailsDialog.close();
    return;
  }
  voteDetailsDialog.removeAttribute('open');
}

function isCreatorWalletConnected() {
  return Boolean(state.creatorWallet?.address);
}

function renderWalletButtons() {
  const creatorConnected = isCreatorWalletConnected();

  setButtonLabel(connectCreatorWalletBtn, creatorConnected ? 'Disconnect wallet' : 'Connect wallet', creatorConnected ? 'iconoir-log-out' : 'iconoir-wallet');
  connectCreatorWalletBtn.classList.toggle('disconnect', creatorConnected);
  renderWizard();
}

function normalizeProcessId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function normalizeCountry(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeScope(value) {
  return String(value || '').trim();
}

function isAsciiText(value) {
  return /^[\x00-\x7F]*$/.test(String(value || ''));
}

function ensureAsciiField(value, label) {
  if (!isAsciiText(value)) {
    throw new Error(`${label} accepts ASCII characters only. Check browser console for technical details.`);
  }
}

function stripNonAscii(value) {
  return String(value || '').replace(/[^\x00-\x7F]/g, '');
}

function sanitizeControlAscii(control) {
  if (!control || typeof control.value !== 'string') return false;
  const sanitized = stripNonAscii(control.value);
  if (sanitized === control.value) return false;
  control.value = sanitized;
  return true;
}

function sanitizeCreateFormAsciiInputs() {
  const controls = [
    scopeSeedInput,
    processTitleInput,
    processDescriptionInput,
    ...Array.from(questionList.querySelectorAll('.question-title, .question-description, .choice-input')),
  ];
  return controls.some((control) => sanitizeControlAscii(control));
}

function voteScopeStorageKey(processId) {
  const normalized = normalizeProcessId(processId);
  return `occ.voteScope.${(normalized || 'default').toLowerCase()}`;
}

function processMetaStorageKey(processId) {
  const normalized = normalizeProcessId(processId);
  return `occ.processMeta.${(normalized || 'default').toLowerCase()}`;
}

function persistProcessMeta(processId, payload) {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return;
  try {
    localStorage.setItem(processMetaStorageKey(normalized), JSON.stringify(payload || {}));
  } catch {
    // Ignore storage errors.
  }
}

function loadProcessMeta(processId) {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return null;

  try {
    const raw = localStorage.getItem(processMetaStorageKey(normalized));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistVoteScopeSeed(processId, scopeSeed) {
  const normalizedScope = normalizeScope(scopeSeed);
  if (!normalizedScope) return;

  try {
    localStorage.setItem(voteScopeStorageKey(processId), normalizedScope);
    localStorage.setItem(LAST_SCOPE_SEED_KEY, normalizedScope);
  } catch {
    // Ignore storage errors.
  }
}

function loadVoteScopeSeed(processId) {
  try {
    const perProcess = localStorage.getItem(voteScopeStorageKey(processId));
    if (perProcess) return normalizeScope(perProcess);
    return normalizeScope(localStorage.getItem(LAST_SCOPE_SEED_KEY) || '');
  } catch {
    return '';
  }
}

function voteSubmissionStorageKey(processId, address) {
  const normalizedProcessId = normalizeProcessId(processId);
  const normalizedAddress = String(address || '').trim().toLowerCase();
  if (!normalizedProcessId || !/^0x[a-f0-9]{40}$/.test(normalizedAddress)) return '';
  return `${VOTE_SUBMISSION_STORAGE_PREFIX}.${normalizedProcessId.toLowerCase()}.${normalizedAddress}`;
}

function persistVoteSubmission(processId, address, payload) {
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

function loadVoteSubmission(processId, address) {
  const key = voteSubmissionStorageKey(processId, address);
  if (!key) return null;

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const voteId = String(parsed.voteId || '').trim();
    const status = normalizeVoteStatus(parsed.status || '');
    if (!voteId) return null;
    return { voteId, status: status || 'pending' };
  } catch {
    return null;
  }
}

function restoreVoteSubmissionFromStorage(processId) {
  const normalizedProcessId = normalizeProcessId(processId);
  const managedAddress = state.voteManaged.wallet?.address;
  if (!normalizedProcessId || !managedAddress) return false;

  const stored = loadVoteSubmission(normalizedProcessId, managedAddress);
  if (!stored) return false;

  state.voteBallot.submissionId = stored.voteId;
  state.voteBallot.submissionStatus = stored.status || 'pending';
  state.voteBallot.hasVoted = false;
  return true;
}

function toSelfEndpointType() {
  return state.voteResolution.network === 'staging_celo' ? 'staging_celo' : 'celo';
}

function normalizeMinAge(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  if (normalized <= 0 || normalized > 99) return null;
  return normalized;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function toDateTimeLocal(date) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorMessages(error, depth = 0) {
  if (!error || depth > 3) return [];

  const messages = [];
  if (typeof error === 'string') messages.push(error);
  if (typeof error?.message === 'string') messages.push(error.message);
  if (typeof error?.shortMessage === 'string') messages.push(error.shortMessage);
  if (typeof error?.reason === 'string') messages.push(error.reason);
  if (typeof error?.details === 'string') messages.push(error.details);

  if (error?.error) {
    messages.push(...collectErrorMessages(error.error, depth + 1));
  }
  if (error?.cause) {
    messages.push(...collectErrorMessages(error.cause, depth + 1));
  }
  if (error?.data) {
    messages.push(...collectErrorMessages(error.data, depth + 1));
  }

  return messages;
}

function isInternalJsonRpcError(error) {
  const messages = collectErrorMessages(error);
  return messages.some((message) => /internal json-rpc error/i.test(String(message)));
}

function encodeBasePath(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const baseNoSlash = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
  if (!baseNoSlash || baseNoSlash === '/') return normalized;
  return `${baseNoSlash}${normalized}`;
}

function removeBasePath(pathname) {
  const baseNoSlash = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
  if (!baseNoSlash || baseNoSlash === '/') return pathname || '/';
  if (pathname.startsWith(baseNoSlash)) {
    const stripped = pathname.slice(baseNoSlash.length);
    return stripped || '/';
  }
  return pathname || '/';
}

function encodeBase64UrlJson(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64UrlJson(value) {
  try {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function sanitizeVoteEnvPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.v !== undefined && Number(payload.v) !== VOTE_LINK_ENV_VERSION) return null;

  const processId = normalizeProcessId(payload.processId ?? payload.pid);
  const contractAddress = String(payload.contractAddress ?? payload.contract ?? '').trim();
  const censusUri = String(payload.censusUri ?? '').trim();
  const scope = normalizeScope(payload.scope ?? payload.scopeSeed ?? '');
  const minAge = normalizeMinAge(payload.minAge);
  const country = normalizeCountry(payload.country || '');
  const network = String(payload.network || '').trim();
  const title = String(payload.title || '').trim();
  const sequencerUrl = String(payload.sequencerUrl || '').trim();
  const sanitized = {};

  if (processId) sanitized.processId = processId;
  if (/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) sanitized.contractAddress = contractAddress;
  if (/^(https?:\/\/|graphql:\/\/)/i.test(censusUri)) sanitized.censusUri = censusUri;
  if (scope && /^[\x00-\x7F]+$/.test(scope) && scope.length <= 31) sanitized.scope = scope;
  if (minAge) sanitized.minAge = minAge;
  if (/^[A-Z]{2,3}$/.test(country)) sanitized.country = country;
  if (NETWORKS[network]) sanitized.network = network;
  if (/^https?:\/\//i.test(sequencerUrl)) sanitized.sequencerUrl = sequencerUrl;
  if (title) sanitized.title = title.slice(0, 160);

  if (!Object.keys(sanitized).length) return null;
  return sanitized;
}

function parseVoteContextFromPath(logicalPath) {
  if (!logicalPath.startsWith('/vote/')) {
    return { payload: null, present: false, valid: false };
  }

  const encoded = decodeURIComponent(logicalPath.slice('/vote/'.length)).trim();
  if (!encoded) {
    return { payload: null, present: false, valid: false };
  }

  const decoded = decodeBase64UrlJson(encoded);
  const payload = sanitizeVoteEnvPayload(decoded);
  return {
    payload,
    present: true,
    valid: Boolean(payload?.processId),
  };
}

function parseRoute() {
  const logicalPath = removeBasePath(window.location.pathname);
  const contextData = parseVoteContextFromPath(logicalPath);

  if (logicalPath === '/' || logicalPath === '/create') {
    return {
      name: 'create',
      processId: '',
      contextPayload: null,
      contextPresent: false,
      contextValid: false,
    };
  }

  if (logicalPath === '/vote') {
    return {
      name: 'vote',
      processId: '',
      contextPayload: null,
      contextPresent: false,
      contextValid: false,
    };
  }

  if (logicalPath.startsWith('/vote/')) {
    return {
      name: 'vote',
      processId: contextData.payload?.processId || '',
      contextPayload: contextData.payload,
      contextPresent: contextData.present,
      contextValid: contextData.valid,
    };
  }

  return {
    name: 'create',
    processId: '',
    contextPayload: null,
    contextPresent: false,
    contextValid: false,
  };
}

function navigate(path) {
  history.pushState({}, '', encodeBasePath(path));
  applyRoute(parseRoute());
}

function applyRoute(route) {
  state.route = route;
  createView.hidden = route.name !== 'create';
  voteView.hidden = route.name !== 'vote';

  if (route.name === 'vote') {
    const hasValidContext = route.contextPresent && route.contextValid;
    if (!hasValidContext) {
      const popupMessage = route.contextPresent
        ? 'Invalid voting context in URL. Open a complete and valid voting link to use this app.'
        : 'Missing voting context in URL. Open the complete voting link shared for this process.';
      showVoteContextGatePopup(popupMessage);
      voteProcessIdInput.value = '';
      resetVoteResolution();
      bootstrapVoteManagedWallet('');
      stopVotePolling();
      closeVoteDetailsDialog();
      setVoteStatus(popupMessage, true);
      return;
    }

    hideVoteContextGatePopup();
    const processId = normalizeProcessId(route.processId || route.contextPayload?.processId || '');
    voteProcessIdInput.value = processId || '';

    if (processId) {
      resolveVoteProcess(processId, false, route.contextPayload);
    } else {
      resetVoteResolution();
      bootstrapVoteManagedWallet('');
      stopVotePolling();
      setVoteStatus('Invalid vote context in URL. Open a valid voting link.', true);
    }
  }

  if (route.name !== 'vote') {
    hideVoteContextGatePopup();
    stopVotePolling();
    closeVoteDetailsDialog();
  }
}

function setOutputText(element, value) {
  element.textContent = value || '-';
}

function hasOutputValue(value) {
  return Boolean(String(value || '').trim());
}

function renderOutputs() {
  setOutputText(outContract, state.outputs.censusContract);
  if (outputContractItem) outputContractItem.hidden = !hasOutputValue(state.outputs.censusContract);
  setOutputText(outDeployTx, state.outputs.deploymentTxHash);
  if (outputDeployTxItem) outputDeployTxItem.hidden = !hasOutputValue(state.outputs.deploymentTxHash);
  setOutputText(outCensusUri, state.outputs.censusUri);
  if (outputCensusUriItem) outputCensusUriItem.hidden = !hasOutputValue(state.outputs.censusUri);
  setOutputText(outProcessId, state.outputs.processId);
  if (outputProcessIdItem) outputProcessIdItem.hidden = !hasOutputValue(state.outputs.processId);
  setOutputText(outProcessTx, state.outputs.processTxHash);
  if (outputProcessTxItem) outputProcessTxItem.hidden = !hasOutputValue(state.outputs.processTxHash);

  if (state.outputs.voteUrl) {
    outVoteUrl.textContent = state.outputs.voteUrl;
    outVoteUrl.href = state.outputs.voteUrl;
    if (copyVoteUrlBtn) copyVoteUrlBtn.disabled = false;
  } else {
    outVoteUrl.textContent = '-';
    outVoteUrl.removeAttribute('href');
    if (timelineVoteUrlWrap) timelineVoteUrlWrap.hidden = true;
    if (copyVoteUrlBtn) copyVoteUrlBtn.disabled = true;
  }

  renderCreateAuxiliaryPanels();
}

async function copyVoteUrlToClipboard() {
  if (!state.outputs.voteUrl) return;
  try {
    await navigator.clipboard.writeText(state.outputs.voteUrl);
    setCreateStatus('Vote URL copied to clipboard.');
  } catch {
    setCreateStatus('Failed to copy vote URL.', true);
  }
}

function resetOutputs() {
  state.outputs = {
    censusContract: '',
    deploymentTxHash: '',
    censusUri: '',
    processId: '',
    processTxHash: '',
    voteUrl: '',
  };
  renderOutputs();
}

function hasAnyOutputs() {
  return [
    state.outputs.censusContract,
    state.outputs.deploymentTxHash,
    state.outputs.censusUri,
    state.outputs.processId,
    state.outputs.processTxHash,
  ].some((value) => hasOutputValue(value));
}

function hasPipelineActivity() {
  return state.pipeline.some((stage) => stage.status !== 'pending' || stage.message !== 'Pending');
}

function renderCreateAuxiliaryPanels() {
  const showTimeline = state.createSubmitting || hasPipelineActivity() || hasOutputValue(state.outputs.voteUrl);
  const showOutputs = hasAnyOutputs();
  if (createTimelineCard) createTimelineCard.hidden = !showTimeline;
  if (createOutputsCard) createOutputsCard.hidden = !showOutputs;
}

function renderTimeline() {
  timelineEl.innerHTML = '';
  if (timelineVoteUrlWrap) timelineVoteUrlWrap.hidden = true;

  const stages = PIPELINE_STAGES.map((stage, index) => ({
    stage,
    index,
    status: state.pipeline.find((item) => item.id === stage.id) || { status: 'pending', message: 'Pending' },
  }));

  const runningIndex = stages.findIndex((entry) => entry.status.status === 'running');
  const errorIndex = stages.findIndex((entry) => entry.status.status === 'error');
  const lastFinishedIndex = stages.reduce((last, entry) => (
    entry.status.status === 'success' ? entry.index : last
  ), -1);

  let visibleUntil = -1;
  if (runningIndex >= 0) {
    visibleUntil = runningIndex;
  } else if (errorIndex >= 0) {
    visibleUntil = errorIndex;
  } else if (lastFinishedIndex >= 0) {
    visibleUntil = lastFinishedIndex;
  }

  if (visibleUntil >= 0) {
    for (const entry of stages) {
      if (entry.index > visibleUntil) continue;

      const row = document.createElement('li');
      row.className = 'timeline-item';

      const marker = document.createElement('span');
      marker.className = 'timeline-marker';
      marker.setAttribute('aria-hidden', 'true');
      row.append(marker);

      const content = document.createElement('div');
      content.className = 'timeline-content';

      const label = document.createElement('p');
      label.className = 'timeline-label';
      label.textContent = entry.stage.label;
      content.append(label);

      const meta = document.createElement('p');
      meta.className = 'timeline-meta';
      meta.textContent = entry.status.message || 'Running';
      content.append(meta);

      row.append(content);

      if (
        entry.stage.id === 'done'
        && entry.status.status === 'success'
        && hasOutputValue(state.outputs.voteUrl)
        && timelineVoteUrlWrap
      ) {
        timelineVoteUrlWrap.hidden = false;
        content.append(timelineVoteUrlWrap);
      }

      if (entry.status.status === 'running') {
        row.classList.add('is-current');
        const spinner = document.createElement('span');
        spinner.className = 'timeline-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        row.append(spinner);
      } else if (entry.status.status === 'error') {
        row.classList.add('is-error');
      } else {
        row.classList.add('is-completed');
        if (entry.stage.id === 'done') {
          row.classList.add('is-done');
        }
      }

      timelineEl.append(row);
    }
  }

  renderCreateAuxiliaryPanels();
}

function resetPipeline() {
  state.pipeline = PIPELINE_STAGES.map((stage) => ({
    id: stage.id,
    status: 'pending',
    message: 'Pending',
  }));
  renderTimeline();
}

function updateStage(stageId, updates) {
  const stage = state.pipeline.find((item) => item.id === stageId);
  if (!stage) return;
  Object.assign(stage, updates);
  renderTimeline();
}

async function runStage(stageId, task) {
  updateStage(stageId, { status: 'running', message: 'Running' });
  for (let attempt = 1; attempt <= INTERNAL_RPC_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await task();
      updateStage(stageId, { status: 'success', message: typeof result === 'string' ? result : 'Completed' });
      return result;
    } catch (error) {
      const canRetry = isInternalJsonRpcError(error) && attempt < INTERNAL_RPC_RETRY_MAX_ATTEMPTS;
      if (canRetry) {
        console.warn(
          `[OpenCitizenCensus] Internal JSON-RPC error in stage "${stageId}" (attempt ${attempt}/${INTERNAL_RPC_RETRY_MAX_ATTEMPTS}). Retrying...`,
          error,
        );
        updateStage(stageId, {
          status: 'running',
          message: `Internal wallet RPC error. Retrying (${attempt + 1}/${INTERNAL_RPC_RETRY_MAX_ATTEMPTS})...`,
        });
        await wait(INTERNAL_RPC_RETRY_DELAY_MS);
        continue;
      }

      const stageLabel = PIPELINE_STAGES.find((stage) => stage.id === stageId)?.label || stageId;
      console.error(`[OpenCitizenCensus] Create pipeline stage failed: ${stageId}`, error);
      const message = `Could not complete "${stageLabel}". Check browser console for technical details.`;
      updateStage(stageId, { status: 'error', message });
      throw error;
    }
  }

  throw new Error(`${stageId} failed`);
}

function ensureCreateDefaults() {
  if (!startDateInput.value) {
    startDateInput.value = toDateTimeLocal(new Date(Date.now() + 10 * 60 * 1000));
  }
}

function renderWizard() {
  const walletLocked = !isCreatorWalletConnected();
  const createFormLocked = walletLocked || state.createSubmitting;

  createForm.querySelectorAll('input, textarea, select').forEach((control) => {
    control.disabled = createFormLocked;
  });

  for (const panel of stepPanels) {
    const step = Number(panel.dataset.stepPanel);
    panel.hidden = step !== state.createStep;
  }

  for (const indicator of stepIndicators) {
    const step = Number(indicator.dataset.stepIndicator);
    indicator.dataset.active = step === state.createStep ? 'true' : 'false';
    indicator.dataset.done = step < state.createStep ? 'true' : 'false';
    indicator.disabled = walletLocked || step > state.createStep || state.createSubmitting;
    if (step === state.createStep) {
      indicator.setAttribute('aria-current', 'step');
    } else {
      indicator.removeAttribute('aria-current');
    }
  }

  stepBackBtn.disabled = walletLocked || state.createStep === 1 || state.createSubmitting;
  stepBackBtn.hidden = stepBackBtn.disabled;
  stepNextBtn.hidden = state.createStep === 3;
  createButton.hidden = state.createStep !== 3;
  stepNextBtn.disabled = walletLocked || state.createSubmitting;
  createButton.disabled = walletLocked || state.createSubmitting;

  refreshQuestionIndices();
}

function showStep(step) {
  state.createStep = Math.min(3, Math.max(1, step));
  renderWizard();
}

function validateStepOne() {
  const country = normalizeCountry(countryInput.value);
  const minAge = normalizeMinAge(minAgeInput.value);
  const scopeSeed = normalizeScope(scopeSeedInput.value);

  if (!/^[A-Z]{2,3}$/.test(country)) {
    throw new Error('Country must be an ISO alpha-2 or alpha-3 code.');
  }
  if (!minAge) {
    throw new Error('Minimum age must be between 1 and 99.');
  }
  if (!scopeSeed || scopeSeed.length > 31) {
    throw new Error('Scope seed must contain between 1 and 31 characters.');
  }
  ensureAsciiField(scopeSeed, 'Scope seed');
  if (!state.creatorWallet.address) {
    throw new Error('Connect the creator browser wallet before continuing.');
  }
}

function validateStepTwo() {
  const title = String(processTitleInput.value || '').trim();
  const description = String(processDescriptionInput.value || '').trim();
  const maxVoters = Number(maxVotersInput.value);
  const durationHours = Number(durationHoursInput.value);

  if (!title) {
    throw new Error('Process title is required.');
  }
  ensureAsciiField(title, 'Process title');
  ensureAsciiField(description, 'Process description');
  if (!Number.isFinite(maxVoters) || maxVoters <= 0) {
    throw new Error('Maximum voters must be a positive number.');
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new Error('Duration must be a positive number of hours.');
  }
}

function validateStepThree() {
  const questions = parseQuestions();
  if (!questions.length) {
    throw new Error('Add at least one question.');
  }
}

function validateCurrentStep() {
  if (state.createStep === 1) validateStepOne();
  if (state.createStep === 2) validateStepTwo();
  if (state.createStep === 3) validateStepThree();
}

function createChoiceRow(value = '') {
  const row = document.createElement('div');
  row.className = 'choice-row';
  row.innerHTML = `
    <input type="text" class="choice-input" autocomplete="off" placeholder="Choice label…" />
    <button type="button" class="ghost" data-action="remove-choice">Remove</button>
  `;
  row.querySelector('.choice-input').value = value;
  return row;
}

function updateChoiceControls(card) {
  const createFormLocked = !isCreatorWalletConnected() || state.createSubmitting;
  const rows = card.querySelectorAll('.choice-row');
  const removeButtons = card.querySelectorAll('[data-action="remove-choice"]');
  removeButtons.forEach((button) => {
    button.disabled = createFormLocked || rows.length <= 2;
  });
}

function createQuestionCard() {
  const card = document.createElement('article');
  card.className = 'question-card';
  card.innerHTML = `
    <div class="question-head">
      <strong class="question-index">Question</strong>
      <button type="button" class="ghost" data-action="remove-question">Remove</button>
    </div>
    <label>
      Title
      <input type="text" class="question-title" placeholder="What should this process decide?…" autocomplete="off" required />
    </label>
    <label>
      Description
      <textarea class="question-description" rows="2" autocomplete="off" placeholder="Optional context…"></textarea>
    </label>
    <div class="choice-list" data-choices></div>
    <div class="row">
      <button type="button" class="ghost" data-action="add-choice">Add choice</button>
    </div>
  `;

  const choices = card.querySelector('[data-choices]');
  choices.append(createChoiceRow('Yes'));
  choices.append(createChoiceRow('No'));
  updateChoiceControls(card);
  return card;
}

function refreshQuestionIndices() {
  const createFormLocked = !isCreatorWalletConnected() || state.createSubmitting;
  const cards = Array.from(questionList.querySelectorAll('.question-card'));
  cards.forEach((card, index) => {
    const title = card.querySelector('.question-index');
    const removeButton = card.querySelector('[data-action="remove-question"]');
    title.textContent = `Question ${index + 1}`;
    removeButton.disabled = createFormLocked || cards.length <= 1;
    updateChoiceControls(card);
  });
  addQuestionButton.disabled = createFormLocked || cards.length >= 8;
}

function initQuestions() {
  questionList.innerHTML = '';
  questionList.append(createQuestionCard());
  refreshQuestionIndices();

  addQuestionButton.addEventListener('click', () => {
    questionList.append(createQuestionCard());
    refreshQuestionIndices();
  });

  questionList.addEventListener('click', (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;

    const card = actionTarget.closest('.question-card');
    if (!card) return;
    const action = actionTarget.dataset.action;

    if (action === 'add-choice') {
      card.querySelector('[data-choices]').append(createChoiceRow(''));
      updateChoiceControls(card);
      return;
    }

    if (action === 'remove-choice') {
      const row = actionTarget.closest('.choice-row');
      if (row) row.remove();
      updateChoiceControls(card);
      return;
    }

    if (action === 'remove-question') {
      card.remove();
      refreshQuestionIndices();
    }
  });
}

function parseQuestions() {
  const cards = Array.from(questionList.querySelectorAll('.question-card'));
  if (!cards.length) {
    throw new Error('Add at least one question.');
  }

  return cards.map((card, questionIndex) => {
    const title = String(card.querySelector('.question-title')?.value || '').trim();
    if (!title) {
      throw new Error(`Question ${questionIndex + 1} needs a title.`);
    }
    ensureAsciiField(title, `Question ${questionIndex + 1} title`);

    const description = String(card.querySelector('.question-description')?.value || '').trim();
    ensureAsciiField(description, `Question ${questionIndex + 1} description`);
    const choices = Array.from(card.querySelectorAll('.choice-input')).map((input, choiceIndex) => {
      const choiceTitle = String(input.value || '').trim();
      if (!choiceTitle) {
        throw new Error(`Question ${questionIndex + 1} has an empty choice.`);
      }
      ensureAsciiField(choiceTitle, `Question ${questionIndex + 1} choice ${choiceIndex + 1}`);
      return { title: choiceTitle, value: choiceIndex };
    });

    if (choices.length < 2) {
      throw new Error(`Question ${questionIndex + 1} needs at least two choices.`);
    }

    return { title, description, choices };
  });
}

function buildBallotFromQuestions(questions) {
  const maxValues = questions.map((question) => question.choices.length - 1);
  const maxValue = Math.max(...maxValues);
  const maxValueSum = maxValues.reduce((sum, value) => sum + value, 0);

  return {
    numFields: questions.length,
    maxValue: String(maxValue),
    minValue: '0',
    uniqueValues: false,
    costFromWeight: false,
    costExponent: 1,
    maxValueSum: String(maxValueSum),
    minValueSum: '0',
  };
}

function collectCreateFormValues() {
  const country = normalizeCountry(countryInput.value);
  const minAge = normalizeMinAge(minAgeInput.value);
  const scopeSeed = normalizeScope(scopeSeedInput.value);
  const title = String(processTitleInput.value || '').trim();
  const description = String(processDescriptionInput.value || '').trim();
  const maxVoters = Number(maxVotersInput.value);
  const durationHours = Number(durationHoursInput.value);
  const startRaw = String(startDateInput.value || '').trim();

  if (!/^[A-Z]{2,3}$/.test(country)) {
    throw new Error('Country must be ISO alpha-2 or alpha-3 uppercase.');
  }
  if (!minAge) {
    throw new Error('Minimum age must be between 1 and 99.');
  }
  if (!scopeSeed || scopeSeed.length > 31) {
    throw new Error('Scope seed must contain 1-31 characters.');
  }
  ensureAsciiField(scopeSeed, 'Scope seed');
  if (!title) {
    throw new Error('Process title is required.');
  }
  ensureAsciiField(title, 'Process title');
  ensureAsciiField(description, 'Process description');
  if (!Number.isFinite(maxVoters) || maxVoters <= 0) {
    throw new Error('Maximum voters must be a positive number.');
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new Error('Duration must be greater than 0 hours.');
  }

  let startDate = startRaw ? new Date(startRaw) : new Date(Date.now() + 10 * 60 * 1000);
  if (Number.isNaN(startDate.getTime()) || startDate.getTime() < Date.now()) {
    startDate = new Date(Date.now() + 10 * 60 * 1000);
  }

  const questions = parseQuestions();
  const ballot = buildBallotFromQuestions(questions);

  return {
    country,
    minAge,
    scopeSeed,
    title,
    description,
    maxVoters: Math.trunc(maxVoters),
    duration: Math.round(durationHours * 3600),
    startDate,
    questions,
    ballot,
  };
}

function getVerificationConfig(minAge) {
  return {
    olderThanEnabled: minAge > 0,
    olderThan: BigInt(minAge),
    forbiddenCountriesEnabled: false,
    forbiddenCountriesListPacked: EMPTY_COUNTRIES,
    ofacEnabled: EMPTY_OFAC,
  };
}

function computeConfigId(minAge) {
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

function buildDeployData({ scopeSeed, country, minAge, configId }) {
  const bytecode = artifact.bytecode?.object || artifact.bytecode;
  if (!bytecode) throw new Error('Contract artifact bytecode is missing.');

  const encodedArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'string', 'bytes32', 'string', 'uint256'],
    [ACTIVE_NETWORK.hubAddress, scopeSeed, configId, country, BigInt(minAge)]
  );

  return `${bytecode}${encodedArgs.slice(2)}`;
}

function buildCensusUri(contractAddress) {
  const base = trimTrailingSlash(CONFIG.davinciCensusUrl || CONFIG.onchainIndexerUrl);
  if (!base) {
    throw new Error('Missing VITE_DAVINCI_CENSUS_URL or VITE_ONCHAIN_CENSUS_INDEXER_URL.');
  }

  return `${base}/${ACTIVE_NETWORK.chainId}/${String(contractAddress).toLowerCase()}/graphql`;
}

function toHttpCensusUri(censusUri) {
  const value = String(censusUri || '').trim();
  if (!value) return '';
  if (/^graphql:\/\//i.test(value)) {
    return value.replace(/^graphql:\/\//i, 'https://');
  }
  return value;
}

function toSequencerCensusUri(censusUri) {
  const value = String(censusUri || '').trim();
  if (!value) return '';
  if (/^graphql:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^https?:\/\//i, 'graphql://');
  }
  return `graphql://${value.replace(/^\/+/, '')}`;
}

function buildVoteLinkPayload(processId, config = {}) {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return '';

  const payload = sanitizeVoteEnvPayload({
    v: VOTE_LINK_ENV_VERSION,
    processId: normalized,
    contractAddress: config.contractAddress,
    censusUri: config.censusUri,
    scope: config.scope,
    minAge: config.minAge,
    country: config.country,
    network: config.network || CONFIG.network,
    sequencerUrl: config.sequencerUrl || CONFIG.davinciSequencerUrl,
    title: config.title,
  });

  if (!payload) return '';
  return encodeBase64UrlJson({ v: VOTE_LINK_ENV_VERSION, ...payload });
}

function buildVoteUrl(processId, config = {}) {
  const normalized = normalizeProcessId(processId);
  if (!normalized) return '';
  const context = buildVoteLinkPayload(normalized, config);
  if (!context) return `${window.location.origin}${encodeBasePath('/vote')}`;
  return `${window.location.origin}${encodeBasePath(`/vote/${encodeURIComponent(context)}`)}`;
}

async function waitForTransaction(provider, hash, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await wait(2500);
  }
  throw new Error(`Timed out waiting for tx receipt: ${hash}`);
}

async function createWalletConnectProvider() {
  if (!CONFIG.walletConnectProjectId) {
    throw new Error('Missing VITE_WALLETCONNECT_PROJECT_ID.');
  }

  const requiredChains = [1];
  const optionalChains = Array.from(new Set([1, ACTIVE_NETWORK.chainId, ...Object.values(NETWORKS).map((n) => n.chainId)]));

  return EthereumProvider.init({
    projectId: CONFIG.walletConnectProjectId,
    chains: requiredChains,
    optionalChains,
    showQrModal: true,
    metadata: {
      name: 'Open Citizen Census',
      description: 'Create and vote on census-based processes',
      url: window.location.origin,
      icons: [],
    },
    rpcMap: ACTIVE_NETWORK.rpcUrl ? { [ACTIVE_NETWORK.chainId]: ACTIVE_NETWORK.rpcUrl } : undefined,
    methods: [
      'eth_sendTransaction',
      'eth_signTransaction',
      'eth_sign',
      'personal_sign',
      'eth_signTypedData',
      'eth_estimateGas',
      'eth_call',
      'eth_chainId',
      'wallet_switchEthereumChain',
    ],
  });
}

function getInjectedProvider() {
  const { ethereum } = window;
  if (!ethereum) return null;

  if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
    const metamaskProvider = ethereum.providers.find((provider) => provider?.isMetaMask && !provider?.isBraveWallet);
    return metamaskProvider || ethereum.providers[0];
  }

  return ethereum;
}

function getWalletSourceLabel(provider, fallback = 'WalletConnect') {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  return fallback;
}

function applyWalletConnection(connection) {
  state.creatorWallet.provider = connection.provider;
  state.creatorWallet.browserProvider = connection.browserProvider;
  state.creatorWallet.signer = connection.signer;
  state.creatorWallet.address = connection.address;
  creatorWalletAddressEl.textContent = connection.address;
  creatorWalletStatusEl.textContent = `Connected with ${connection.sourceLabel} on ${ACTIVE_NETWORK.label}.`;
  renderWalletButtons();
}

async function disconnectWalletConnection() {
  const provider = state.creatorWallet.provider;

  if (provider && typeof provider.disconnect === 'function' && typeof provider.enable === 'function') {
    try {
      await provider.disconnect();
    } catch {
      // Ignore provider disconnect errors and clear local app state anyway.
    }
  }

  state.creatorWallet.provider = null;
  state.creatorWallet.browserProvider = null;
  state.creatorWallet.signer = null;
  state.creatorWallet.address = '';
  creatorWalletAddressEl.textContent = 'Wallet not connected yet...';
  creatorWalletStatusEl.textContent = CREATOR_WALLET_STATUS_DEFAULT;
  setCreateStatus('Creator wallet disconnected.');

  renderWalletButtons();
}

async function ensureProviderChain(provider) {
  const currentChainId = await provider.request({ method: 'eth_chainId' });
  if (String(currentChainId).toLowerCase() === ACTIVE_NETWORK.chainHex.toLowerCase()) {
    return;
  }

  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: ACTIVE_NETWORK.chainHex }],
  });
}

async function connectInjectedWallet(provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error('No wallet account selected.');
  }
  await ensureProviderChain(provider);

  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner(accounts[0]);
  const address = await signer.getAddress();
  const connection = {
    provider,
    browserProvider,
    signer,
    address,
    sourceLabel: getWalletSourceLabel(provider, 'Browser wallet'),
  };
  applyWalletConnection(connection);
  return connection;
}

async function connectWalletConnect() {
  let provider = state.creatorWallet.provider;

  if (!provider || typeof provider.enable !== 'function') {
    provider = await createWalletConnectProvider();
  }

  await provider.enable();
  await ensureProviderChain(provider);

  const browserProvider = new BrowserProvider(provider, 'any');
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();
  const connection = {
    provider,
    browserProvider,
    signer,
    address,
    sourceLabel: 'WalletConnect',
  };
  applyWalletConnection(connection);
  return connection;
}

async function connectBrowserWallet() {
  const injectedProvider = getInjectedProvider();
  if (injectedProvider) {
    return connectInjectedWallet(injectedProvider);
  }
  return connectWalletConnect();
}

async function connectCreatorWallet() {
  try {
    creatorWalletStatusEl.textContent = 'Connecting browser wallet...';
    await connectBrowserWallet();
    setCreateStatus('Creator wallet connected. Continue with step 2.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect creator wallet.';
    creatorWalletStatusEl.textContent = message;
    setCreateStatus(message, true);
  }
}

async function handleCreatorWalletButton() {
  if (isCreatorWalletConnected()) {
    await disconnectWalletConnection();
    return;
  }
  await connectCreatorWallet();
}

async function ensureCreatorWalletForPipeline(ctx) {
  if (!state.creatorWallet.signer) {
    const connection = await connectBrowserWallet();
    ctx.provider = connection.provider;
    ctx.browserProvider = connection.browserProvider;
    ctx.signer = connection.signer;
    ctx.creatorAddress = connection.address;
    return `Connected ${connection.address}`;
  }

  ctx.provider = state.creatorWallet.provider;
  ctx.browserProvider = state.creatorWallet.browserProvider;
  ctx.signer = state.creatorWallet.signer;
  ctx.creatorAddress = state.creatorWallet.address;
  return `Using connected wallet ${ctx.creatorAddress}`;
}

async function ensureSelfConfigRegistered(ctx) {
  const configId = computeConfigId(ctx.values.minAge);
  ctx.configId = configId;

  const existsData = HUB_INTERFACE.encodeFunctionData('verificationConfigV2Exists', [configId]);
  const existsRaw = await ctx.provider.request({
    method: 'eth_call',
    params: [{ to: ACTIVE_NETWORK.hubAddress, data: existsData }, 'latest'],
  });

  const [exists] = HUB_INTERFACE.decodeFunctionResult('verificationConfigV2Exists', existsRaw);
  if (exists) {
    return `Config already registered (${configId})`;
  }

  const verificationConfig = getVerificationConfig(ctx.values.minAge);
  const txData = HUB_INTERFACE.encodeFunctionData('setVerificationConfigV2', [verificationConfig]);
  const tx = await ctx.signer.sendTransaction({
    to: ACTIVE_NETWORK.hubAddress,
    data: txData,
  });

  await waitForTransaction(ctx.browserProvider, tx.hash);
  return `Config registered (${tx.hash})`;
}

async function deployCensusContract(ctx) {
  const data = buildDeployData({
    scopeSeed: ctx.values.scopeSeed,
    country: ctx.values.country,
    minAge: ctx.values.minAge,
    configId: ctx.configId,
  });

  const tx = await ctx.signer.sendTransaction({ data });
  state.outputs.deploymentTxHash = tx.hash;
  renderOutputs();

  const receipt = await waitForTransaction(ctx.browserProvider, tx.hash);
  if (!receipt.contractAddress) {
    throw new Error('Contract address was not found in deployment receipt.');
  }

  ctx.contractAddress = receipt.contractAddress;
  ctx.deploymentBlock = Number(receipt.blockNumber || 0);
  state.outputs.censusContract = receipt.contractAddress;
  renderOutputs();

  return receipt.contractAddress;
}

async function startIndexer(ctx) {
  if (!CONFIG.onchainIndexerUrl) {
    throw new Error('Missing VITE_ONCHAIN_CENSUS_INDEXER_URL.');
  }

  const url = `${trimTrailingSlash(CONFIG.onchainIndexerUrl)}/contracts`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: ACTIVE_NETWORK.chainId,
      address: ctx.contractAddress,
      startBlock: ctx.deploymentBlock,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Indexer bootstrap failed (${response.status}) ${text}`.trim());
  }

  return 'Indexer accepted contract';
}

async function waitIndexerReady(ctx) {
  const censusUri = buildCensusUri(ctx.contractAddress);
  const queryUri = toHttpCensusUri(censusUri);
  state.outputs.censusUri = censusUri;
  renderOutputs();

  const timeoutMs = 90_000;
  const start = Date.now();
  let lastError = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(queryUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: CENSUS_MEMBERS_QUERY,
          variables: { first: 1, skip: 0 },
        }),
      });

      if (response.ok) {
        const json = await response.json();
        if (json && !json.errors) {
          ctx.censusUri = censusUri;
          return 'Census query endpoint is ready';
        }
        lastError = json?.errors?.[0]?.message || 'GraphQL returned errors';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Indexer readiness failed';
    }

    await wait(4_000);
  }

  throw new Error(`Indexer readiness timeout. Last error: ${lastError}`);
}

async function getProcessFromSequencer(sdk, processId) {
  const normalized = normalizeProcessId(processId);
  try {
    return await sdk.api.sequencer.getProcess(normalized);
  } catch (error) {
    const withoutPrefix = normalized.replace(/^0x/, '');
    if (withoutPrefix === normalized) throw error;
    return sdk.api.sequencer.getProcess(withoutPrefix);
  }
}

function isProcessAcceptingVotes(process) {
  return Boolean(process && typeof process === 'object' && process.isAcceptingVotes === true);
}

async function createDavinciProcess(ctx) {
  if (!CONFIG.davinciSequencerUrl) {
    throw new Error('Missing VITE_DAVINCI_SEQUENCER_URL.');
  }

  const sdk = new DavinciSDK({
    signer: ctx.signer,
    sequencerUrl: CONFIG.davinciSequencerUrl,
  });
  await sdk.init();

  const sequencerCensusUri = toSequencerCensusUri(ctx.censusUri);
  if (!sequencerCensusUri) {
    throw new Error('Missing census URI for sequencer process creation.');
  }

  const census = new OnchainCensus(ctx.contractAddress, sequencerCensusUri);
  const result = await sdk.createProcess({
    title: ctx.values.title,
    description: ctx.values.description,
    census,
    maxVoters: ctx.values.maxVoters,
    ballot: ctx.values.ballot,
    timing: {
      startDate: ctx.values.startDate,
      duration: ctx.values.duration,
    },
    questions: ctx.values.questions,
  });

  const processId = normalizeProcessId(result.processId);
  if (!processId) throw new Error('Process creation did not return a process ID.');

  ctx.sdk = sdk;
  ctx.processId = processId;
  state.outputs.processId = processId;
  state.outputs.processTxHash = result.txHash || result.transactionHash || '';
  renderOutputs();

  return `Process created (${processId})`;
}

async function waitProcessReadyInSequencer(ctx) {
  const timeoutMs = 90_000;
  const start = Date.now();
  let lastError = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const process = await getProcessFromSequencer(ctx.sdk, ctx.processId);
      if (process && isProcessAcceptingVotes(process)) {
        state.outputs.voteUrl = buildVoteUrl(ctx.processId, {
          contractAddress: ctx.contractAddress,
          censusUri: ctx.censusUri,
          scope: ctx.values.scopeSeed,
          minAge: ctx.values.minAge,
          country: ctx.values.country,
          network: CONFIG.network,
          sequencerUrl: CONFIG.davinciSequencerUrl,
          title: ctx.values.title,
        });
        renderOutputs();
        return 'Process is ready in sequencer';
      }
      lastError = 'Process is not accepting votes yet';
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Sequencer lookup failed';
    }
    await wait(3_000);
  }

  throw new Error(`Sequencer readiness timeout. Last error: ${lastError}`);
}

function setCreateSubmitting(isSubmitting) {
  state.createSubmitting = isSubmitting;
  createButton.disabled = isSubmitting;
  setButtonLabel(createButton, isSubmitting ? 'Launching...' : 'Launch Process', isSubmitting ? 'iconoir-refresh' : 'iconoir-nav-arrow-right');
  stepNextBtn.disabled = isSubmitting;
  stepBackBtn.disabled = isSubmitting || state.createStep === 1;
  renderWizard();
  renderCreateAuxiliaryPanels();
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  if (state.createSubmitting) return;
  if (state.createStep !== 3) {
    setCreateStatus('Complete all steps before launching the process.', true);
    return;
  }

  try {
    validateStepThree();
  } catch (error) {
    setCreateStatus(error instanceof Error ? error.message : 'Invalid questions.', true);
    return;
  }

  resetOutputs();
  resetPipeline();
  setCreateSubmitting(true);
  setCreateStatus('Running launch pipeline...');

  const ctx = {
    values: null,
    configId: '',
    provider: null,
    browserProvider: null,
    signer: null,
    creatorAddress: '',
    contractAddress: '',
    deploymentBlock: 0,
    censusUri: '',
    sdk: null,
    processId: '',
  };

  try {
    await runStage('validate_form', async () => {
      ctx.values = collectCreateFormValues();
      return 'Form validated';
    });

    await runStage('connect_creator_wallet_walletconnect', () => ensureCreatorWalletForPipeline(ctx));
    await runStage('ensure_self_config_registered', () => ensureSelfConfigRegistered(ctx));
    await runStage('deploy_census_contract', () => deployCensusContract(ctx));
    await runStage('start_indexer', () => startIndexer(ctx));
    await runStage('wait_indexer_ready', () => waitIndexerReady(ctx));
    await runStage('create_davinci_process', () => createDavinciProcess(ctx));
    await runStage('wait_process_ready_in_sequencer', () => waitProcessReadyInSequencer(ctx));
    await runStage('done', async () => 'Completed');

    persistProcessMeta(ctx.processId, {
      contractAddress: ctx.contractAddress,
      censusUri: ctx.censusUri,
      title: ctx.values.title,
      scopeSeed: ctx.values.scopeSeed,
      country: ctx.values.country,
      minAge: ctx.values.minAge,
      network: CONFIG.network,
      updatedAt: new Date().toISOString(),
    });
    persistVoteScopeSeed(ctx.processId, ctx.values.scopeSeed);

    state.createFormDirty = false;
    setCreateStatus('Process launched successfully. You can open the generated vote URL.');
  } catch (error) {
    console.error('[OpenCitizenCensus] Create pipeline failed', error);
    setCreateStatus('Pipeline failed. Check the failed stage and browser console for details.', true);
  } finally {
    setCreateSubmitting(false);
  }
}

function normalizePrivateKey(value) {
  const trimmed = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error('Private key must be 0x-prefixed 64 hex chars.');
  }
  return trimmed;
}

function getWalletOverrideKey(processId) {
  return `occ.walletOverride.${processId || 'default'}`;
}

function getOrCreateMasterSecret() {
  const existing = localStorage.getItem(MASTER_SECRET_KEY);
  if (existing && /^0x[a-fA-F0-9]{64}$/.test(existing)) {
    return existing;
  }

  const generated = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const secret = `0x${generated}`;
  localStorage.setItem(MASTER_SECRET_KEY, secret);
  return secret;
}

function derivePrivateKey(processId) {
  const seed = getOrCreateMasterSecret();
  const normalizedProcessId = normalizeProcessId(processId || 'default');
  const material = `${seed}:${normalizedProcessId.toLowerCase()}`;
  let candidate = keccak256(new TextEncoder().encode(material));

  try {
    // eslint-disable-next-line no-new
    new Wallet(candidate);
  } catch {
    candidate = keccak256(new TextEncoder().encode(`${material}:fallback`));
  }

  return normalizePrivateKey(candidate);
}

function getWalletOverride(processId) {
  const raw = localStorage.getItem(getWalletOverrideKey(processId));
  if (!raw) return '';
  try {
    return normalizePrivateKey(raw);
  } catch {
    return '';
  }
}

function setWalletOverride(processId, privateKey) {
  localStorage.setItem(getWalletOverrideKey(processId), normalizePrivateKey(privateKey));
}

function clearWalletOverride(processId) {
  localStorage.removeItem(getWalletOverrideKey(processId));
}

function loadManagedWallet(processId) {
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

function renderManagedWallet() {
  const wallet = state.voteManaged.wallet;
  walletAddressEl.textContent = wallet?.address || '-';
  walletSourceEl.textContent = wallet?.source || '-';

  if (!wallet || !state.voteManaged.privateVisible) {
    walletPrivateKeyEl.textContent = 'hidden';
    walletSecretBoxEl.hidden = true;
    copyKeyBtn.disabled = true;
    setButtonLabel(revealKeyBtn, 'Reveal private key', 'iconoir-eye');
    updateVoteSelfControls();
    return;
  }

  walletPrivateKeyEl.textContent = wallet.privateKey;
  walletSecretBoxEl.hidden = false;
  copyKeyBtn.disabled = false;
  setButtonLabel(revealKeyBtn, 'Hide private key', 'iconoir-eye');

  updateVoteSelfControls();
}

function clearVoteSelfArtifacts(resetAutoTrigger = true) {
  state.voteSelf.link = '';
  if (resetAutoTrigger) {
    state.voteSelf.autoTriggerKey = '';
  }
  if (voteSelfQrImageEl) voteSelfQrImageEl.removeAttribute('src');
  if (voteSelfQrWrapEl) voteSelfQrWrapEl.hidden = true;
}

function getVoteSelfAutoTriggerKey() {
  const processId = normalizeProcessId(state.voteResolution.processId);
  const contractAddress = String(state.voteResolution.censusContract || '').toLowerCase();
  const managedAddress = String(state.voteManaged.wallet?.address || '').toLowerCase();
  const scopeSeed = normalizeScope(state.voteSelf.scopeSeed || '');
  const minAge = state.voteSelf.minAge ? String(state.voteSelf.minAge) : '';

  if (!processId || !contractAddress || !managedAddress || !scopeSeed || state.route.name !== 'vote') {
    return '';
  }
  return [processId.toLowerCase(), contractAddress, managedAddress, scopeSeed, minAge].join('|');
}

function maybeAutoGenerateVoteSelfQr() {
  if (state.voteResolution.sequencerWeight > 0n) return;
  const key = getVoteSelfAutoTriggerKey();
  if (!key) return;
  if (state.voteSelf.generating || state.voteSelf.link) return;
  if (state.voteSelf.autoTriggerKey === key) return;

  state.voteSelf.autoTriggerKey = key;
  generateVoteSelfQr({ auto: true });
}

function updateVoteSelfControls() {
  const hasResolvedProcess = Boolean(state.voteResolution.processId && state.voteResolution.censusContract);
  const hasManagedWallet = Boolean(state.voteManaged.wallet?.address);
  const hasScopeSeed = Boolean(normalizeScope(state.voteSelf.scopeSeed || ''));
  const sequencerEligible = state.voteResolution.sequencerWeight > 0n;
  const canGenerate = hasResolvedProcess && hasManagedWallet && hasScopeSeed && !state.voteSelf.generating && !sequencerEligible;
  const hasLink = Boolean(state.voteSelf.link) && !sequencerEligible;

  if (voteScopeSeedInfoEl) voteScopeSeedInfoEl.textContent = state.voteSelf.scopeSeed || '-';
  if (voteSelfMinAgeInfoEl) voteSelfMinAgeInfoEl.textContent = state.voteSelf.minAge ? String(state.voteSelf.minAge) : '-';
  if (voteCountryInfoEl) voteCountryInfoEl.textContent = state.voteSelf.country || '-';
  if (generateVoteSelfQrBtn) {
    generateVoteSelfQrBtn.disabled = !canGenerate;
  }
  if (copyVoteSelfLinkBtn) {
    copyVoteSelfLinkBtn.disabled = !hasLink;
  }
  if (openVoteSelfLinkBtn) {
    openVoteSelfLinkBtn.disabled = !hasLink;
  }

  renderVoteSelfRegistrationLockState();
  maybeAutoGenerateVoteSelfQr();
  updateVoteBallotControls();
  renderRegistrationStatusTimeline();
}

function updateVoteSelfCardVisibility() {
  if (!voteSelfCardEl) return;

  const sequencerEligible = state.voteResolution.sequencerWeight > 0n;
  if (sequencerEligible) {
    if (!voteSelfCardEl.open) {
      voteSelfCardEl.open = true;
    }
    if (!state.voteSelf.autoCollapsedForEligibility) {
      state.voteSelf.autoCollapsedForEligibility = true;
      setVoteSelfStatus('You are already registered in the sequencer census.');
    }
    renderVoteSelfRegistrationLockState();
    return;
  }

  state.voteSelf.autoCollapsedForEligibility = false;
  renderVoteSelfRegistrationLockState();
}

function renderVoteSelfRegistrationLockState() {
  const locked = state.voteResolution.sequencerWeight > 0n;
  if (voteSelfRegistrationLayoutEl) {
    voteSelfRegistrationLayoutEl.classList.toggle('is-locked', locked);
  }
  if (voteSelfQrActionsEl) {
    voteSelfQrActionsEl.classList.toggle('is-locked', locked);
  }
  if (voteAlreadyRegisteredMsgEl) {
    voteAlreadyRegisteredMsgEl.hidden = !locked;
  }
}

function getLocalizedText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.default === 'string') return value.default;
  const first = Object.values(value).find((item) => typeof item === 'string');
  return first || '';
}

function normalizeVoteQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions.map((question, questionIndex) => {
    const title = String(getLocalizedText(question?.title) || `Question ${questionIndex + 1}`).trim();
    const description = String(getLocalizedText(question?.description) || '').trim();
    const rawChoices = Array.isArray(question?.choices) ? question.choices : [];
    const choices = rawChoices.map((choice, choiceIndex) => {
      const titleValue = String(getLocalizedText(choice?.title) || `Choice ${choiceIndex + 1}`).trim();
      const parsedValue = Number(choice?.value);
      const value = Number.isInteger(parsedValue) ? parsedValue : choiceIndex;
      return { value, title: titleValue };
    });

    return {
      title,
      description,
      choices: choices.length ? choices : [{ value: 0, title: 'Option 1' }],
    };
  }).filter((question) => question.choices.length > 0);
}

function normalizeVoteStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return VOTE_STATUS_INFO[normalized] ? normalized : '';
}

function formatVoteStatusLabel(status) {
  const normalized = normalizeVoteStatus(status);
  if (!normalized) return '-';
  return VOTE_STATUS_INFO[normalized].label;
}

function hasStoredVoteId() {
  return Boolean(String(state.voteBallot.submissionId || '').trim());
}

function isVoteStatusTerminal(status) {
  const normalized = normalizeVoteStatus(status);
  return normalized === 'settled' || normalized === 'error';
}

function canOverwriteVote() {
  if (!hasStoredVoteId()) return true;
  return isVoteStatusTerminal(state.voteBallot.submissionStatus);
}

function renderVoteStatusInfoVisibility() {
  const visible = hasStoredVoteId();
  if (voteStatusGuideEl) voteStatusGuideEl.hidden = !visible;
  if (voteStatusFlowIdLineEl) voteStatusFlowIdLineEl.hidden = !visible;
}

function renderVoteStatusTimeline() {
  if (!voteStatusTimelineEl) return;

  voteStatusTimelineEl.innerHTML = '';

  const hasVoteId = Boolean(state.voteBallot.submissionId);
  const currentStatus = normalizeVoteStatus(state.voteBallot.submissionStatus) || (hasVoteId ? 'pending' : '');
  const isErrorStatus = currentStatus === 'error';
  const flow = isErrorStatus ? [...VOTE_STATUS_FLOW, 'error'] : VOTE_STATUS_FLOW;
  const currentIndex = flow.indexOf(currentStatus);

  flow.forEach((status, index) => {
    const row = document.createElement('li');
    row.className = 'vote-status-item';

    if (hasVoteId || currentStatus) {
      if (isErrorStatus) {
        if (status === 'error') {
          row.classList.add('is-current', 'is-error');
        }
      } else if (currentIndex >= 0) {
        if (index < currentIndex) {
          row.classList.add('is-complete');
        } else if (index === currentIndex) {
          row.classList.add('is-current');
        }
      }
    }

    const marker = document.createElement('span');
    marker.className = 'vote-status-marker';
    marker.setAttribute('aria-hidden', 'true');

    if (row.classList.contains('is-current') && state.voteBallot.submitting) {
      const spinner = document.createElement('span');
      spinner.className = 'timeline-spinner';
      marker.append(spinner);
    } else if (row.classList.contains('is-complete') || (row.classList.contains('is-current') && status === 'settled')) {
      marker.textContent = '✓';
    } else if (row.classList.contains('is-error')) {
      marker.textContent = '!';
    } else {
      marker.textContent = String(index + 1);
    }

    const content = document.createElement('div');
    content.className = 'vote-status-content';

    const label = document.createElement('p');
    label.className = 'vote-status-label';
    label.textContent = VOTE_STATUS_INFO[status]?.label || formatVoteStatusLabel(status);
    content.append(label);

    const description = document.createElement('p');
    description.className = 'vote-status-description';
    description.textContent = VOTE_STATUS_INFO[status]?.description || '';
    content.append(description);

    row.append(marker, content);
    voteStatusTimelineEl.append(row);
  });

  renderVoteStatusInfoVisibility();
}

function formatReadinessCheckTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    return '';
  }
}

function renderRegistrationStatusTimeline() {
  if (!registrationStatusTimelineEl) return;
  registrationStatusTimelineEl.innerHTML = '';

  const hasResolvedProcess = Boolean(state.voteResolution.processId && state.voteResolution.censusContract);
  const hasManagedWallet = Boolean(state.voteManaged.wallet?.address);
  const hasScopeSeed = Boolean(normalizeScope(state.voteSelf.scopeSeed || ''));
  const hasContextReady = hasResolvedProcess && hasManagedWallet && hasScopeSeed;
  const qrReady = Boolean(state.voteSelf.link);
  const onchainRequired = isOnchainReadinessRequired();
  const onchainReady = onchainRequired ? state.voteResolution.onchainWeight > 0n : true;
  const sequencerReady = state.voteResolution.sequencerWeight > 0n;
  const readyToVote = hasVoteReadiness();

  const steps = [];

  if (onchainRequired) {
    steps.push({
      id: 'onchain',
      label: 'Onchain census inclusion',
      description: 'After scanning the Self QR, this step completes when onchain weight is greater than zero.',
    });
  }

  steps.push(
    {
      id: 'sequencer',
      label: 'Sequencer census inclusion',
      description: 'This step completes when sequencer weight is greater than zero.',
    },
    {
      id: 'ready',
      label: 'Ready to vote',
      description: 'Questions unlock and vote can be emitted.',
    }
  );

  const completed = {
    onchain: onchainReady,
    sequencer: sequencerReady,
    ready: readyToVote,
  };
  const currentStepId = steps.find((step) => !completed[step.id])?.id || 'ready';

  steps.forEach((step, index) => {
    const row = document.createElement('li');
    row.className = 'vote-status-item';

    const isComplete = Boolean(completed[step.id]);
    const isCurrent = !isComplete && step.id === currentStepId;

    if (isComplete) {
      row.classList.add('is-complete');
    } else if (isCurrent) {
      row.classList.add('is-current');
    }

    const marker = document.createElement('span');
    marker.className = 'vote-status-marker';
    marker.setAttribute('aria-hidden', 'true');

    if (isCurrent) {
      const spinner = document.createElement('span');
      spinner.className = 'timeline-spinner';
      marker.append(spinner);
    } else if (isComplete) {
      marker.textContent = '✓';
    } else {
      marker.textContent = String(index + 1);
    }

    const content = document.createElement('div');
    content.className = 'vote-status-content';

    const label = document.createElement('p');
    label.className = 'vote-status-label';
    label.textContent = step.label;
    content.append(label);

    const description = document.createElement('p');
    description.className = 'vote-status-description';
    description.textContent = step.description;
    content.append(description);

    row.append(marker, content);
    registrationStatusTimelineEl.append(row);
  });

  if (!registrationHintEl) return;
  const pollSeconds = Math.max(1, Math.round(VOTE_POLL_MS / 1000));
  const diagnostics = [];

  if (onchainRequired) {
    diagnostics.push(`Onchain weight: ${state.voteResolution.onchainWeight.toString()}.`);
  } else if (state.voteResolution.onchainLookupFailed) {
    diagnostics.push('Onchain check unavailable (RPC fallback active).');
  } else {
    diagnostics.push('Onchain check not required for this process.');
  }
  diagnostics.push(`Sequencer weight: ${state.voteResolution.sequencerWeight.toString()}.`);

  const checkTime = formatReadinessCheckTime(state.voteResolution.readinessCheckedAt);
  if (checkTime) diagnostics.push(`Last check: ${checkTime}.`);
  diagnostics.push(`Auto-check every ${pollSeconds}s.`);

  let summary = 'Resolve process and load managed wallet to start registration.';
  if (hasContextReady && !qrReady) {
    summary = state.voteSelf.generating
      ? 'Generating QR for Self...'
      : 'Scan the QR in Self after completing ID or passport verification to start registration.';
  } else if (hasContextReady && onchainRequired && !onchainReady) {
    summary = 'Waiting for onchain census inclusion.';
  } else if (hasContextReady && onchainReady && !sequencerReady) {
    summary = 'Waiting for sequencer census inclusion.';
  } else if (readyToVote) {
    summary = 'Registration complete. You can now select options and emit your vote.';
  }

  registrationHintEl.textContent = `${summary} ${diagnostics.join(' ')}`.trim();
}

function clearVoteBallot(message) {
  if (!message) return;

  state.voteBallot.questions = [];
  state.voteBallot.choices = [];
  state.voteBallot.loading = false;
  state.voteBallot.submitting = false;
  state.voteBallot.hasVoted = false;
  state.voteBallot.submissionId = '';
  state.voteBallot.submissionStatus = '';
  state.voteBallot.statusWatcherToken += 1;

  if (voteQuestionsEl) {
    voteQuestionsEl.innerHTML = '';
  }
  if (voteStatusFlowVoteIdEl) {
    voteStatusFlowVoteIdEl.textContent = '-';
  }
  renderVoteStatusTimeline();
  setVoteStatus(message);
  updateVoteBallotControls();
}

function hasVoteReadiness() {
  const sequencerReady = state.voteResolution.sequencerWeight > 0n;
  if (!sequencerReady) return false;

  if (!isOnchainReadinessRequired()) {
    return true;
  }

  return state.voteResolution.onchainWeight > 0n;
}

function areVoteChoicesEnabled(overwriteAllowed = canOverwriteVote()) {
  return hasVoteReadiness() && !state.voteBallot.submitting && overwriteAllowed;
}

function isOnchainReadinessRequired() {
  const hasRpc = Boolean(String(ACTIVE_NETWORK.rpcUrl || '').trim());
  const hasContract = /^0x[a-fA-F0-9]{40}$/.test(String(state.voteResolution.censusContract || '').trim());
  return hasRpc && hasContract && !state.voteResolution.onchainLookupFailed;
}

function renderVoteQuestions() {
  if (!voteQuestionsEl) return;
  voteQuestionsEl.innerHTML = '';
  const answersEnabled = areVoteChoicesEnabled();

  if (!state.voteBallot.questions.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = state.voteBallot.loading ? 'Loading process questions...' : 'No questions available for this process.';
    voteQuestionsEl.append(empty);
    return;
  }

  state.voteBallot.questions.forEach((question, questionIndex) => {
    const card = document.createElement('fieldset');
    card.className = 'vote-question-card';

    const legend = document.createElement('legend');
    legend.textContent = question.title || `Question ${questionIndex + 1}`;
    card.append(legend);

    if (question.description) {
      const description = document.createElement('p');
      description.className = 'muted';
      description.textContent = question.description;
      card.append(description);
    }

    question.choices.forEach((choice) => {
      const option = document.createElement('label');
      option.className = 'vote-choice';
      const selectedChoice = state.voteBallot.choices[questionIndex];

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `vote-question-${questionIndex}`;
      radio.value = String(choice.value);
      radio.checked = Number.isInteger(selectedChoice) && Number(selectedChoice) === Number(choice.value);
      radio.disabled = !answersEnabled;

      radio.addEventListener('change', () => {
        state.voteBallot.choices[questionIndex] = Number(choice.value);
        updateVoteBallotControls();
      });

      const text = document.createElement('span');
      text.textContent = choice.title;

      option.classList.toggle('is-disabled', radio.disabled);
      option.append(radio, text);
      card.append(option);
    });

    voteQuestionsEl.append(card);
  });
}

function updateVoteBallotControls() {
  const hasProcess = Boolean(state.voteResolution.processId);
  const hasManagedWallet = Boolean(state.voteManaged.wallet?.privateKey);
  const hasQuestions = state.voteBallot.questions.length > 0;
  const overwriteAllowed = canOverwriteVote();
  const hasStoredVote = hasStoredVoteId();
  const terminalStoredVote = hasStoredVote && isVoteStatusTerminal(state.voteBallot.submissionStatus);
  const answersEnabled = areVoteChoicesEnabled(overwriteAllowed);
  const hasAllChoices = hasQuestions && state.voteBallot.questions.every((question, index) => (
    Number.isInteger(state.voteBallot.choices[index])
      && question.choices.some((choice) => Number(choice.value) === Number(state.voteBallot.choices[index]))
  ));
  const canSubmit = hasProcess
    && hasManagedWallet
    && hasVoteReadiness()
    && hasQuestions
    && hasAllChoices
    && !state.voteBallot.submitting
    && overwriteAllowed;

  if (emitVoteBtn) {
    emitVoteBtn.disabled = !canSubmit;
    setButtonLabel(
      emitVoteBtn,
      state.voteBallot.submitting
        ? 'Emitting vote...'
        : (terminalStoredVote ? 'Emit vote again' : (hasStoredVote ? 'Vote in progress' : 'Emit vote')),
      state.voteBallot.submitting ? 'iconoir-refresh' : 'iconoir-check'
    );
  }
  if (voteStatusFlowVoteIdEl) {
    voteStatusFlowVoteIdEl.textContent = state.voteBallot.submissionId || '-';
  }
  if (voteQuestionsEl) {
    voteQuestionsEl.querySelectorAll('.vote-choice input[type="radio"]').forEach((radioEl) => {
      const radio = radioEl;
      radio.disabled = !answersEnabled;
      const option = radio.closest('.vote-choice');
      if (option) {
        option.classList.toggle('is-disabled', radio.disabled);
      }
    });
  }
  renderVoteStatusInfoVisibility();
  renderVoteStatusTimeline();
}

async function loadVoteQuestions(process, metadata = null) {
  clearVoteBallot('Loading process questions...');
  state.voteBallot.loading = true;
  renderVoteQuestions();

  try {
    const metadataQuestions = normalizeVoteQuestions(metadata?.questions);
    const directQuestions = normalizeVoteQuestions(process?.questions);
    const resolvedQuestions = metadataQuestions.length ? metadataQuestions : directQuestions;

    state.voteBallot.questions = resolvedQuestions;
    state.voteBallot.choices = resolvedQuestions.map(() => null);
    state.voteBallot.submissionId = '';
    state.voteBallot.submissionStatus = '';
    state.voteBallot.hasVoted = false;

    renderVoteQuestions();
    if (!resolvedQuestions.length) {
      setVoteStatus('No vote questions were found in this process.', true);
    }
  } catch (error) {
    clearVoteBallot(error instanceof Error ? error.message : 'Failed to load process questions.');
    setVoteStatus(error instanceof Error ? error.message : 'Failed to load process questions.', true);
  } finally {
    state.voteBallot.loading = false;
    renderVoteQuestions();
    updateVoteBallotControls();
  }
}

async function refreshHasVotedFlag() {
  const processId = state.voteResolution.processId;
  const managedAddress = state.voteManaged.wallet?.address;
  const sdk = state.voteResolution.sdk;
  if (!processId || !managedAddress || !sdk) {
    state.voteBallot.hasVoted = false;
    updateVoteBallotControls();
    return;
  }

  try {
    const alreadyVoted = await sdk.hasAddressVoted(processId, managedAddress);
    if (alreadyVoted && canOverwriteVote()) {
      setVoteStatus('This identity wallet already has a vote in sequencer. You can emit again to overwrite it.');
    }
  } catch {
    // Ignore remote voted flag errors.
  }

  state.voteBallot.hasVoted = false;
  updateVoteBallotControls();
}

async function trackVoteSubmissionStatus(sdk, processId, voteId, token, voterAddress = '') {
  if (!sdk || !voteId) return;

  try {
    for await (const info of sdk.watchVoteStatus(processId, voteId, { pollIntervalMs: 5000, timeoutMs: 300000 })) {
      if (token !== state.voteBallot.statusWatcherToken) return;
      state.voteBallot.submissionStatus = String(info?.status || '');
      persistVoteSubmission(processId, voterAddress, {
        voteId,
        status: state.voteBallot.submissionStatus,
      });
      updateVoteBallotControls();

      const statusLabel = formatVoteStatusLabel(info?.status);
      setVoteStatus(`Vote submitted. Current status: ${statusLabel}.`);

      const normalized = String(info?.status || '').toLowerCase();
      if (normalized === 'settled' || normalized === 'error') {
        return;
      }
    }
  } catch {
    // Ignore status watcher errors; latest status remains visible.
  }
}

async function emitVote() {
  if (state.voteBallot.submitting) return;

  const processId = state.voteResolution.processId;
  const wallet = state.voteManaged.wallet;
  const choices = state.voteBallot.choices.map((value) => Number(value));

  if (!processId || !wallet?.privateKey) {
    setVoteStatus('Resolve process and managed wallet before emitting vote.', true);
    return;
  }
  if (!state.voteBallot.questions.length) {
    setVoteStatus('No questions available for this process.', true);
    return;
  }
  if (!hasVoteReadiness()) {
    const message = isOnchainReadinessRequired()
      ? 'Wait until Onchain and Sequencer readiness are both Yes.'
      : 'Wait until Sequencer readiness is Yes.';
    setVoteStatus(message, true);
    return;
  }
  if (!canOverwriteVote()) {
    setVoteStatus('Current vote is still processing. Wait until status becomes Settled or Error before overwriting.', true);
    return;
  }

  const censusUrl = trimTrailingSlash(CONFIG.davinciCensusUrl || CONFIG.onchainIndexerUrl);
  if (!censusUrl) {
    setVoteStatus('Missing census URL config for vote proof generation.', true);
    return;
  }

  try {
    state.voteBallot.submitting = true;
    updateVoteBallotControls();
    setVoteStatus('Emitting vote...');

    const sdk = new DavinciSDK({
      signer: new Wallet(wallet.privateKey),
      sequencerUrl: CONFIG.davinciSequencerUrl,
      censusUrl,
    });
    await sdk.init();

    const result = await sdk.submitVote({ processId, choices });
    state.voteBallot.submissionId = String(result?.voteId || '');
    state.voteBallot.submissionStatus = String(result?.status || 'pending');
    state.voteBallot.hasVoted = true;
    persistVoteSubmission(processId, wallet.address, {
      voteId: state.voteBallot.submissionId,
      status: state.voteBallot.submissionStatus,
    });
    setVoteStatus('Vote emitted successfully.');

    const watcherToken = state.voteBallot.statusWatcherToken + 1;
    state.voteBallot.statusWatcherToken = watcherToken;
    trackVoteSubmissionStatus(sdk, processId, state.voteBallot.submissionId, watcherToken, wallet.address);
  } catch (error) {
    state.voteBallot.hasVoted = false;
    if (state.voteBallot.submissionId) {
      state.voteBallot.submissionStatus = 'error';
      persistVoteSubmission(processId, wallet?.address, {
        voteId: state.voteBallot.submissionId,
        status: state.voteBallot.submissionStatus,
      });
    }
    const message = error instanceof Error ? error.message : 'Failed to emit vote.';
    setVoteStatus(message, true);
  } finally {
    state.voteBallot.submitting = false;
    updateVoteBallotControls();
  }
}

async function fetchVoteSelfMinAge(contractAddress) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || ''))) return null;

  const data = CENSUS_INTERFACE.encodeFunctionData('minAge', []);
  const raw = await ethCall(contractAddress, data);
  const [result] = CENSUS_INTERFACE.decodeFunctionResult('minAge', raw);
  const parsed = Number(result);

  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

async function refreshVoteSelfContractData(contractAddress) {
  try {
    const minAge = await fetchVoteSelfMinAge(contractAddress);
    if (minAge) {
      state.voteSelf.minAge = minAge;
      updateVoteSelfControls();
    }
  } catch {
    // Ignore contract metadata lookup failures.
  }
}

function hydrateVoteSelfScope(processId, contractAddress) {
  const meta = loadProcessMeta(processId);
  const metaScope = normalizeScope(meta?.scopeSeed || '');
  const storedScope = loadVoteScopeSeed(processId);
  const contractMatches = !contractAddress
    || !meta?.contractAddress
    || String(meta.contractAddress).toLowerCase() === String(contractAddress).toLowerCase();
  const scopeSeed = normalizeScope(storedScope || (contractMatches ? metaScope : ''));

  state.voteSelf.scopeSeed = scopeSeed;
  const metaCountry = normalizeCountry(meta?.country || '');
  state.voteSelf.country = /^[A-Z]{2,3}$/.test(metaCountry) ? metaCountry : state.voteSelf.country;

  const metaMinAge = Number(meta?.minAge);
  const resolvedMetaMinAge = contractMatches && Number.isFinite(metaMinAge) && metaMinAge > 0 ? Math.trunc(metaMinAge) : null;
  state.voteSelf.minAge = resolvedMetaMinAge || state.voteSelf.minAge;
  if (meta?.network && NETWORKS[meta.network]) {
    state.voteResolution.network = meta.network;
  }
  clearVoteSelfArtifacts();
  updateVoteSelfControls();
}

async function generateVoteSelfQr() {
  if (state.voteSelf.generating) return;

  const processId = state.voteResolution.processId;
  const contractAddress = state.voteResolution.censusContract;
  const managedAddress = state.voteManaged.wallet?.address;
  const scopeSeed = normalizeScope(state.voteSelf.scopeSeed || '');
  if (!processId || !contractAddress || !managedAddress) {
    setVoteSelfStatus('Resolve process and managed wallet before generating Self QR.', true);
    return;
  }
  if (!scopeSeed) {
    setVoteSelfStatus('Scope seed is required to generate Self QR.', true);
    return;
  }
  if (!/^[\x00-\x7F]+$/.test(scopeSeed) || scopeSeed.length > 31) {
    setVoteSelfStatus('Scope seed must be ASCII and up to 31 characters.', true);
    return;
  }

  persistVoteScopeSeed(processId, scopeSeed);
  state.voteSelf.scopeSeed = scopeSeed;

  try {
    state.voteSelf.generating = true;
    setButtonLabel(generateVoteSelfQrBtn, 'Regenerating...', 'iconoir-refresh');
    updateVoteSelfControls();
    setVoteSelfStatus('Generating Self QR...');

    if (!state.voteSelf.minAge) {
      state.voteSelf.minAge = await fetchVoteSelfMinAge(contractAddress);
    }

    const disclosures = {
      minimumAge: state.voteSelf.minAge || 18,
      nationality: true,
    };

    const selfApp = buildSelfApp({
      appName: CONFIG.selfAppName || 'Open Citizen Census',
      scope: scopeSeed,
      endpoint: String(contractAddress).toLowerCase(),
      endpointType: toSelfEndpointType(),
      userId: managedAddress,
      userIdType: 'hex',
      disclosures,
      userDefinedData: '',
      deeplinkCallback: undefined,
    });

    const universalLink = getUniversalLink(selfApp);
    const qrDataUrl = await QRCode.toDataURL(universalLink, { width: 320, margin: 1 });

    state.voteSelf.link = universalLink;
    if (voteSelfQrImageEl) voteSelfQrImageEl.src = qrDataUrl;
    if (voteSelfQrWrapEl) voteSelfQrWrapEl.hidden = false;

    updateVoteSelfControls();
    setVoteSelfStatus('QR ready. Scan it in the Self app to register this wallet.');
    setVoteStatus('Self QR ready. Complete verification in Self and wait for readiness to turn Yes.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate Self QR.';
    setVoteSelfStatus(message, true);
    setVoteStatus(message, true);
  } finally {
    state.voteSelf.generating = false;
    setButtonLabel(generateVoteSelfQrBtn, 'Regenerate QR', 'iconoir-refresh');
    updateVoteSelfControls();
  }
}

async function copyVoteSelfLink() {
  if (!state.voteSelf.link) return;
  try {
    await navigator.clipboard.writeText(state.voteSelf.link);
    setVoteSelfStatus('Self link copied to clipboard.');
  } catch {
    setVoteSelfStatus('Failed to copy Self link.', true);
  }
}

function openVoteSelfLink() {
  if (!state.voteSelf.link) return;
  window.open(state.voteSelf.link, '_blank', 'noopener,noreferrer');
}

function bootstrapVoteManagedWallet(processId) {
  const normalizedProcessId = normalizeProcessId(processId);
  if (!normalizedProcessId) {
    state.voteManaged.wallet = null;
    state.voteManaged.privateVisible = false;
    renderManagedWallet();
    return;
  }

  state.voteManaged.wallet = loadManagedWallet(normalizedProcessId);
  state.voteManaged.privateVisible = false;
  state.voteBallot.submissionId = '';
  state.voteBallot.submissionStatus = '';
  state.voteBallot.hasVoted = false;
  state.voteBallot.statusWatcherToken += 1;
  restoreVoteSubmissionFromStorage(normalizedProcessId);
  renderManagedWallet();
}

function resetVoteResolution() {
  state.voteResolution = {
    sdk: null,
    process: null,
    processId: '',
    network: CONFIG.network,
    title: '',
    description: '',
    censusContract: '',
    censusUri: '',
    endDateMs: null,
    onchainWeight: 0n,
    sequencerWeight: 0n,
    onchainLookupFailed: false,
    readinessCheckedAt: null,
  };
  state.voteSelf.scopeSeed = '';
  state.voteSelf.minAge = null;
  state.voteSelf.country = '';
  state.voteSelf.generating = false;
  state.voteSelf.autoTriggerKey = '';
  state.voteSelf.autoCollapsedForEligibility = false;
  setVoteProcessDetails({
    processId: '',
    title: '',
    description: '',
    censusContract: '',
    censusUri: '',
    sequencerUrl: CONFIG.davinciSequencerUrl || '',
    endDateMs: null,
  });

  clearVoteSelfArtifacts();
  clearVoteBallot();
  if (generateVoteSelfQrBtn) setButtonLabel(generateVoteSelfQrBtn, 'Regenerate QR', 'iconoir-refresh');
  if (voteSelfCardEl) voteSelfCardEl.open = true;
  setVoteSelfStatus('Resolve process and managed wallet before generating Self QR.');
  updateVoteSelfCardVisibility();
  updateVoteSelfControls();
}

function renderVoteReadiness() {
  refreshVoteRemainingTimeDisplay();
  updateVoteSelfCardVisibility();
  updateVoteBallotControls();
  renderRegistrationStatusTimeline();
}

function extractCensusContract(process) {
  const candidates = [
    process?.censusContract,
    process?.census?.contractAddress,
    process?.census?.address,
    process?.censusAddress,
    process?.metadata?.censusContract,
    process?.metadata?.censusContractAddress,
  ].map((value) => String(value || '').trim());

  return candidates.find((value) => /^0x[a-fA-F0-9]{40}$/.test(value)) || '';
}

function extractCensusUri(process, contractAddress) {
  const candidates = [
    process?.censusUri,
    process?.census?.uri,
    process?.census?.censusUri,
    process?.metadata?.censusUri,
  ].map((value) => String(value || '').trim());

  const existing = candidates.find((value) => /^https?:\/\//i.test(value) || /^graphql:\/\//i.test(value));
  if (existing) return existing;
  if (contractAddress) return buildCensusUri(contractAddress);
  return '';
}

function toDateFromUnknown(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) return null;
    const abs = Math.abs(asNumber);
    const ms = abs >= 100_000_000_000_000_000
      ? asNumber / 1_000_000 // nanoseconds
      : abs >= 100_000_000_000_000
        ? asNumber / 1_000 // microseconds
        : abs >= 100_000_000_000
          ? asNumber // milliseconds
          : asNumber * 1000; // seconds
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    const ms = abs >= 100_000_000_000_000_000
      ? value / 1_000_000 // nanoseconds
      : abs >= 100_000_000_000_000
        ? value / 1_000 // microseconds
        : abs >= 100_000_000_000
          ? value // milliseconds
          : value * 1000; // seconds
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return null;
      const abs = Math.abs(parsed);
      const ms = abs >= 100_000_000_000_000_000
        ? parsed / 1_000_000 // nanoseconds
        : abs >= 100_000_000_000_000
          ? parsed / 1_000 // microseconds
          : abs >= 100_000_000_000
            ? parsed // milliseconds
            : parsed * 1000; // seconds
      const numericDate = new Date(ms);
      if (!Number.isNaN(numericDate.getTime())) return numericDate;
    }
    const parsedDate = new Date(trimmed);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  return null;
}

function toDurationMs(value) {
  if (value === null || value === undefined || value === '') return null;

  let parsed = null;
  if (typeof value === 'bigint') {
    parsed = Number(value);
  } else if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    parsed = Number(value.trim());
  }

  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed >= 10_000_000_000_000) return parsed / 1_000_000; // nanoseconds
  if (parsed >= 10_000_000_000) return parsed / 1_000; // microseconds
  if (parsed >= 10_000_000) return parsed; // milliseconds
  return parsed * 1000; // seconds
}

function extractProcessDescription(process, metadata) {
  const candidates = [
    getLocalizedText(metadata?.description),
    getLocalizedText(process?.description),
    getLocalizedText(process?.metadata?.description),
  ];
  return String(candidates.find((value) => String(value || '').trim()) || '').trim();
}

function extractProcessEndDateMs(process, metadata) {
  const endCandidates = [
    process?.timing?.endDate,
    process?.timing?.endTime,
    process?.timing?.endsAt,
    process?.endDate,
    process?.endTime,
    process?.endsAt,
    metadata?.timing?.endDate,
    metadata?.timing?.endTime,
    metadata?.timing?.endsAt,
    metadata?.endDate,
    metadata?.endTime,
    metadata?.endsAt,
  ];

  for (const candidate of endCandidates) {
    const parsed = toDateFromUnknown(candidate);
    if (parsed) return parsed.getTime();
  }

  const startCandidates = [
    process?.timing?.startDate,
    process?.timing?.startTime,
    process?.timing?.startsAt,
    process?.startDate,
    process?.startTime,
    process?.startsAt,
    metadata?.timing?.startDate,
    metadata?.timing?.startTime,
    metadata?.timing?.startsAt,
    metadata?.startDate,
    metadata?.startTime,
    metadata?.startsAt,
  ];
  const durationCandidates = [
    process?.timing?.duration,
    process?.timing?.durationSeconds,
    process?.timing?.durationMs,
    process?.duration,
    process?.durationSeconds,
    process?.durationMs,
    metadata?.timing?.duration,
    metadata?.timing?.durationSeconds,
    metadata?.timing?.durationMs,
    metadata?.duration,
    metadata?.durationSeconds,
    metadata?.durationMs,
  ];

  for (const startCandidate of startCandidates) {
    const startDate = toDateFromUnknown(startCandidate);
    if (!startDate) continue;
    for (const durationCandidate of durationCandidates) {
      const durationMs = toDurationMs(durationCandidate);
      if (!durationMs) continue;
      return startDate.getTime() + durationMs;
    }
  }

  return null;
}

async function fetchProcessMetadata(sdk, process) {
  const metadataUri = String(process?.metadataURI || process?.metadataUri || '').trim();
  if (!metadataUri || !sdk?.api?.sequencer?.getMetadata) return null;

  try {
    const metadata = await sdk.api.sequencer.getMetadata(metadataUri);
    return metadata && typeof metadata === 'object' ? metadata : null;
  } catch {
    return null;
  }
}

function applyVoteContextPayload(processId, contextPayload) {
  const normalizedProcessId = normalizeProcessId(processId);
  const payload = sanitizeVoteEnvPayload(contextPayload);
  if (!normalizedProcessId || !payload) return;

  const scope = normalizeScope(payload.scope || '');
  if (scope) {
    state.voteSelf.scopeSeed = scope;
    persistVoteScopeSeed(normalizedProcessId, scope);
  }

  if (payload.minAge) {
    state.voteSelf.minAge = payload.minAge;
  }
  if (payload.country && /^[A-Z]{2,3}$/.test(payload.country)) {
    state.voteSelf.country = payload.country;
  }
  if (payload.network && NETWORKS[payload.network]) {
    state.voteResolution.network = payload.network;
  }

  const hintedTitle = String(payload.title || '').trim();
  const hintedContract = String(payload.contractAddress || '').trim();
  const hintedUri = String(payload.censusUri || '').trim();
  const hintedSequencer = String(payload.sequencerUrl || '').trim() || CONFIG.davinciSequencerUrl;

  if (hintedTitle) state.voteResolution.title = hintedTitle;
  if (hintedContract) state.voteResolution.censusContract = hintedContract;
  if (hintedUri) state.voteResolution.censusUri = hintedUri;
  if (hintedTitle || hintedContract || hintedUri) {
    state.voteResolution.processId = normalizedProcessId;
    setVoteProcessDetails({
      processId: normalizedProcessId,
      title: state.voteResolution.title,
      description: state.voteResolution.description,
      censusContract: state.voteResolution.censusContract,
      censusUri: state.voteResolution.censusUri,
      sequencerUrl: hintedSequencer,
      endDateMs: state.voteResolution.endDateMs,
    });
  }

  if (scope || payload.minAge || payload.country || hintedTitle || hintedContract || hintedUri) {
    const existing = loadProcessMeta(normalizedProcessId) || {};
    persistProcessMeta(normalizedProcessId, {
      ...existing,
      title: hintedTitle || existing.title || '',
      contractAddress: hintedContract || existing.contractAddress || '',
      censusUri: hintedUri || existing.censusUri || '',
      scopeSeed: scope || existing.scopeSeed || '',
      minAge: payload.minAge || existing.minAge || null,
      country: payload.country || existing.country || '',
      network: state.voteResolution.network || existing.network || CONFIG.network,
      updatedAt: new Date().toISOString(),
    });
  }

  updateVoteSelfControls();
}

async function resolveVoteProcess(processId, silent = true, contextPayload = null) {
  const normalizedProcessId = normalizeProcessId(processId);
  if (!normalizedProcessId) {
    resetVoteResolution();
    setVoteStatus('Enter a process ID to resolve it.');
    return;
  }

  stopVotePolling();
  bootstrapVoteManagedWallet(normalizedProcessId);
  if (String(state.voteResolution.processId || '').toLowerCase() !== normalizedProcessId.toLowerCase()) {
    clearVoteSelfArtifacts();
  }
  state.voteResolution.sdk = null;
  state.voteResolution.process = null;
  state.voteResolution.processId = normalizedProcessId;
  state.voteResolution.network = CONFIG.network;
  state.voteResolution.title = '';
  state.voteResolution.description = '';
  state.voteResolution.censusContract = '';
  state.voteResolution.censusUri = '';
  state.voteResolution.endDateMs = null;
  state.voteResolution.onchainWeight = 0n;
  state.voteResolution.sequencerWeight = 0n;
  state.voteResolution.onchainLookupFailed = false;
  state.voteResolution.readinessCheckedAt = null;
  state.voteSelf.country = '';
  state.voteSelf.autoCollapsedForEligibility = false;
  clearVoteBallot('Resolving process...');
  setVoteProcessDetails({
    processId: normalizedProcessId,
    title: '',
    description: '',
    censusContract: '',
    censusUri: '',
    sequencerUrl: CONFIG.davinciSequencerUrl || '',
    endDateMs: null,
  });
  renderVoteReadiness();

  applyVoteContextPayload(normalizedProcessId, contextPayload);
  maybeAutoGenerateVoteSelfQr();

  try {
    if (!silent) setVoteStatus('Resolving process from sequencer...');

    const sdk = new DavinciSDK({ sequencerUrl: CONFIG.davinciSequencerUrl });
    await sdk.init();
    const process = await getProcessFromSequencer(sdk, normalizedProcessId);
    const metadata = await fetchProcessMetadata(sdk, process);

    const contractAddress = extractCensusContract(process);
    const censusUri = extractCensusUri(process, contractAddress);
    const title = String(
      getLocalizedText(metadata?.title)
      || process?.title
      || process?.metadata?.title
      || process?.metadata?.name
      || '-'
    ).trim();
    const description = extractProcessDescription(process, metadata);
    const endDateMs = extractProcessEndDateMs(process, metadata);

    state.voteResolution.sdk = sdk;
    state.voteResolution.process = process;
    state.voteResolution.processId = normalizedProcessId;
    state.voteResolution.title = title;
    state.voteResolution.description = description;
    state.voteResolution.censusContract = contractAddress;
    state.voteResolution.censusUri = censusUri;
    state.voteResolution.endDateMs = endDateMs;

    setVoteProcessDetails({
      processId: normalizedProcessId,
      title,
      description,
      censusContract: contractAddress,
      censusUri,
      sequencerUrl: CONFIG.davinciSequencerUrl || '',
      endDateMs,
    });

    hydrateVoteSelfScope(normalizedProcessId, contractAddress);
    refreshVoteSelfContractData(contractAddress);
    await loadVoteQuestions(process, metadata);
    const restoredVoteId = restoreVoteSubmissionFromStorage(normalizedProcessId);
    if (restoredVoteId) {
      const normalizedStatus = normalizeVoteStatus(state.voteBallot.submissionStatus);
      const shouldWatch = normalizedStatus && normalizedStatus !== 'settled' && normalizedStatus !== 'error';
      if (shouldWatch) {
        const watcherToken = state.voteBallot.statusWatcherToken + 1;
        state.voteBallot.statusWatcherToken = watcherToken;
        trackVoteSubmissionStatus(sdk, normalizedProcessId, state.voteBallot.submissionId, watcherToken, state.voteManaged.wallet?.address || '');
      }
    }
    await refreshVoteReadiness();
    await refreshHasVotedFlag();
    startVotePolling();
    maybeAutoGenerateVoteSelfQr();

    if (!silent) {
      setVoteStatus('Process resolved. Readiness checks are active.');
    }
  } catch (error) {
    resetVoteResolution();
    setVoteStatus(error instanceof Error ? error.message : 'Failed to resolve process.', true);
  }
}

function encodeWeightOf(address) {
  const normalized = String(address || '').toLowerCase().replace(/^0x/, '');
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error('Invalid address format for weightOf query.');
  }
  return WEIGHT_OF_SELECTOR + normalized.padStart(64, '0');
}

async function ethCall(to, data) {
  if (!ACTIVE_NETWORK.rpcUrl) {
    throw new Error('RPC unavailable for active network.');
  }

  const response = await fetch(ACTIVE_NETWORK.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || 'eth_call failed');
  }
  return json.result;
}

async function fetchOnchainWeight(contractAddress, address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
    return 0n;
  }

  const result = await ethCall(contractAddress, encodeWeightOf(address));
  return BigInt(result || '0x0');
}

async function fetchSequencerWeight(processId, address) {
  if (!state.voteResolution.sdk) return 0n;
  const sdk = state.voteResolution.sdk;
  const api = sdk.api?.sequencer;

  const callCandidates = [
    () => sdk.getAddressWeight?.(normalizeProcessId(processId), address),
    () => sdk.getAddressWeight?.(normalizeProcessId(processId).replace(/^0x/, ''), address),
    () => api?.getAddressWeight?.(normalizeProcessId(processId), address),
    () => api?.getAddressWeight?.(normalizeProcessId(processId).replace(/^0x/, ''), address),
    () => api?.getProcessAddressWeight?.(normalizeProcessId(processId), address),
  ];

  for (const call of callCandidates) {
    try {
      const value = await call();
      if (value === undefined || value === null) continue;
      if (typeof value === 'object' && value.weight !== undefined) return BigInt(value.weight);
      return BigInt(value);
    } catch {
      // Continue trying candidate methods.
    }
  }

  return 0n;
}

async function refreshVoteReadiness() {
  const processId = state.voteResolution.processId;
  const contractAddress = state.voteResolution.censusContract;
  const managedAddress = state.voteManaged.wallet?.address;

  if (!processId || !managedAddress) {
    state.voteResolution.readinessCheckedAt = null;
    renderVoteReadiness();
    return;
  }

  try {
    if (String(ACTIVE_NETWORK.rpcUrl || '').trim() && /^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || '').trim())) {
      state.voteResolution.onchainWeight = await fetchOnchainWeight(contractAddress, managedAddress);
      state.voteResolution.onchainLookupFailed = false;
    } else {
      state.voteResolution.onchainWeight = 0n;
      state.voteResolution.onchainLookupFailed = false;
    }
  } catch {
    state.voteResolution.onchainWeight = 0n;
    state.voteResolution.onchainLookupFailed = true;
  }

  try {
    state.voteResolution.sequencerWeight = await fetchSequencerWeight(processId, managedAddress);
  } catch {
    state.voteResolution.sequencerWeight = 0n;
  }
  state.voteResolution.readinessCheckedAt = Date.now();

  renderVoteReadiness();
}

function stopVotePolling() {
  if (state.votePollId) {
    clearInterval(state.votePollId);
    state.votePollId = null;
  }
}

function startVotePolling() {
  stopVotePolling();
  if (!state.voteResolution.processId) return;
  state.votePollId = setInterval(() => {
    refreshVoteReadiness();
  }, VOTE_POLL_MS);
}

function initVoteActions() {
  voteProcessIdInput.addEventListener('keydown', (event) => {
    if (document.body.classList.contains('app-blocked')) {
      setVoteStatus(getVoteContextRequiredMessage(), true);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const processId = normalizeProcessId(voteProcessIdInput.value);
    if (!processId) {
      setVoteStatus('Process ID is required.', true);
      return;
    }
    const context = buildVoteLinkPayload(processId, { processId });
    navigate(context ? `/vote/${encodeURIComponent(context)}` : '/vote');
  });

  if (showVoteDetailsBtn) {
    showVoteDetailsBtn.addEventListener('click', openVoteDetailsDialog);
  }
  if (closeVoteDetailsBtn) {
    closeVoteDetailsBtn.addEventListener('click', closeVoteDetailsDialog);
  }
  if (voteDetailsDialog) {
    voteDetailsDialog.addEventListener('click', (event) => {
      if (event.target === voteDetailsDialog) {
        closeVoteDetailsDialog();
      }
    });
  }

  if (generateVoteSelfQrBtn) {
    generateVoteSelfQrBtn.addEventListener('click', generateVoteSelfQr);
  }
  if (copyVoteSelfLinkBtn) {
    copyVoteSelfLinkBtn.addEventListener('click', copyVoteSelfLink);
  }
  if (openVoteSelfLinkBtn) {
    openVoteSelfLinkBtn.addEventListener('click', openVoteSelfLink);
  }
  if (emitVoteBtn) {
    emitVoteBtn.addEventListener('click', emitVote);
  }

  revealKeyBtn.addEventListener('click', () => {
    if (!state.voteManaged.wallet) return;

    if (!state.voteManaged.privateVisible) {
      const confirmed = window.confirm('Revealing this key exposes signing authority. Continue?');
      if (!confirmed) return;
    }

    state.voteManaged.privateVisible = !state.voteManaged.privateVisible;
    renderManagedWallet();
  });

  copyKeyBtn.addEventListener('click', async () => {
    if (!state.voteManaged.wallet || !state.voteManaged.privateVisible) return;

    try {
      await navigator.clipboard.writeText(state.voteManaged.wallet.privateKey);
      setVoteStatus('Private key copied to clipboard.');
    } catch {
      setVoteStatus('Failed to copy private key.', true);
    }
  });

  importKeyBtn.addEventListener('click', () => {
    const processId = state.route.processId;
    if (!processId) {
      setVoteStatus('Open /vote/:context before importing a key.', true);
      return;
    }

    let normalizedKey = '';
    try {
      normalizedKey = normalizePrivateKey(importKeyInput.value);
      // eslint-disable-next-line no-new
      new Wallet(normalizedKey);
    } catch (error) {
      setVoteStatus(error instanceof Error ? error.message : 'Invalid private key.', true);
      return;
    }

    const confirmed = window.confirm('Importing this key will replace the derived key for this process. Continue?');
    if (!confirmed) return;

    setWalletOverride(processId, normalizedKey);
    importKeyInput.value = '';
    bootstrapVoteManagedWallet(processId);
    refreshVoteReadiness();
    refreshHasVotedFlag();
    setVoteStatus('Imported key applied for this process.');
  });

  clearImportedKeyBtn.addEventListener('click', () => {
    const processId = state.route.processId;
    if (!processId) {
      setVoteStatus('Open /vote/:context before resetting key.', true);
      return;
    }

    clearWalletOverride(processId);
    bootstrapVoteManagedWallet(processId);
    refreshVoteReadiness();
    refreshHasVotedFlag();
    setVoteStatus('Derived key restored for this process.');
  });
}

function initWizardActions() {
  stepIndicators.forEach((indicator) => {
    indicator.addEventListener('click', () => {
      const targetStep = Number(indicator.dataset.stepIndicator || '1');
      if (targetStep < state.createStep) {
        showStep(targetStep);
      }
    });
  });

  stepBackBtn.addEventListener('click', () => {
    if (state.createStep > 1) showStep(state.createStep - 1);
  });

  stepNextBtn.addEventListener('click', () => {
    try {
      validateCurrentStep();
      showStep(state.createStep + 1);
      setCreateStatus('');
    } catch (error) {
      setCreateStatus(error instanceof Error ? error.message : 'Step validation failed.', true);
    }
  });

  connectCreatorWalletBtn.addEventListener('click', handleCreatorWalletButton);
}

function initQuestionActions() {
  initQuestions();
}

function validateBootConfig() {
  const missing = [];
  if (!CONFIG.walletConnectProjectId && !getInjectedProvider()) {
    missing.push('VITE_WALLETCONNECT_PROJECT_ID (needed when no browser extension wallet is detected)');
  }
  if (!CONFIG.onchainIndexerUrl) missing.push('VITE_ONCHAIN_CENSUS_INDEXER_URL');
  if (!CONFIG.davinciSequencerUrl) missing.push('VITE_DAVINCI_SEQUENCER_URL');

  if (missing.length) {
    setCreateStatus(`Missing env vars: ${missing.join(', ')}`, true);
  } else {
    setCreateStatus('Environment looks good. Connect wallet to unlock the create form.');
  }
}

function initNavigation() {
  window.addEventListener('popstate', () => {
    applyRoute(parseRoute());
  });
}

function init() {
  ensureCreateDefaults();
  resetPipeline();
  resetOutputs();
  applyStaticButtonIcons();
  resetVoteResolution();
  renderManagedWallet();
  initWizardActions();
  initQuestionActions();
  initVoteActions();
  initNavigation();
  sanitizeCreateFormAsciiInputs();
  if (copyVoteUrlBtn) {
    copyVoteUrlBtn.addEventListener('click', copyVoteUrlToClipboard);
  }
  showStep(1);

  createForm.addEventListener('submit', handleCreateSubmit);
  createForm.addEventListener('input', () => {
    sanitizeCreateFormAsciiInputs();
    state.createFormDirty = true;
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.createFormDirty || state.createSubmitting) return;
    event.preventDefault();
    event.returnValue = '';
  });

  validateBootConfig();
  renderWalletButtons();
  applyRoute(parseRoute());
  renderCreateAuxiliaryPanels();
}

init();
