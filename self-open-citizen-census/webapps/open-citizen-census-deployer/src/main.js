import { AbiCoder, Interface, sha256 } from 'ethers';
import './style.css';
import artifact from './artifacts/OpenCitizenCensus.json';

const env = import.meta.env;

const HUB_ADDRESS = '0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF';
const POSEIDON_T3 = '0xF134707a4C4a3a76b8410fC0294d620A7c341581';
const CHAIN_ID_HEX = '0xa4ec';
const CHAIN_ID_DEC = 42220;
const INDEXER_URL = env.VITE_ONCHAIN_CENSUS_INDEXER_URL ?? '';
const APP_URL = env.VITE_OPEN_CITIZEN_CENSUS_APP_URL ?? '';

const nationalityInput = document.getElementById('nationality');
const minAgeInput = document.getElementById('minAge');
const scopeSeedInput = document.getElementById('scopeSeed');
const hubInput = document.getElementById('hubAddress');
const poseidonInput = document.getElementById('poseidon');
const networkNameInput = document.getElementById('networkName');

const summaryNationality = document.getElementById('summaryNationality');
const summaryMinAge = document.getElementById('summaryMinAge');
const summaryScope = document.getElementById('summaryScope');
const computedConfigIdInput = document.getElementById('computedConfigId');

const statusEl = document.getElementById('status');
const connectButton = document.getElementById('connectWallet');
const registerConfigButton = document.getElementById('registerConfig');
const deployButton = document.getElementById('deploy');
const copyTxButton = document.getElementById('copyTx');
const copyAddressButton = document.getElementById('copyAddress');
const copyConfigIdButton = document.getElementById('copyConfigId');

const walletAddressEl = document.getElementById('walletAddress');
const configStatusEl = document.getElementById('configStatus');
const txHashEl = document.getElementById('txHash');
const contractAddressEl = document.getElementById('contractAddress');
const appLinkInput = document.getElementById('appLink');
const copyAppLinkButton = document.getElementById('copyAppLink');
const openAppLinkButton = document.getElementById('openAppLink');

const scopeHelp = document.getElementById('scopeHelp');
const nationalityHelp = document.getElementById('nationalityHelp');

let currentAccount = '';
let currentTx = '';
let currentContract = '';
let currentAppLink = '';
let computedConfigId = '';
let configRegistered = false;
let configCheckNonce = 0;

const HUB_INTERFACE = new Interface([
  'function setVerificationConfigV2((bool olderThanEnabled,uint256 olderThan,bool forbiddenCountriesEnabled,uint256[4] forbiddenCountriesListPacked,bool[3] ofacEnabled)) returns (bytes32)',
  'function verificationConfigV2Exists(bytes32) view returns (bool)',
  'event VerificationConfigV2Set(bytes32 indexed configId, (bool olderThanEnabled,uint256 olderThan,bool forbiddenCountriesEnabled,uint256[4] forbiddenCountriesListPacked,bool[3] ofacEnabled) config)',
]);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('is-error', isError);
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

function resolveOpenCitizenCensusAppBaseUrl() {
  const configured = String(APP_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const currentUrl = new URL(window.location.href);
  if (/\/deployer\/?$/.test(currentUrl.pathname)) {
    currentUrl.pathname = currentUrl.pathname.replace(/\/deployer\/?$/, '/app');
    currentUrl.search = '';
    currentUrl.hash = '';
    return currentUrl.toString().replace(/\/+$/, '');
  }

  return `${window.location.origin}/app`;
}

function buildOpenCitizenCensusAppLink(config) {
  const contractAddress = String(config.contractAddress || '').trim();
  const scope = String(config.scope || '').trim();
  const minAge = Number(config.minAge);
  const nationality = String(config.nationality || '').trim().toUpperCase();
  const network = String(config.network || '').trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) return '';
  if (!scope || scope.length > 31) return '';
  if (!Number.isFinite(minAge) || minAge <= 0 || minAge > 99) return '';
  if (!/^[A-Z]{2,3}$/.test(nationality)) return '';

  const envPayload = encodeBase64UrlJson({
    v: 1,
    contractAddress,
    scope,
    minAge: Math.trunc(minAge),
    nationality,
    network: network || 'celo',
  });

  return `${resolveOpenCitizenCensusAppBaseUrl()}/?env=${envPayload}`;
}

function setAppLink(url) {
  currentAppLink = url || '';
  if (appLinkInput) {
    appLinkInput.value = currentAppLink;
  }
  if (copyAppLinkButton) {
    copyAppLinkButton.disabled = !currentAppLink;
  }
  if (openAppLinkButton) {
    openAppLinkButton.disabled = !currentAppLink;
  }
}

function normalizeNationality(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeScope(value) {
  return String(value || '').trim();
}

function normalizeMinAge(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  const age = Math.trunc(parsed);
  if (age <= 0 || age > 99) return '';
  return String(age);
}

function isNationalityCode(code) {
  return /^[A-Z]{2,3}$/.test(code);
}

const EMPTY_FORBIDDEN_COUNTRIES = [0n, 0n, 0n, 0n];
const EMPTY_OFAC = [false, false, false];

function computeConfigId(params) {
  const coder = AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ['bool', 'uint256', 'bool', 'uint256[4]', 'bool[3]'],
    [
      params.olderThanEnabled,
      params.olderThan,
      params.forbiddenCountriesEnabled,
      params.forbiddenCountriesListPacked,
      params.ofacEnabled,
    ]
  );
  return sha256(encoded);
}

function updateOutputs() {
  const nationality = normalizeNationality(nationalityInput.value);
  const minAge = normalizeMinAge(minAgeInput.value);
  const scopeSeed = normalizeScope(scopeSeedInput.value);

  summaryNationality.textContent = nationality || '—';
  summaryMinAge.textContent = minAge || '—';
  summaryScope.textContent = scopeSeed || '—';
  computedConfigIdInput.value = '';
  computedConfigId = '';
  configRegistered = false;
  setAppLink('');
  if (configStatusEl) {
    configStatusEl.textContent = '—';
  }

  scopeHelp.textContent = `${scopeSeed.length} / 31 characters`;
  if (isNationalityCode(nationality)) {
    nationalityHelp.textContent = 'Format OK';
  } else {
    nationalityHelp.textContent = 'Use two or three-letter uppercase code.';
  }

  const canCompute = Boolean(minAge);

  if (canCompute) {
    computedConfigId = computeConfigId({
      olderThanEnabled: Number(minAge) > 0,
      olderThan: BigInt(minAge),
      forbiddenCountriesEnabled: false,
      forbiddenCountriesListPacked: EMPTY_FORBIDDEN_COUNTRIES,
      ofacEnabled: EMPTY_OFAC,
    });
    computedConfigIdInput.value = computedConfigId;
  }

  updateButtons();
  refreshConfigStatus();
}

function updateButtons() {
  const canDeploy = Boolean(
    currentAccount &&
    isNationalityCode(normalizeNationality(nationalityInput.value)) &&
    normalizeMinAge(minAgeInput.value) &&
    normalizeScope(scopeSeedInput.value).length > 0 &&
    normalizeScope(scopeSeedInput.value).length <= 31 &&
    computedConfigId &&
    configRegistered
  );
  const canRegister = Boolean(
    currentAccount &&
    normalizeMinAge(minAgeInput.value) &&
    computedConfigId &&
    !configRegistered
  );
  deployButton.disabled = !canDeploy;
  registerConfigButton.disabled = !canRegister;
  copyTxButton.disabled = !currentTx;
  copyAddressButton.disabled = !currentContract;
  copyConfigIdButton.disabled = !computedConfigId;
  if (copyAppLinkButton) copyAppLinkButton.disabled = !currentAppLink;
  if (openAppLinkButton) openAppLinkButton.disabled = !currentAppLink;
}

async function ensureChain() {
  if (!window.ethereum) return false;
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (current === CHAIN_ID_HEX) return true;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }],
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wrong network';
    setStatus(`Switch to Celo Mainnet in MetaMask. ${message}`, true);
    return false;
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install MetaMask.', true);
    return;
  }
  try {
    const ok = await ensureChain();
    if (!ok) return;
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    currentAccount = accounts?.[0] ?? '';
    if (!currentAccount) {
      setStatus('No wallet connected.', true);
      return;
    }
    walletAddressEl.textContent = currentAccount;
    setStatus('Wallet connected. Ready to deploy.');
    await refreshConfigStatus();
    updateButtons();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet connection failed';
    setStatus(message, true);
  }
}

function getCurrentCensusConfig() {
  return {
    nationality: normalizeNationality(nationalityInput.value),
    minAge: normalizeMinAge(minAgeInput.value),
    scopeSeed: normalizeScope(scopeSeedInput.value),
    network: 'celo',
  };
}

function buildDeployData(config) {
  const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
  const coder = AbiCoder.defaultAbiCoder();
  const configId = computedConfigId;
  const encodedArgs = coder.encode(
    ['address', 'string', 'bytes32', 'string', 'uint256'],
    [HUB_ADDRESS, config.scopeSeed, configId, config.nationality, BigInt(config.minAge)]
  );
  return `${bytecode}${encodedArgs.slice(2)}`;
}

function buildVerificationConfig() {
  const nationality = normalizeNationality(nationalityInput.value);
  const minAge = normalizeMinAge(minAgeInput.value);
  if (!isNationalityCode(nationality)) {
    throw new Error('Invalid nationality format');
  }
  if (!minAge) {
    throw new Error('Minimum age is required');
  }
  return {
    olderThanEnabled: Number(minAge) > 0,
    olderThan: BigInt(minAge),
    forbiddenCountriesEnabled: false,
    forbiddenCountriesListPacked: EMPTY_FORBIDDEN_COUNTRIES,
    ofacEnabled: EMPTY_OFAC,
  };
}

async function refreshConfigStatus() {
  if (!computedConfigId || !window.ethereum) {
    configRegistered = false;
    if (configStatusEl) configStatusEl.textContent = '—';
    updateButtons();
    return;
  }
  const nonce = ++configCheckNonce;
  try {
    const data = HUB_INTERFACE.encodeFunctionData('verificationConfigV2Exists', [computedConfigId]);
    const result = await window.ethereum.request({
      method: 'eth_call',
      params: [{ to: HUB_ADDRESS, data }, 'latest'],
    });
    if (nonce !== configCheckNonce) return;
    const [exists] = HUB_INTERFACE.decodeFunctionResult('verificationConfigV2Exists', result);
    configRegistered = Boolean(exists);
    if (configStatusEl) {
      configStatusEl.textContent = configRegistered ? 'Registered on hub' : 'Not registered';
    }
    updateButtons();
  } catch {
    if (nonce !== configCheckNonce) return;
    configRegistered = false;
    if (configStatusEl) {
      configStatusEl.textContent = 'Unable to verify';
    }
    updateButtons();
  }
}

async function waitForReceipt(hash) {
  const poll = async (resolve, reject, attempts) => {
    try {
      const receipt = await window.ethereum.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      });
      if (receipt) return resolve(receipt);
      if (attempts > 90) return reject(new Error('Timed out waiting for confirmation'));
      setTimeout(() => poll(resolve, reject, attempts + 1), 4000);
    } catch (error) {
      reject(error);
    }
  };
  return new Promise((resolve, reject) => poll(resolve, reject, 0));
}

async function startIndexer(contractAddress, startBlock) {
  const url = `${INDEXER_URL.replace(/\/$/, '')}/contracts`;
  const payload = {
    chainId: CHAIN_ID_DEC,
    address: contractAddress,
    startBlock,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const message = text ? `${response.status} ${text}` : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return { ok: true };
}

async function deployContract() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install MetaMask.', true);
    return;
  }
  if (!currentAccount) {
    setStatus('Connect your wallet first.', true);
    return;
  }
  const ok = await ensureChain();
  if (!ok) return;
  try {
    const censusConfig = getCurrentCensusConfig();
    if (!isNationalityCode(censusConfig.nationality)) {
      throw new Error('Invalid nationality format');
    }
    if (!censusConfig.minAge) {
      throw new Error('Minimum age is required');
    }
    if (!censusConfig.scopeSeed || censusConfig.scopeSeed.length > 31) {
      throw new Error('Scope seed must be between 1 and 31 characters');
    }

    setStatus('Preparing deployment…');
    const data = buildDeployData(censusConfig);
    const params = [{ from: currentAccount, data }];
    const gas = await window.ethereum.request({ method: 'eth_estimateGas', params });
    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: currentAccount, data, gas }],
    });
    currentTx = txHash;
    txHashEl.textContent = txHash;
    updateButtons();
    setStatus('Transaction submitted. Waiting for confirmation…');
    const receipt = await waitForReceipt(txHash);
    if (receipt && receipt.contractAddress) {
      currentContract = receipt.contractAddress;
      contractAddressEl.textContent = receipt.contractAddress;
      setAppLink(
        buildOpenCitizenCensusAppLink({
          contractAddress: receipt.contractAddress,
          scope: censusConfig.scopeSeed,
          minAge: Number(censusConfig.minAge),
          nationality: censusConfig.nationality,
          network: censusConfig.network,
        })
      );
      updateButtons();
      if (!INDEXER_URL) {
        setStatus('Deployment confirmed. Indexer URL not configured.');
      } else {
        setStatus('Deployment confirmed on Celo Mainnet. Starting indexer…');
        try {
          const startBlock = Number(receipt.blockNumber ?? 0);
          await startIndexer(receipt.contractAddress, startBlock);
          setStatus('Deployment confirmed. Indexer started.');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Indexer start failed';
          setStatus(`Deployment confirmed. ${message}`, true);
        }
      }
    } else {
      setStatus('Transaction confirmed, but no contract address found.', true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment failed';
    setStatus(message, true);
  }
}

async function registerConfig() {
  if (!window.ethereum) {
    setStatus('No wallet detected. Install MetaMask.', true);
    return;
  }
  if (!currentAccount) {
    setStatus('Connect your wallet first.', true);
    return;
  }
  const ok = await ensureChain();
  if (!ok) return;
  try {
    const config = buildVerificationConfig();
    const data = HUB_INTERFACE.encodeFunctionData('setVerificationConfigV2', [config]);
    setStatus('Registering config on the Self hub…');
    const params = [{ from: currentAccount, to: HUB_ADDRESS, data }];
    const gas = await window.ethereum.request({ method: 'eth_estimateGas', params });
    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: currentAccount, to: HUB_ADDRESS, data, gas }],
    });
    currentTx = txHash;
    txHashEl.textContent = txHash;
    updateButtons();
    setStatus('Config transaction submitted. Waiting for confirmation…');
    await waitForReceipt(txHash);
    setStatus('Config registered on the hub.');
    await refreshConfigStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to register config';
    setStatus(message, true);
  }
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard.writeText(value).catch(() => { });
}

[nationalityInput, minAgeInput, scopeSeedInput].forEach((input) =>
  input.addEventListener('input', updateOutputs)
);

connectButton.addEventListener('click', connectWallet);
registerConfigButton.addEventListener('click', registerConfig);
deployButton.addEventListener('click', deployContract);
copyTxButton.addEventListener('click', () => copyText(currentTx));
copyAddressButton.addEventListener('click', () => copyText(currentContract));
copyConfigIdButton.addEventListener('click', () => copyText(computedConfigId));
if (copyAppLinkButton) {
  copyAppLinkButton.addEventListener('click', () => copyText(currentAppLink));
}
if (openAppLinkButton) {
  openAppLinkButton.addEventListener('click', () => {
    if (!currentAppLink) return;
    window.open(currentAppLink, '_blank', 'noopener,noreferrer');
  });
}

hubInput.value = HUB_ADDRESS;
poseidonInput.value = POSEIDON_T3;
networkNameInput.value = 'Celo Mainnet (42220)';

nationalityInput.value = env.VITE_NATIONALITY ?? '';
minAgeInput.value = env.VITE_MIN_AGE ?? '';
scopeSeedInput.value = env.VITE_SCOPE_SEED ?? '';

setAppLink('');
updateOutputs();
