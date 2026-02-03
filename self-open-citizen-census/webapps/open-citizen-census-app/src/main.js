import QRCode from 'qrcode';
import { io } from 'socket.io-client';
import { DavinciSDK, OnchainCensus } from '@vocdoni/davinci-sdk';
import { BrowserProvider } from 'ethers';

import './style.css';
import { buildSelfApp, getQrLink, getUniversalLink, WS_DB_RELAYER } from './selfApp.js';

const env = import.meta.env;
const CONFIG = {
  appName: env.VITE_APP_NAME ?? 'Open Citizen Census',
  endpoint: env.VITE_CONTRACT_ADDRESS ?? '',
  scope: env.VITE_SCOPE ?? '',
  endpointType: env.VITE_NETWORK ?? 'celo',
  minAge: env.VITE_MIN_AGE ? Number(env.VITE_MIN_AGE) : 18,
  nationality: env.VITE_NATIONALITY ?? '',
  websocketUrl: env.VITE_SELF_WEBSOCKET ?? WS_DB_RELAYER,
  userData: env.VITE_SELF_USER_DATA ?? '',
  deeplinkCallback: env.VITE_SELF_DEEPLINK_CALLBACK ?? '',
  ofacEnabled: env.VITE_SELF_OFAC_ENABLED ?? '',
  forbiddenCountries: env.VITE_SELF_FORBIDDEN_COUNTRIES ?? '',
  onchainIndexerUrl: env.VITE_ONCHAIN_CENSUS_INDEXER_URL ?? '',
  davinciSequencerUrl: env.VITE_DAVINCI_SEQUENCER_URL ?? '',
  davinciAppUrl: env.VITE_DAVINCI_APP_URL ?? '',
};

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

function applyConfigOverridesFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('env');
  if (!encoded) return;

  const override = decodeBase64UrlJson(encoded);
  if (!override || typeof override !== 'object') return;

  const contract = String(override.contractAddress ?? override.contract ?? '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    CONFIG.endpoint = contract;
  }

  const scope = String(override.scope ?? '').trim();
  if (scope && scope.length <= 31) {
    CONFIG.scope = scope;
  }

  const minAge = Number(override.minAge);
  if (Number.isFinite(minAge) && minAge > 0 && minAge <= 99) {
    CONFIG.minAge = Math.trunc(minAge);
  }

  const nationality = String(override.nationality ?? '').trim().toUpperCase();
  if (/^[A-Z]{2,3}$/.test(nationality)) {
    CONFIG.nationality = nationality;
  }

  const network = String(override.network ?? '').trim();
  if (network === 'celo' || network === 'staging_celo') {
    CONFIG.endpointType = network;
  }
}

applyConfigOverridesFromUrl();

const configApp = document.getElementById('configApp');
const configContract = document.getElementById('configContract');
const configScope = document.getElementById('configScope');
const configNetwork = document.getElementById('configNetwork');
const configMinAge = document.getElementById('configMinAge');
const configNationality = document.getElementById('configNationality');
const highlightMinAgeEls = document.querySelectorAll('[data-highlight="minAge"]');
const highlightNationalityEls = document.querySelectorAll('[data-highlight="nationality"]');
const userAddressInput = document.getElementById('userAddress');
const qrImg = document.getElementById('qr');
const linkOutput = document.getElementById('link');
const statusEl = document.getElementById('status');
const connectNoticeEl = document.getElementById('connectNotice');
const connectWalletButton = document.getElementById('connectWallet');
const generateButton = document.getElementById('generate');
const copyLinkButton = document.getElementById('copyLink');
const connectPanel = document.getElementById('connectPanel');
const qrPanel = document.getElementById('qrPanel');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const signatureBadge = document.getElementById('signatureBadge');
const registrationBadge = document.getElementById('registrationBadge');
const viewHome = document.getElementById('view-home');
const viewRegistration = document.getElementById('view-registration');
const viewProcess = document.getElementById('view-process');
const processContract = document.getElementById('processContract');
const processCensusUri = document.getElementById('processCensusUri');
const processSequencerUrl = document.getElementById('processSequencerUrl');
const processAppUrl = document.getElementById('processAppUrl');
const processProgress = document.getElementById('processProgress');
const processProgressFill = document.getElementById('processProgressFill');
const processConnectPanel = document.getElementById('processConnectPanel');
const processConfigPanel = document.getElementById('processConfigPanel');
const processResultPanel = document.getElementById('processResultPanel');
const processForm = document.getElementById('processForm');
const processConnectButton = document.getElementById('processConnect');
const processNoticeEl = document.getElementById('processNotice');
const processAccountInput = document.getElementById('processAccount');
const processTitleInput = document.getElementById('processTitle');
const processDescriptionInput = document.getElementById('processDescription');
const processMaxVotersInput = document.getElementById('processMaxVoters');
const processStartInput = document.getElementById('processStart');
const processDurationInput = document.getElementById('processDuration');
const questionCounter = document.getElementById('questionCounter');
const processLinkOutput = document.getElementById('processLinkOutput');
const processStatusEl = document.getElementById('processStatus');
const processResultEl = document.getElementById('processResult');
const processIdOutput = document.getElementById('processIdOutput');
const addQuestionButton = document.getElementById('addQuestion');
const questionList = document.getElementById('questionList');

let currentAccount = '';
let hasSignature = false;
let hasQr = false;
let hasRegistered = false;
let socketCleanup = null;
let pollCleanup = null;
let processAccount = '';
let processSubmitting = false;
let processCreated = false;

const MAX_QUESTIONS = 8;

const WEIGHT_OF_SELECTOR = '0xdd4bc101';

const NETWORK_LABELS = {
  celo: 'Celo Mainnet',
  staging_celo: 'Celo Sepolia (testnet)',
};

const CHAIN_IDS = {
  celo: '0xa4ec',
  staging_celo: '0xaa044c',
};

const CHAIN_ID_NUM = {
  celo: '42220',
  staging_celo: '44787',
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#ff9b9b' : '';
}

function setConnectNotice(message, isError = false) {
  if (!connectNoticeEl) return;
  if (!message) {
    connectNoticeEl.classList.add('is-hidden');
    connectNoticeEl.textContent = '';
    connectNoticeEl.classList.remove('is-error');
    connectWalletButton.classList.remove('is-hidden');
    return;
  }
  connectNoticeEl.textContent = message;
  connectNoticeEl.classList.toggle('is-error', isError);
  connectNoticeEl.classList.remove('is-hidden');
  connectWalletButton.classList.add('is-hidden');
}

function setProcessStatus(message, isError = false) {
  if (!processStatusEl) return;
  processStatusEl.textContent = message;
  processStatusEl.style.color = isError ? '#ff9b9b' : '';
}

function setProcessNotice(message, isError = false) {
  if (!processNoticeEl || !processConnectButton) return;
  if (!message) {
    processNoticeEl.classList.add('is-hidden');
    processNoticeEl.textContent = '';
    processNoticeEl.classList.remove('is-error');
    processConnectButton.classList.remove('is-hidden');
    return;
  }
  processNoticeEl.textContent = message;
  processNoticeEl.classList.toggle('is-error', isError);
  processNoticeEl.classList.remove('is-hidden');
  processConnectButton.classList.add('is-hidden');
}

function updateButtons() {
  generateButton.disabled = !currentAccount || !hasSignature;
  copyLinkButton.disabled = !linkOutput.value;
  if (qrPanel) {
    qrPanel.classList.toggle('is-locked', !hasSignature);
  }
  if (signatureBadge) {
    signatureBadge.classList.toggle('is-hidden', !hasSignature);
  }
  if (registrationBadge) {
    registrationBadge.classList.toggle('is-hidden', !hasRegistered);
  }
  updateProgress();
}

function updateProcessButtons() {
  if (!processForm || !processConnectButton || !processAccountInput) return;
  const canSubmit = Boolean(processAccount) && !processSubmitting;
  processForm.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = !canSubmit;
  });
  processConnectButton.disabled = processSubmitting;
  updateProcessProgress();
}

function setProcessLoading(isLoading) {
  processSubmitting = isLoading;
  if (!processForm) return;
  const elements = processForm.querySelectorAll('input, textarea, button, select');
  elements.forEach((el) => {
    if (el.id === 'processConnect') return;
    if (el.dataset?.action === 'add-choice' || el.dataset?.action === 'remove-choice' || el.dataset?.action === 'remove-question') {
      el.disabled = isLoading;
      return;
    }
    if (el.tagName === 'BUTTON') {
      el.disabled = isLoading;
      return;
    }
    el.disabled = isLoading;
  });
  updateProcessButtons();
}

function fillConfig() {
  configApp.textContent = CONFIG.appName || 'Missing';
  configContract.textContent = CONFIG.endpoint || 'Missing';
  configScope.textContent = CONFIG.scope || 'Missing';
  configNetwork.textContent = NETWORK_LABELS[CONFIG.endpointType] ?? CONFIG.endpointType;
  const displayMinAge = normalizeMinAge(CONFIG.minAge);
  configMinAge.textContent = displayMinAge ? String(displayMinAge) : 'Missing';
  configNationality.textContent = CONFIG.nationality || 'N/A';
  if (processContract) {
    processContract.textContent = CONFIG.endpoint || 'Missing';
  }
  if (processCensusUri) {
    processCensusUri.textContent = buildCensusUri() || 'Missing';
  }
  if (processSequencerUrl) {
    processSequencerUrl.textContent = CONFIG.davinciSequencerUrl || 'Missing';
  }
  if (processAppUrl) {
    processAppUrl.textContent = CONFIG.davinciAppUrl || 'Missing';
  }
  highlightMinAgeEls.forEach((el) => {
    el.textContent = displayMinAge ? `${displayMinAge}+` : '—';
  });
  highlightNationalityEls.forEach((el) => {
    el.textContent = CONFIG.nationality || '—';
  });
}

function requireEnv() {
  const missing = [];
  if (!CONFIG.appName) missing.push('VITE_APP_NAME');
  if (!CONFIG.endpoint) missing.push('VITE_CONTRACT_ADDRESS');
  if (!CONFIG.scope) missing.push('VITE_SCOPE');
  if (!CONFIG.endpointType) missing.push('VITE_NETWORK');
  if (!normalizeMinAge(CONFIG.minAge)) missing.push('VITE_MIN_AGE');
  if (missing.length > 0) {
    setStatus(`Missing env vars: ${missing.join(', ')}`, true);
    connectWalletButton.disabled = true;
    generateButton.disabled = true;
    return false;
  }
  connectWalletButton.disabled = false;
  return true;
}

function parseBool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMinAge(value) {
  if (!Number.isFinite(value)) return null;
  const trimmed = Math.trunc(value);
  if (trimmed <= 0 || trimmed > 99) return null;
  return trimmed;
}

function buildCensusUri() {
  const baseUrl = CONFIG.onchainIndexerUrl;
  const contract = CONFIG.endpoint;
  const chainId = CHAIN_ID_NUM[CONFIG.endpointType];
  if (!baseUrl || !contract || !chainId) return '';
  const trimmedBase = baseUrl.replace(/\/$/, '');
  return `${trimmedBase}/${chainId}/${contract.toLowerCase()}/graphql`;
}

function getConfiguredDavinciUrls() {
  return {
    sequencerUrl: String(CONFIG.davinciSequencerUrl || '').trim(),
    appUrl: String(CONFIG.davinciAppUrl || '').trim(),
  };
}

function normalizeProcessId(processId) {
  if (!processId) return '';
  return processId.startsWith('0x') ? processId : `0x${processId}`;
}

function updateProcessProgress() {
  if (!processProgress || !processProgressFill) return;
  let step = 1;
  if (!processAccount) {
    step = 1;
  } else if (processCreated) {
    step = 3;
  } else {
    step = 2;
  }
  processProgress.dataset.step = String(step);
  const percent = step === 1 ? 0 : step === 2 ? 50 : 100;
  processProgressFill.style.width = `${percent}%`;
  if (document.documentElement) {
    document.documentElement.classList.add('process-steps-ready');
  }
  if (processConnectPanel) processConnectPanel.classList.toggle('is-active', step === 1);
  if (processConfigPanel) processConfigPanel.classList.toggle('is-active', step === 2);
  if (processResultPanel) processResultPanel.classList.toggle('is-active', step === 3);
}

function toLocalDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function hydrateProcessDefaults() {
  if (processStartInput && !processStartInput.value) {
    const defaultStart = new Date(Date.now() + 10 * 60 * 1000);
    processStartInput.value = toLocalDateTimeValue(defaultStart);
  }
}

function resetSocket() {
  if (socketCleanup) {
    socketCleanup();
    socketCleanup = null;
  }
}

function resetPolling() {
  if (pollCleanup) {
    pollCleanup();
    pollCleanup = null;
  }
}

function encodeWeightOf(address) {
  const normalized = String(address || '').toLowerCase().replace(/^0x/, '');
  if (normalized.length !== 40) {
    throw new Error('Invalid address format');
  }
  return WEIGHT_OF_SELECTOR + normalized.padStart(64, '0');
}

async function getWeightOf(address) {
  if (!window.ethereum) throw new Error('No wallet provider');
  if (!CONFIG.endpoint) throw new Error('Missing contract address');
  const data = encodeWeightOf(address);
  const result = await window.ethereum.request({
    method: 'eth_call',
    params: [{ to: CONFIG.endpoint, data }, 'latest'],
  });
  return BigInt(result);
}

async function isAlreadyRegistered(address) {
  const weight = await getWeightOf(address);
  return weight > 0n;
}

function startRegistrationPolling(address) {
  resetPolling();
  if (!address) return;
  const poll = async () => {
    try {
      const weight = await getWeightOf(address);
      if (weight > 0n) {
        hasRegistered = true;
        updateButtons();
        setStatus('Registration confirmed. Your address is now in the census.');
        resetPolling();
      }
    } catch {
      // Silent retry; avoid spamming user if RPC hiccups.
    }
  };
  poll();
  const id = setInterval(poll, 8000);
  pollCleanup = () => clearInterval(id);
}

function updateProgress() {
  if (!progress || !progressFill) return;
  let step = 1;
  if (!currentAccount) {
    step = 1;
  } else {
    step = 2;
  }
  progress.dataset.step = String(step);
  const percent = currentAccount ? 100 : 0;
  progressFill.style.width = `${percent}%`;
  if (document.documentElement) {
    document.documentElement.classList.add('steps-ready');
  }
  if (qrPanel) {
    const showQr = step >= 2;
    qrPanel.classList.toggle('is-active', showQr);
  }
  if (connectPanel) {
    connectPanel.classList.toggle('is-active', step === 1);
  }
}

function initWebsocket(selfApp) {
  const websocketUrl = CONFIG.websocketUrl;
  if (!websocketUrl || websocketUrl.includes('localhost') || websocketUrl.includes('127.0.0.1')) {
    setStatus('Invalid Self websocket URL.', true);
    return;
  }

  const socket = io(`${websocketUrl}/websocket`, {
    path: '/',
    query: { sessionId: selfApp.sessionId, clientType: 'web' },
    transports: ['websocket'],
  });

  socket.on('mobile_status', (data) => {
    switch (data.status) {
      case 'mobile_connected':
        setStatus('Phone connected. Sending verification request…');
        socket.emit('self_app', selfApp);
        break;
      case 'mobile_disconnected':
        setStatus('Waiting for Self app to connect…');
        break;
      case 'proof_generation_started':
        setStatus('Generating proof on your phone…');
        break;
      case 'proof_generated':
        setStatus('Proof generated. Verifying…');
        break;
      case 'proof_generation_failed':
        setStatus(data?.reason || 'Proof generation failed. Please retry.', true);
        break;
      case 'proof_verified':
        setStatus('Proof verified. Complete the transaction on-chain.');
        break;
      default:
        break;
    }
  });

  socket.on('connect_error', () => {
    setStatus('Failed to connect to Self websocket.', true);
  });

  socket.on('disconnect', () => {
    setStatus('Waiting for Self app to connect…');
  });

  socketCleanup = () => socket.disconnect();
}

async function ensureChain(setter = setStatus) {
  const expected = CHAIN_IDS[CONFIG.endpointType] ?? null;
  if (!expected || !window.ethereum) return true;
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (current === expected) return true;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: expected }],
    });
    return true;
  } catch {
    setter('Please switch MetaMask to the configured Celo network.', true);
    return false;
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install a wallet like MetaMask.', true);
    return;
  }
  if (!requireEnv()) return;

  try {
    setConnectNotice('');
    const ok = await ensureChain();
    if (!ok) return;
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts.length > 0) {
      currentAccount = accounts[0];
      userAddressInput.value = currentAccount;
      hasSignature = false;
      hasQr = false;
      hasRegistered = false;
      resetPolling();
      setStatus('Wallet connected. Checking registration status…');
      try {
        const alreadyRegistered = await isAlreadyRegistered(currentAccount);
        if (alreadyRegistered) {
          disconnectWallet('This address is already registered in the census.', false, true, true);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check registration status';
        disconnectWallet(message, true, true);
        return;
      }
      updateButtons();
      setStatus('Wallet connected. Requesting signature…');
      await signMessage(true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet connection failed';
    setStatus(message, true);
  }
}

async function signMessage(auto = false) {
  if (!currentAccount) {
    setStatus('Connect wallet first.', true);
    return;
  }
  try {
    const timestamp = new Date().toISOString();
    const message = [
      'Open Citizen Census Registration',
      `Contract: ${CONFIG.endpoint}`,
      `Scope seed: ${CONFIG.scope}`,
      `Address: ${currentAccount}`,
      `Network: ${CONFIG.endpointType}`,
      `Timestamp: ${timestamp}`,
    ].join('\n');

    await window.ethereum.request({
      method: 'personal_sign',
      params: [message, currentAccount],
    });

    hasSignature = true;
    updateButtons();
    setStatus('Signature captured. Generating QR…');
    await generateQr(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signature request failed';
    disconnectWallet(auto ? `${message}. Please reconnect your wallet.` : message, true, true);
  }
}

async function generateQr(auto = false) {
  if (!requireEnv()) return;
  if (!currentAccount) {
    setStatus('Connect wallet first.', true);
    return;
  }
  if (!hasSignature) {
    setStatus('Signature required before generating the QR.', true);
    return;
  }

  try {
    setStatus(auto ? 'Generating QR…' : 'Generating QR…');
    const minAge = normalizeMinAge(CONFIG.minAge);
    if (!minAge) {
      setStatus('VITE_MIN_AGE must be a number between 1 and 99.', true);
      return;
    }
    const disclosures = {
      minimumAge: minAge,
      nationality: true,
      date_of_birth: true,
      ofac: parseBool(CONFIG.ofacEnabled),
    };
    const excludedCountries = parseCsv(CONFIG.forbiddenCountries);
    if (excludedCountries.length > 0) {
      disclosures.excludedCountries = excludedCountries;
    }

    const selfApp = buildSelfApp({
      appName: CONFIG.appName,
      scope: CONFIG.scope,
      endpoint: CONFIG.endpoint.toLowerCase(),
      endpointType: CONFIG.endpointType,
      userId: currentAccount,
      userIdType: 'hex',
      disclosures,
      userDefinedData: CONFIG.userData,
      deeplinkCallback: CONFIG.deeplinkCallback || undefined,
    });

    resetSocket();
    initWebsocket(selfApp);

    const qrLink = getQrLink(selfApp);
    const dataUrl = await QRCode.toDataURL(qrLink, { width: 320, margin: 1 });
    const universalLink = getUniversalLink(selfApp);

    qrImg.src = dataUrl;
    linkOutput.value = universalLink;
    hasQr = true;
    updateButtons();
    setStatus('Ready. Scan the QR in the Self app to register.');
    startRegistrationPolling(currentAccount);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate QR';
    setStatus(message, true);
    qrImg.removeAttribute('src');
    linkOutput.value = '';
    hasQr = false;
    resetPolling();
    updateButtons();
  }
}

connectWalletButton.addEventListener('click', connectWallet);
generateButton.addEventListener('click', generateQr);
if (processConnectButton) {
  processConnectButton.addEventListener('click', connectProcessWallet);
}
if (processForm) {
  processForm.addEventListener('submit', handleProcessSubmit);
}
if (addQuestionButton) {
  addQuestionButton.addEventListener('click', () => {
    if (!questionList) return;
    questionList.append(createQuestionCard());
    refreshQuestionIndices();
  });
}
if (questionList) {
  questionList.addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const card = actionButton.closest('.question-card');
    if (!card) return;
    const action = actionButton.dataset.action;
    if (action === 'add-choice') {
      const list = card.querySelector('[data-choices]');
      if (list) list.append(createChoiceRow());
      updateChoiceControls(card);
    }
    if (action === 'remove-choice') {
      const row = actionButton.closest('.choice-row');
      if (row) row.remove();
      updateChoiceControls(card);
    }
    if (action === 'remove-question') {
      card.remove();
      refreshQuestionIndices();
    }
  });
}
window.addEventListener('beforeunload', () => {
  resetSocket();
  resetPolling();
});

copyLinkButton.addEventListener('click', async () => {
  if (!linkOutput.value) return;
  try {
    await navigator.clipboard.writeText(linkOutput.value);
    setStatus('Link copied to clipboard.');
  } catch {
    setStatus('Copy failed. Select the link and copy manually.', true);
  }
});

function disconnectWallet(message, isError = false, showNotice = false, keepProgress = false) {
  currentAccount = '';
  hasSignature = false;
  hasQr = false;
  hasRegistered = false;
  resetPolling();
  userAddressInput.value = '';
  qrImg.removeAttribute('src');
  linkOutput.value = '';
  if (!keepProgress) {
    if (progress) progress.dataset.step = '1';
    if (progressFill) progressFill.style.width = '0%';
  }
  updateButtons();
  if (showNotice) {
    setConnectNotice(message || 'Wallet disconnected. Connect again to continue.', isError);
    setStatus('Connect wallet to start.');
  } else if (message) {
    setStatus(message, isError);
  } else {
    setStatus('Wallet disconnected. Connect again to continue.');
  }
}

function createChoiceRow(value = '') {
  const row = document.createElement('div');
  row.className = 'choice-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Choice label';
  input.value = value;
  input.className = 'choice-input';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'ghost small';
  removeButton.textContent = 'Remove';
  removeButton.dataset.action = 'remove-choice';
  row.append(input, removeButton);
  return row;
}

function createQuestionCard() {
  const card = document.createElement('div');
  card.className = 'question-card';
  card.innerHTML = `
    <div class="question-head">
      <span class="question-index">Question</span>
      <button type="button" class="ghost small" data-action="remove-question">Remove</button>
    </div>
    <label>
      Question title
      <input type="text" class="question-title" placeholder="What should the census decide?" required />
    </label>
    <label>
      Question description
      <textarea class="question-description" rows="2" placeholder="Add context for voters (optional)."></textarea>
    </label>
    <div class="choice-list" data-choices></div>
    <div class="choice-actions">
      <button type="button" class="ghost small" data-action="add-choice">Add choice</button>
    </div>
  `;
  const choices = card.querySelector('[data-choices]');
  if (choices) {
    choices.append(createChoiceRow('Yes'));
    choices.append(createChoiceRow('No'));
  }
  return card;
}

function updateChoiceControls(card) {
  const choices = card.querySelectorAll('.choice-row');
  const removeButtons = card.querySelectorAll('[data-action="remove-choice"]');
  removeButtons.forEach((button) => {
    button.disabled = choices.length <= 2;
  });
}

function refreshQuestionIndices() {
  if (!questionList) return;
  const cards = Array.from(questionList.querySelectorAll('.question-card'));
  cards.forEach((card, index) => {
    const label = card.querySelector('.question-index');
    if (label) label.textContent = `Question ${index + 1}`;
    const removeButton = card.querySelector('[data-action="remove-question"]');
    if (removeButton) {
      removeButton.disabled = cards.length <= 1;
    }
    updateChoiceControls(card);
  });
  if (questionCounter) {
    questionCounter.textContent = `${cards.length}/${MAX_QUESTIONS} questions`;
  }
  if (addQuestionButton) {
    addQuestionButton.disabled = cards.length >= MAX_QUESTIONS;
  }
}

function initQuestionList() {
  if (!questionList) return;
  questionList.innerHTML = '';
  questionList.append(createQuestionCard());
  refreshQuestionIndices();
}

function parseQuestions() {
  if (!questionList) return [];
  const cards = Array.from(questionList.querySelectorAll('.question-card'));
  if (cards.length === 0) {
    throw new Error('Add at least one question.');
  }
  return cards.map((card, index) => {
    const titleInput = card.querySelector('.question-title');
    const descriptionInput = card.querySelector('.question-description');
    const title = titleInput?.value.trim() || '';
    if (!title) {
      throw new Error(`Question ${index + 1} needs a title.`);
    }
    const description = descriptionInput?.value.trim() || '';
    const choiceInputs = Array.from(card.querySelectorAll('.choice-input'));
    const choices = choiceInputs
      .map((input, choiceIndex) => {
        const value = input.value.trim();
        if (!value) {
          throw new Error(`Question ${index + 1} has an empty choice.`);
        }
        return { title: value, value: choiceIndex };
      })
      .filter(Boolean);
    if (choices.length < 2) {
      throw new Error(`Question ${index + 1} needs at least two choices.`);
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

async function connectProcessWallet() {
  if (!window.ethereum) {
    setProcessStatus('No wallet detected. Install MetaMask to continue.', true);
    return;
  }
  try {
    setProcessNotice('');
    const ok = await ensureChain(setProcessStatus);
    if (!ok) return;
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts && accounts.length > 0) {
      processAccount = accounts[0];
      if (processAccountInput) processAccountInput.value = processAccount;
      processCreated = false;
      if (processResultEl) processResultEl.classList.add('is-hidden');
      setProcessStatus('Wallet connected. Ready to create the process.');
      setProcessNotice('Wallet connected', false);
      updateProcessButtons();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet connection failed';
    setProcessStatus(message, true);
  }
}

async function handleProcessSubmit(event) {
  event.preventDefault();
  if (processSubmitting) return;
  if (!processAccount) {
    setProcessStatus('Connect a wallet to create the process.', true);
    return;
  }
  if (!CONFIG.endpoint) {
    setProcessStatus('Missing Open Citizen Census contract address.', true);
    return;
  }

  const { sequencerUrl, appUrl } = getConfiguredDavinciUrls();
  if (!sequencerUrl) {
    setProcessStatus('Missing VITE_DAVINCI_SEQUENCER_URL.', true);
    return;
  }
  if (!appUrl) {
    setProcessStatus('Missing VITE_DAVINCI_APP_URL.', true);
    return;
  }
  const censusUri = buildCensusUri();
  if (!censusUri) {
    setProcessStatus('Onchain census indexer URL is required to build the census URI.', true);
    return;
  }

  const title = processTitleInput?.value.trim() || '';
  if (!title) {
    setProcessStatus('Process title is required.', true);
    return;
  }
  const description = processDescriptionInput?.value.trim() || '';
  const maxVoters = Number(processMaxVotersInput?.value);
  if (!Number.isFinite(maxVoters) || maxVoters <= 0) {
    setProcessStatus('Maximum voters must be a positive number.', true);
    return;
  }

  const durationHours = Number(processDurationInput?.value);
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    setProcessStatus('Duration must be greater than 0 hours.', true);
    return;
  }
  const duration = Math.round(durationHours * 3600);

  let startDate = processStartInput?.value ? new Date(processStartInput.value) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) {
    startDate = new Date(Date.now() + 10 * 60 * 1000);
  }
  if (startDate.getTime() < Date.now()) {
    startDate = new Date(Date.now() + 10 * 60 * 1000);
  }

  let questions;
  try {
    questions = parseQuestions();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid questions';
    setProcessStatus(message, true);
    return;
  }
  if (questions.length > MAX_QUESTIONS) {
    setProcessStatus(`Maximum ${MAX_QUESTIONS} questions allowed.`, true);
    return;
  }

  const ballot = buildBallotFromQuestions(questions);

  try {
    setProcessLoading(true);
    processCreated = false;
    setProcessStatus('Initializing Davinci SDK…');
    if (processResultEl) processResultEl.classList.add('is-hidden');
    if (processIdOutput) processIdOutput.textContent = '';
    if (processLinkOutput) {
      processLinkOutput.textContent = '';
      processLinkOutput.removeAttribute('href');
    }

    const provider = new BrowserProvider(window.ethereum);
    const signer = await provider.getSigner(processAccount);
    const sdk = new DavinciSDK({ signer, sequencerUrl });
    await sdk.init();

    setProcessStatus('Creating process on-chain…');
    const census = new OnchainCensus(CONFIG.endpoint, censusUri);

    const result = await sdk.createProcess({
      title,
      description,
      census,
      maxVoters,
      ballot,
      timing: {
        startDate,
        duration,
      },
      questions,
    });

    const processId = normalizeProcessId(result.processId);
    if (processIdOutput) processIdOutput.textContent = processId;
    if (processLinkOutput) {
      const baseUrl = appUrl.replace(/\/$/, '');
      const voteUrl = `${baseUrl}/vote/${processId}`;
      processLinkOutput.href = voteUrl;
      processLinkOutput.textContent = voteUrl;
    }
    if (processResultEl) processResultEl.classList.remove('is-hidden');
    processCreated = true;
    updateProcessProgress();
    setProcessStatus('Process created. Process ID ready.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create process';
    setProcessStatus(message, true);
  } finally {
    setProcessLoading(false);
  }
}

function resolveRoute(raw) {
  const value = String(raw || '').replace('#', '').toLowerCase();
  if (value === 'register' || value === 'registration') return 'register';
  if (value === 'process') return 'process';
  return 'home';
}

function applyRoute(route) {
  if (viewHome) viewHome.classList.toggle('is-active', route === 'home');
  if (viewRegistration) viewRegistration.classList.toggle('is-active', route === 'register');
  if (viewProcess) viewProcess.classList.toggle('is-active', route === 'process');
}

function setRoute(route) {
  if (route === 'home') {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  } else {
    window.location.hash = route;
  }
  applyRoute(route);
}

document.querySelectorAll('[data-route]').forEach((el) => {
  el.addEventListener('click', () => {
    const target = resolveRoute(el.dataset.route);
    setRoute(target);
  });
});

window.addEventListener('hashchange', () => {
  applyRoute(resolveRoute(window.location.hash));
});

fillConfig();
updateButtons();
updateProcessButtons();
initQuestionList();
hydrateProcessDefaults();
if (processStatusEl) {
  setProcessStatus('Complete the form to create a new process and receive its ID.');
}
if (requireEnv()) {
  setStatus('Connect wallet to start.');
}
applyRoute(resolveRoute(window.location.hash));
