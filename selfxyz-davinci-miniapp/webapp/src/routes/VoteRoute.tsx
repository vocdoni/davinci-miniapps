import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wallet } from 'ethers';
import { useParams } from 'react-router-dom';
import { ProcessStatus } from '@vocdoni/davinci-sdk';
import { SelfAppBuilder, SelfQRcodeWrapper } from '@selfxyz/qrcode';

import { COPY } from '../copy';
import {
  ACTIVE_NETWORK,
  CENSUS_INTERFACE,
  CONFIG,
  DEFAULT_DOCUMENT_TITLE,
  NETWORKS,
  PROCESS_STATUS_INFO,
  VOTE_POLL_MS,
  VOTE_STATUS_FLOW,
  VOTE_STATUS_INFO,
  buildCensusUri,
  extractCensusContract,
  extractCensusUri,
  extractProcessDurationMs,
  extractProcessEndDateMs,
  extractVoteContextFromMetadata,
  formatDurationMs,
  formatRemainingTimeFromEndMs,
  formatVotePercent,
  formatVoteStatusLabel,
  getLocalizedText,
  getProcessStatusInfo,
  hasProcessEndedByTime,
  isProcessAcceptingVotes,
  isVoteStatusTerminal,
  loadManagedWallet,
  loadProcessMeta,
  loadVoteScopeSeed,
  loadVoteSubmission,
  normalizeProcessResultValues,
  normalizeProcessStatus,
  normalizeVoteQuestions,
  normalizeVoteStatus,
  normalizePrivateKey,
  persistProcessMeta,
  persistVoteScopeSeed,
  persistVoteSubmission,
  setWalletOverride,
  toSafeInteger,
  toSelfEndpointType,
  trimTrailingSlash,
  type VoteStatusKey,
} from '../lib/occ';
import { getUniversalLink } from '../selfApp';
import { buildAssetUrl } from '../utils/assets';
import { isValidCountryCode, isValidProcessId, normalizeCountry, normalizeMinAge, normalizeProcessId, normalizeScope } from '../utils/normalization';
import { ethCall, fetchOnchainWeight } from '../services/readiness';
import {
  createSequencerSdk,
  fetchProcessMetadata,
  fetchSequencerWeight,
  getProcessFromSequencer,
} from '../services/sequencer';
import { connectBrowserWallet, type CreatorWalletConnection } from '../services/wallet';
import AppNavbar from '../components/AppNavbar';
import PopupModal from '../components/PopupModal';
import { detectRegistrationMobileMode } from './vote/device';
import {
  buildSingleQuestionBallotValues,
  createPendingVoteIntent,
  evaluateVoteSubmitGate,
  shouldAutoSubmitPendingVote,
} from './vote/submitFlow';
import type { PendingVoteIntent, RegistrationModalState } from './vote/types';

interface ManagedWalletSnapshot {
  address: string;
  privateKey: string;
  source: 'derived' | 'imported' | 'connected';
  sourceLabel?: string;
}

interface VoteQuestionChoice {
  value: number;
  title: string;
}

interface VoteQuestion {
  title: string;
  description: string;
  choices: VoteQuestionChoice[];
}

interface VoteResolutionState {
  sdk: any | null;
  process: any | null;
  processId: string;
  statusCode: number | null;
  isAcceptingVotes: boolean;
  rawResult: unknown[] | null;
  votersCount: number;
  maxVoters: number;
  processTypeName: string;
  network: string;
  title: string;
  censusContract: string;
  censusUri: string;
  endDateMs: number | null;
  onchainWeight: bigint;
  sequencerWeight: bigint;
  onchainLookupFailed: boolean;
  readinessCheckedAt: number | null;
}

interface VoteSelfState {
  scopeSeed: string;
  minAge: number | null;
  countries: string[];
  country: string;
  link: string;
  generating: boolean;
  selfApp: any | null;
}

interface VoteBallotState {
  question: VoteQuestion | null;
  choice: number | null;
  loading: boolean;
  submitting: boolean;
  hasVoted: boolean;
  submissionId: string;
  submissionStatus: string;
  statusPanelVoteId: string;
  statusWatcherToken: number;
}

const EMPTY_RESOLUTION: VoteResolutionState = {
  sdk: null,
  process: null,
  processId: '',
  statusCode: null,
  isAcceptingVotes: false,
  rawResult: null,
  votersCount: 0,
  maxVoters: 0,
  processTypeName: '',
  network: CONFIG.network,
  title: '',
  censusContract: '',
  censusUri: '',
  endDateMs: null,
  onchainWeight: 0n,
  sequencerWeight: 0n,
  onchainLookupFailed: false,
  readinessCheckedAt: null,
};

const EMPTY_VOTE_SELF: VoteSelfState = {
  scopeSeed: '',
  minAge: null,
  countries: [],
  country: '',
  link: '',
  generating: false,
  selfApp: null,
};

const EMPTY_REGISTRATION_MODAL: RegistrationModalState = {
  open: false,
  dismissReason: '',
  isMobile: false,
  status: 'idle',
};

const EMPTY_BALLOT: VoteBallotState = {
  question: null,
  choice: null,
  loading: false,
  submitting: false,
  hasVoted: false,
  submissionId: '',
  submissionStatus: '',
  statusPanelVoteId: '',
  statusWatcherToken: 0,
};

function shouldShowVoteResults(statusCode: number | null): boolean {
  return normalizeProcessStatus(statusCode) === ProcessStatus.RESULTS;
}

function getClosedProcessMessage(resolution: VoteResolutionState): string {
  const statusCode = normalizeProcessStatus(resolution.statusCode);
  if (statusCode === ProcessStatus.RESULTS) {
    return COPY.vote.closedProcess.results;
  }
  if (statusCode === ProcessStatus.ENDED || hasProcessEndedByTime(resolution.endDateMs)) {
    return COPY.vote.closedProcess.ended;
  }
  if (statusCode === ProcessStatus.PAUSED) {
    return COPY.vote.closedProcess.paused;
  }
  if (statusCode === ProcessStatus.CANCELED) {
    return COPY.vote.closedProcess.canceled;
  }
  if (!resolution.isAcceptingVotes) {
    return COPY.vote.closedProcess.notAccepting;
  }
  return '';
}

function isVoteProcessClosed(resolution: VoteResolutionState): boolean {
  const statusInfo = getProcessStatusInfo(resolution.statusCode);
  if (statusInfo?.closed) return true;
  if (resolution.isAcceptingVotes === false) return true;
  return hasProcessEndedByTime(resolution.endDateMs);
}

function isOnchainReadinessRequired(resolution: VoteResolutionState): boolean {
  const hasRpc = Boolean(String(ACTIVE_NETWORK.rpcUrl || '').trim());
  const hasContract = /^0x[a-fA-F0-9]{40}$/.test(String(resolution.censusContract || '').trim());
  return hasRpc && hasContract && !resolution.onchainLookupFailed;
}

function hasVoteReadiness(resolution: VoteResolutionState): boolean {
  if (isVoteProcessClosed(resolution)) return false;
  const sequencerReady = resolution.sequencerWeight > 0n;
  if (!sequencerReady) return false;
  if (!isOnchainReadinessRequired(resolution)) return true;
  return resolution.onchainWeight > 0n;
}

function canOverwriteVote(ballot: VoteBallotState): boolean {
  if (!ballot.submissionId) return true;
  return isVoteStatusTerminal(ballot.submissionStatus);
}

function normalizeCountries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const rawCountry of value) {
    const country = normalizeCountry(rawCountry);
    if (!isValidCountryCode(country)) continue;
    if (normalized.includes(country)) continue;
    normalized.push(country);
  }
  return normalized;
}

function areVoteChoicesEnabled(resolution: VoteResolutionState, ballot: VoteBallotState): boolean {
  return !isVoteProcessClosed(resolution) && !ballot.submitting && canOverwriteVote(ballot);
}

function formatVoteLifecycle(resolution: VoteResolutionState): {
  stateKey: string;
  title: string;
  label: string;
  description: string;
} {
  const statusCode = normalizeProcessStatus(resolution.statusCode);
  const statusInfo = getProcessStatusInfo(statusCode);
  const endedByTime = hasProcessEndedByTime(resolution.endDateMs);

  let stateKey = statusInfo?.key || 'ready';
  let title = statusInfo?.title || COPY.vote.lifecycle.defaultTitle;
  let label = statusInfo?.label || COPY.vote.lifecycle.defaultLabel;
  let description = statusInfo?.description || COPY.vote.lifecycle.defaultDescription;

  if (!statusInfo && !resolution.isAcceptingVotes) {
    stateKey = 'paused';
    title = COPY.vote.lifecycle.pendingTitle;
    label = COPY.vote.lifecycle.notStartedLabel;
    description = COPY.vote.closedProcess.notAccepting;
  }

  if (endedByTime && stateKey === 'ready') {
    stateKey = 'ended';
    title = COPY.vote.lifecycle.endedTitle;
    label = COPY.vote.lifecycle.endedLabel;
    description = COPY.vote.lifecycle.endedDescription;
  }

  return { stateKey, title, label, description };
}

function buildVoteResultsModel(resolution: VoteResolutionState, ballot: VoteBallotState) {
  const totalVotes = toSafeInteger(resolution.votersCount);
  const rawValues = normalizeProcessResultValues(resolution.rawResult);
  const hasComputedResults = rawValues.length > 0;
  const question = ballot.question;
  const orderedChoices = question ? [...question.choices].sort((a, b) => Number(a.value) - Number(b.value)) : [];
  const rankedChoices = orderedChoices
    .map((choice, order) => {
      const normalizedValue = Number(choice.value);
      const rawVotes = Number.isInteger(normalizedValue) && normalizedValue >= 0 ? rawValues[normalizedValue] : undefined;
      const votes = rawVotes !== undefined ? toSafeInteger(rawVotes) : 0;
      const percentage = totalVotes > 0 ? Math.min(100, Math.max(0, (votes / totalVotes) * 100)) : 0;
      return {
        order,
        title: String(choice.title || `Choice ${order + 1}`),
        votes,
        percentage,
      };
    })
    .sort((left, right) => right.votes - left.votes || left.order - right.order)
    .map((choice, rank) => ({
      ...choice,
      rank: rank + 1,
    }));

  const choicesWithVotes = rankedChoices.filter((choice) => choice.votes > 0).length;

  return {
    totalVotes,
    choicesWithVotes,
    choices: rankedChoices,
    hasComputedResults,
  };
}

function shortenRegistrationWalletAddress(address: string): string {
  const normalized = String(address || '').trim();
  if (!/^0x[a-fA-F0-9]{10,}$/.test(normalized)) return normalized;
  return `${normalized.slice(0, 8)}...${normalized.slice(-4)}`;
}

function getManagedWalletSourceMeta(wallet: ManagedWalletSnapshot | null): {
  key: 'derived' | 'imported' | 'connected' | 'unknown';
  label: string;
  iconClass: string;
  helper: string;
} {
  if (!wallet) {
    return {
      key: 'unknown',
      label: '-',
      iconClass: 'iconoir-user',
      helper: '',
    };
  }

  if (wallet.source === 'connected') {
    return {
      key: 'connected',
      label: COPY.vote.dialogs.walletSourceConnected,
      iconClass: 'iconoir-wallet',
      helper: COPY.vote.dialogs.walletSourceConnectedHelper(wallet.sourceLabel || ''),
    };
  }

  if (wallet.source === 'imported') {
    return {
      key: 'imported',
      label: COPY.vote.dialogs.walletSourceImported,
      iconClass: 'iconoir-key',
      helper: COPY.vote.dialogs.walletSourceImportedHelper,
    };
  }

  return {
    key: 'derived',
    label: COPY.vote.dialogs.walletSourceDerived,
    iconClass: 'iconoir-user',
    helper: COPY.vote.dialogs.walletSourceDerivedHelper,
  };
}

export default function VoteRoute() {
  const params = useParams();
  const baseUrl = import.meta.env.BASE_URL || '/';
  const withBase = useCallback((file: string) => buildAssetUrl(file), []);
  const buildAppHref = useCallback(
    (path: string) => `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
    [baseUrl]
  );
  const navbarLinks = useMemo(
    () => [{ id: 'voteExploreLink', href: buildAppHref('/explore'), label: COPY.shared.explore }],
    [buildAppHref]
  );

  const [contextBlocked, setContextBlocked] = useState(false);
  const [contextMessage, setContextMessage] = useState<string>(COPY.vote.context.invalidProcessId);

  const [voteResolution, setVoteResolution] = useState<VoteResolutionState>(EMPTY_RESOLUTION);
  const [managedWallet, setManagedWallet] = useState<ManagedWalletSnapshot | null>(null);
  const [connectedWallet, setConnectedWallet] = useState<CreatorWalletConnection | null>(null);
  const [voteSelf, setVoteSelf] = useState<VoteSelfState>(EMPTY_VOTE_SELF);
  const [voteBallot, setVoteBallot] = useState<VoteBallotState>(EMPTY_BALLOT);
  const [importKey, setImportKey] = useState('');
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [walletConnectPending, setWalletConnectPending] = useState(false);
  const [voteDetailsOpen, setVoteDetailsOpen] = useState(false);
  const [voteIdentityOpen, setVoteIdentityOpen] = useState(false);
  const [registrationModal, setRegistrationModal] = useState<RegistrationModalState>(EMPTY_REGISTRATION_MODAL);
  const [pendingVoteIntent, setPendingVoteIntent] = useState<PendingVoteIntent | null>(null);
  const [voteStatusDetailsOpen, setVoteStatusDetailsOpen] = useState(false);
  const [copyVoteIdLabel, setCopyVoteIdLabel] = useState<string>(COPY.shared.copy);

  const votePollRef = useRef<number | null>(null);
  const pendingAutoSubmitRef = useRef(false);
  const registrationQrRequestKeyRef = useRef('');
  const resolutionRef = useRef(voteResolution);
  const managedWalletRef = useRef(managedWallet);
  const connectedWalletRef = useRef(connectedWallet);
  const voteSelfRef = useRef(voteSelf);
  const voteBallotRef = useRef(voteBallot);

  useEffect(() => {
    resolutionRef.current = voteResolution;
  }, [voteResolution]);
  useEffect(() => {
    managedWalletRef.current = managedWallet;
  }, [managedWallet]);
  useEffect(() => {
    connectedWalletRef.current = connectedWallet;
  }, [connectedWallet]);
  useEffect(() => {
    voteSelfRef.current = voteSelf;
  }, [voteSelf]);
  useEffect(() => {
    voteBallotRef.current = voteBallot;
  }, [voteBallot]);

  useEffect(() => {
    const questionTitle = String(voteBallot.question?.title || '').trim();
    if (voteResolution.processId && questionTitle && questionTitle !== '-') {
      document.title = `${questionTitle} - ${DEFAULT_DOCUMENT_TITLE}`;
      return;
    }
    document.title = DEFAULT_DOCUMENT_TITLE;
  }, [voteBallot.question?.title, voteResolution.processId]);

  useEffect(() => {
    const hasOpenPopup = contextBlocked || voteDetailsOpen || voteIdentityOpen || registrationModal.open;
    document.body.classList.toggle('app-blocked', hasOpenPopup);
    return () => {
      document.body.classList.remove('app-blocked');
    };
  }, [contextBlocked, registrationModal.open, voteDetailsOpen, voteIdentityOpen]);

  useEffect(() => {
    if (voteIdentityOpen) return;
    setImportKey('');
    setShowImportPanel(false);
  }, [voteIdentityOpen]);

  const managedWalletSourceMeta = useMemo(() => getManagedWalletSourceMeta(managedWallet), [managedWallet]);
  const importKeyPreview = useMemo(() => {
    const raw = String(importKey || '').trim();
    if (!raw) {
      return {
        normalizedKey: '',
        address: '',
        error: '',
      };
    }

    try {
      const normalizedKey = normalizePrivateKey(raw);
      const wallet = new Wallet(normalizedKey);
      return {
        normalizedKey,
        address: wallet.address,
        error: '',
      };
    } catch (error) {
      return {
        normalizedKey: '',
        address: '',
        error: error instanceof Error ? error.message : COPY.vote.dialogs.invalidPrivateKey,
      };
    }
  }, [importKey]);

  const setVoteStatusMessage = useCallback((_message: string, _error = false) => {}, []);

  const stopVotePolling = useCallback(() => {
    if (votePollRef.current) {
      window.clearInterval(votePollRef.current);
      votePollRef.current = null;
    }
  }, []);

  const refreshVoteReadiness = useCallback(async (override?: { processId?: string; censusContract?: string; sdk?: any }) => {
    const resolution = resolutionRef.current;
    const processId = override?.processId ?? resolution.processId;
    const contractAddress = override?.censusContract ?? resolution.censusContract;
    const sdk = override?.sdk ?? resolution.sdk;
    const wallet = managedWalletRef.current;
    const managedAddress = wallet?.address || '';

    if (!processId) {
      setVoteResolution((previous) => ({ ...previous, readinessCheckedAt: null }));
      return;
    }

    if (sdk) {
      try {
        const latestProcess = await getProcessFromSequencer(sdk, processId);
        if (latestProcess && typeof latestProcess === 'object') {
          setVoteResolution((previous) => ({
            ...previous,
            process: latestProcess,
            statusCode: normalizeProcessStatus((latestProcess as any).status),
            isAcceptingVotes: isProcessAcceptingVotes(latestProcess),
            rawResult: Array.isArray((latestProcess as any).result) ? (latestProcess as any).result : null,
            votersCount: toSafeInteger((latestProcess as any).votersCount),
            maxVoters: toSafeInteger((latestProcess as any).maxVoters),
          }));
        }
      } catch {
        // Keep previous process status values if polling fetch fails.
      }
    }

    if (!managedAddress) {
      setVoteResolution((previous) => ({ ...previous, readinessCheckedAt: null }));
      return;
    }

    try {
      if (String(ACTIVE_NETWORK.rpcUrl || '').trim() && /^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || '').trim())) {
        const onchainWeight = await fetchOnchainWeight(contractAddress, managedAddress);
        setVoteResolution((previous) => ({ ...previous, onchainWeight, onchainLookupFailed: false }));
      } else {
        setVoteResolution((previous) => ({ ...previous, onchainWeight: 0n, onchainLookupFailed: false }));
      }
    } catch {
      setVoteResolution((previous) => ({ ...previous, onchainWeight: 0n, onchainLookupFailed: true }));
    }

    try {
      const sequencerWeight = await fetchSequencerWeight(sdk, processId, managedAddress);
      setVoteResolution((previous) => ({ ...previous, sequencerWeight }));
    } catch {
      setVoteResolution((previous) => ({ ...previous, sequencerWeight: 0n }));
    }

    setVoteResolution((previous) => ({ ...previous, readinessCheckedAt: Date.now() }));
  }, [getProcessFromSequencer]);

  const startVotePolling = useCallback(() => {
    stopVotePolling();
    if (!resolutionRef.current.processId) return;
    votePollRef.current = window.setInterval(() => {
      void refreshVoteReadiness();
    }, VOTE_POLL_MS);
  }, [refreshVoteReadiness, stopVotePolling]);

  const restoreVoteSubmissionFromStorage = useCallback((processId: string, address: string) => {
    const stored = loadVoteSubmission(processId, address);
    if (!stored) return null;

    setVoteBallot((previous) => ({
      ...previous,
      submissionId: stored.voteId,
      submissionStatus: stored.status || 'pending',
      hasVoted: false,
    }));
    return stored;
  }, []);

  const fetchVoteSelfMinAge = useCallback(
    async (contractAddress: string) => {
      if (!/^0x[a-fA-F0-9]{40}$/.test(String(contractAddress || ''))) return null;
      const data = CENSUS_INTERFACE.encodeFunctionData('minAge', []);
      const raw = await ethCall(contractAddress, data);
      const [result] = CENSUS_INTERFACE.decodeFunctionResult('minAge', raw);
      const parsed = Number(result);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return Math.trunc(parsed);
    },
    [ethCall]
  );

  const refreshVoteSelfContractData = useCallback(
    async (contractAddress: string) => {
      try {
        const minAge = await fetchVoteSelfMinAge(contractAddress);
        if (minAge) {
          setVoteSelf((previous) => ({ ...previous, minAge }));
        }
      } catch {
        // Ignore contract metadata lookup failures.
      }
    },
    [fetchVoteSelfMinAge]
  );

  const clearVoteSelfArtifacts = useCallback(() => {
    setVoteSelf((previous) => ({
      ...previous,
      link: '',
      selfApp: null,
    }));
  }, []);

  const applyManagedWalletSnapshot = useCallback(
    (processId: string, wallet: ManagedWalletSnapshot | null, connection: CreatorWalletConnection | null = null) => {
      managedWalletRef.current = wallet;
      connectedWalletRef.current = connection;
      setManagedWallet(wallet);
      setConnectedWallet(connection);
      setImportKey('');
      setShowImportPanel(false);
      clearVoteSelfArtifacts();
      setVoteResolution((previous) => ({
        ...previous,
        onchainWeight: 0n,
        sequencerWeight: 0n,
        onchainLookupFailed: false,
        readinessCheckedAt: null,
      }));
      setVoteBallot((previous) => ({
        ...previous,
        submissionId: '',
        submissionStatus: '',
        hasVoted: false,
        statusWatcherToken: previous.statusWatcherToken + 1,
      }));
      if (wallet?.address) {
        restoreVoteSubmissionFromStorage(processId, wallet.address);
      }
    },
    [clearVoteSelfArtifacts, restoreVoteSubmissionFromStorage]
  );

  const bootstrapVoteManagedWallet = useCallback(
    (processId: string) => {
      const normalizedProcessId = normalizeProcessId(processId);
      if (!normalizedProcessId) {
        managedWalletRef.current = null;
        connectedWalletRef.current = null;
        setManagedWallet(null);
        setConnectedWallet(null);
        setImportKey('');
        setShowImportPanel(false);
        return;
      }

      const wallet = loadManagedWallet(normalizedProcessId);
      applyManagedWalletSnapshot(normalizedProcessId, wallet, null);
    },
    [applyManagedWalletSnapshot]
  );

  const clearVoteBallot = useCallback((message?: string) => {
    setVoteBallot((previous) => ({
      ...EMPTY_BALLOT,
      statusWatcherToken: previous.statusWatcherToken + 1,
    }));
    if (message) setVoteStatusMessage(message);
  }, [setVoteStatusMessage]);

  const resetVoteResolution = useCallback(() => {
    stopVotePolling();
    managedWalletRef.current = null;
    connectedWalletRef.current = null;
    setVoteResolution(EMPTY_RESOLUTION);
    setManagedWallet(null);
    setConnectedWallet(null);
    setVoteSelf(EMPTY_VOTE_SELF);
    clearVoteBallot();
    setImportKey('');
    setShowImportPanel(false);
    setPendingVoteIntent(null);
    setRegistrationModal(EMPTY_REGISTRATION_MODAL);
    setVoteDetailsOpen(false);
    setVoteIdentityOpen(false);
    setVoteStatusMessage(COPY.vote.status.resolveProcessAndWallet);
  }, [clearVoteBallot, setVoteStatusMessage, stopVotePolling]);

  const loadVoteQuestions = useCallback(
    async (process: any, metadata: any) => {
      clearVoteBallot(COPY.vote.status.loadingQuestion);
      setVoteBallot((previous) => ({ ...previous, loading: true }));

      try {
        const metadataQuestions = normalizeVoteQuestions(metadata?.questions);
        const directQuestions = normalizeVoteQuestions(process?.questions);
        const resolvedQuestions = metadataQuestions.length ? metadataQuestions : directQuestions;
        const [singleQuestion = null] = resolvedQuestions;

        setVoteBallot((previous) => ({
          ...previous,
          loading: false,
          question: singleQuestion,
          choice: null,
          submissionId: '',
          submissionStatus: '',
          hasVoted: false,
        }));

        if (!singleQuestion) {
          setVoteStatusMessage(COPY.vote.status.noQuestionFound, true);
          return;
        }

        if (resolvedQuestions.length > 1) {
          setVoteStatusMessage(COPY.vote.status.oneQuestionOnly);
        }
      } catch (error) {
        clearVoteBallot(error instanceof Error ? error.message : COPY.vote.status.failedLoadQuestion);
        setVoteStatusMessage(error instanceof Error ? error.message : COPY.vote.status.failedLoadQuestion, true);
      } finally {
        setVoteBallot((previous) => ({ ...previous, loading: false }));
      }
    },
    [clearVoteBallot, setVoteStatusMessage]
  );

  const refreshHasVotedFlag = useCallback(async () => {
    const resolution = resolutionRef.current;
    const processId = resolution.processId;
    const wallet = managedWalletRef.current;
    const managedAddress = wallet?.address;
    const sdk = resolution.sdk;

    if (!processId || !managedAddress || !sdk) {
      setVoteBallot((previous) => ({ ...previous, hasVoted: false }));
      return;
    }

    try {
      const alreadyVoted = await sdk.hasAddressVoted(processId, managedAddress);
      if (alreadyVoted && canOverwriteVote(voteBallotRef.current)) {
        setVoteStatusMessage(COPY.vote.status.alreadyVotedOverwrite);
      }
    } catch {
      // Ignore remote voted flag errors.
    }

    setVoteBallot((previous) => ({ ...previous, hasVoted: false }));
  }, [setVoteStatusMessage]);

  const trackVoteSubmissionStatus = useCallback(
    async (sdk: any, processId: string, voteId: string, token: number, voterAddress = '') => {
      if (!sdk || !voteId) return;

      try {
        for await (const info of sdk.watchVoteStatus(processId, voteId, { pollIntervalMs: 5000, timeoutMs: 300000 })) {
          if (token !== voteBallotRef.current.statusWatcherToken) return;

          const nextStatus = String(info?.status || '');
          setVoteBallot((previous) => ({ ...previous, submissionStatus: nextStatus }));
          persistVoteSubmission(processId, voterAddress, { voteId, status: nextStatus });

          const statusLabel = formatVoteStatusLabel(nextStatus);
          setVoteStatusMessage(COPY.vote.status.voteStatusUpdate(statusLabel));

          const normalized = String(nextStatus || '').toLowerCase();
          if (normalized === 'settled' || normalized === 'error') {
            return;
          }
        }
      } catch {
        // Ignore status watcher errors; latest status remains visible.
      }
    },
    [setVoteStatusMessage]
  );

  const hydrateVoteSelfScope = useCallback(
    (processId: string, contractAddress: string) => {
      const meta = loadProcessMeta(processId);
      const metaScope = normalizeScope(meta?.scopeSeed || '');
      const storedScope = loadVoteScopeSeed(processId);
      const contractMatches =
        !contractAddress ||
        !meta?.contractAddress ||
        String(meta.contractAddress).toLowerCase() === String(contractAddress).toLowerCase();
      const scopeSeed = normalizeScope(storedScope || (contractMatches ? metaScope : ''));

      const metaCountries = normalizeCountries(meta?.countries);
      const metaCountry = normalizeCountry(meta?.country || '');
      const fallbackMetaCountries = isValidCountryCode(metaCountry) ? [metaCountry] : [];
      const resolvedMetaCountries = contractMatches ? (metaCountries.length ? metaCountries : fallbackMetaCountries) : [];
      const metaMinAge = Number(meta?.minAge);
      const resolvedMetaMinAge = contractMatches && Number.isFinite(metaMinAge) && metaMinAge > 0 ? Math.trunc(metaMinAge) : null;

      setVoteSelf((previous) => ({
        ...previous,
        scopeSeed,
        countries: resolvedMetaCountries.length ? resolvedMetaCountries : previous.countries,
        country: resolvedMetaCountries[0] || previous.country,
        minAge: resolvedMetaMinAge || previous.minAge,
      }));

      if (meta?.network && meta.network in NETWORKS) {
        setVoteResolution((previous) => ({ ...previous, network: String(meta.network) }));
      }

      clearVoteSelfArtifacts();
    },
    [clearVoteSelfArtifacts]
  );

  const resolveVoteProcess = useCallback(
    async (processId: string, silent = true) => {
      const normalizedProcessId = normalizeProcessId(processId);
      if (!normalizedProcessId) {
        resetVoteResolution();
        setVoteStatusMessage(COPY.vote.status.enterProcessId);
        return;
      }

      stopVotePolling();
      bootstrapVoteManagedWallet(normalizedProcessId);
      clearVoteSelfArtifacts();

      setVoteResolution((previous) => ({
        ...EMPTY_RESOLUTION,
        processId: normalizedProcessId,
        network: previous.network || CONFIG.network,
      }));
      setVoteSelf((previous) => ({
        ...previous,
        countries: [],
        country: '',
      }));
      clearVoteBallot(COPY.vote.status.resolvingProcess);

      if (!silent) {
        setVoteStatusMessage(COPY.vote.status.resolvingFromSequencer);
      }

      try {
        const sdk = createSequencerSdk({ sequencerUrl: CONFIG.davinciSequencerUrl });
        await sdk.init();
        const process = await getProcessFromSequencer(sdk, normalizedProcessId);
        const metadata = await fetchProcessMetadata(sdk, process);

        const contractAddress = extractCensusContract(process);
        const censusUri = extractCensusUri(process, contractAddress);
        const title = String(
          getLocalizedText(metadata?.title) || process?.title || process?.metadata?.title || process?.metadata?.name || '-'
        ).trim();
        const endDateMs = extractProcessEndDateMs(process, metadata);
        const metadataContext = extractVoteContextFromMetadata(metadata);
        const statusCode = normalizeProcessStatus(process?.status);
        const isAcceptingVotes = isProcessAcceptingVotes(process);
        const rawResult = Array.isArray(process?.result) ? process.result : null;
        const votersCount = toSafeInteger(process?.votersCount);
        const maxVoters = toSafeInteger(process?.maxVoters);
        const processTypeName = String((metadata as any)?.type?.name || process?.metadata?.type?.name || '').trim();

        setVoteResolution((previous) => ({
          ...previous,
          sdk,
          process,
          processId: normalizedProcessId,
          statusCode,
          isAcceptingVotes,
          rawResult,
          votersCount,
          maxVoters,
          processTypeName,
          title,
          censusContract: contractAddress,
          censusUri,
          endDateMs,
          network: metadataContext.network || previous.network || CONFIG.network,
        }));

        if (metadataContext.scopeSeed) {
          setVoteSelf((previous) => ({ ...previous, scopeSeed: metadataContext.scopeSeed }));
          persistVoteScopeSeed(normalizedProcessId, metadataContext.scopeSeed);
        }
        if (metadataContext.minAge) {
          setVoteSelf((previous) => ({ ...previous, minAge: metadataContext.minAge }));
        }
        if (metadataContext.countries.length) {
          setVoteSelf((previous) => ({
            ...previous,
            countries: metadataContext.countries,
            country: metadataContext.countries[0] || previous.country,
          }));
        }
        if (metadataContext.country) {
          setVoteSelf((previous) => ({
            ...previous,
            countries: previous.countries.length ? previous.countries : [metadataContext.country],
            country: metadataContext.country,
          }));
        }

        const existingMeta = loadProcessMeta(normalizedProcessId) || {};
        persistProcessMeta(normalizedProcessId, {
          ...existingMeta,
          title: title !== '-' ? title : existingMeta.title || '',
          contractAddress: contractAddress || existingMeta.contractAddress || '',
          censusUri: censusUri || existingMeta.censusUri || '',
          scopeSeed: metadataContext.scopeSeed || existingMeta.scopeSeed || '',
          minAge: metadataContext.minAge || existingMeta.minAge || undefined,
          countries: metadataContext.countries.length ? metadataContext.countries : existingMeta.countries || undefined,
          country: metadataContext.country || existingMeta.country || '',
          network: metadataContext.network || existingMeta.network || CONFIG.network,
          updatedAt: new Date().toISOString(),
        });

        hydrateVoteSelfScope(normalizedProcessId, contractAddress);
        void refreshVoteSelfContractData(contractAddress);

        await loadVoteQuestions(process, metadata);

        const wallet = managedWalletRef.current;
        if (wallet) {
          const restoredSubmission = restoreVoteSubmissionFromStorage(normalizedProcessId, wallet.address);
          if (restoredSubmission) {
            const normalizedStatus = normalizeVoteStatus(restoredSubmission.status || 'pending') || 'pending';
            const shouldWatch = normalizedStatus !== 'settled' && normalizedStatus !== 'error';
            if (shouldWatch) {
              const watcherToken = voteBallotRef.current.statusWatcherToken + 1;
              setVoteBallot((previous) => ({ ...previous, statusWatcherToken: watcherToken }));
              void trackVoteSubmissionStatus(
                sdk,
                normalizedProcessId,
                restoredSubmission.voteId,
                watcherToken,
                wallet.address || ''
              );
            }
          }
        }

        await refreshVoteReadiness({
          processId: normalizedProcessId,
          censusContract: contractAddress,
          sdk,
        });
        await refreshHasVotedFlag();
        startVotePolling();

        if (!silent) {
          setVoteStatusMessage(COPY.vote.status.processResolved);
        }
      } catch (error) {
        console.error('[OpenCitizenCensus] Failed to resolve process', error);
        resetVoteResolution();
        setVoteStatusMessage(error instanceof Error ? error.message : COPY.vote.status.failedResolveProcess, true);
      }
    },
    [
      bootstrapVoteManagedWallet,
      clearVoteBallot,
      clearVoteSelfArtifacts,
      fetchProcessMetadata,
      getProcessFromSequencer,
      hydrateVoteSelfScope,
      loadVoteQuestions,
      refreshHasVotedFlag,
      refreshVoteReadiness,
      refreshVoteSelfContractData,
      resetVoteResolution,
      restoreVoteSubmissionFromStorage,
      setVoteStatusMessage,
      startVotePolling,
      stopVotePolling,
      trackVoteSubmissionStatus,
    ]
  );

  async function generateVoteSelfQr(auto = false): Promise<void> {
    const resolution = resolutionRef.current;
    const self = voteSelfRef.current;
    const wallet = managedWalletRef.current;

    if (self.generating) return;

    const processId = resolution.processId;
    const contractAddress = resolution.censusContract;
    const managedAddress = wallet?.address;
    const scopeSeed = normalizeScope(self.scopeSeed || '');

    if (isVoteProcessClosed(resolution)) {
      setVoteStatusMessage(getClosedProcessMessage(resolution), true);
      return;
    }
    if (!processId || !contractAddress || !managedAddress) {
      setVoteStatusMessage(COPY.vote.status.resolveProcessAndWallet, true);
      return;
    }
    if (!scopeSeed) {
      setVoteStatusMessage(COPY.vote.status.scopeSeedRequired, true);
      return;
    }
    if (!/^[\x00-\x7F]+$/.test(scopeSeed) || scopeSeed.length > 31) {
      setVoteStatusMessage(COPY.vote.status.scopeSeedAscii, true);
      return;
    }

    persistVoteScopeSeed(processId, scopeSeed);

    setVoteSelf((previous) => ({ ...previous, generating: true, scopeSeed }));

    try {
      if (!auto) {
        setVoteStatusMessage(COPY.vote.status.generatingSelfQr);
      }

      let minAge = self.minAge;
      if (!minAge) {
        minAge = await fetchVoteSelfMinAge(contractAddress);
        if (minAge) {
          setVoteSelf((previous) => ({ ...previous, minAge }));
        }
      }

      const disclosures = {
        minimumAge: minAge ?? undefined,
        nationality: true,
      };

      const selfApp = new SelfAppBuilder({
        appName: CONFIG.selfAppName || COPY.brand.documentTitle,
        scope: scopeSeed,
        endpoint: String(contractAddress).toLowerCase(),
        endpointType: toSelfEndpointType(resolution.network),
        userId: managedAddress,
        userIdType: 'hex',
        disclosures,
        userDefinedData: '',
      }).build();

      const universalLink = getUniversalLink(selfApp);

      setVoteSelf((previous) => ({
        ...previous,
        selfApp,
        link: universalLink,
      }));

      if (!auto) {
        setVoteStatusMessage(COPY.vote.status.selfQrReady);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : COPY.vote.status.failedGenerateSelfQr;
      setVoteStatusMessage(message, true);
    } finally {
      setVoteSelf((previous) => ({ ...previous, generating: false }));
    }
  }

  const copyVoteSelfLink = useCallback(async () => {
    const link = voteSelfRef.current.link;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setVoteStatusMessage(COPY.vote.status.selfLinkCopied);
    } catch {
      setVoteStatusMessage(COPY.vote.status.failedCopySelfLink, true);
    }
  }, [setVoteStatusMessage]);

  const openVoteSelfLink = useCallback(() => {
    const link = voteSelfRef.current.link;
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
  }, []);

  const connectManagedBrowserWallet = useCallback(async () => {
    const processId = resolutionRef.current.processId;
    if (!processId) {
      setVoteStatusMessage(COPY.vote.dialogs.connectBeforeProcess, true);
      return;
    }
    if (walletConnectPending) return;

    try {
      setWalletConnectPending(true);
      setVoteStatusMessage(COPY.vote.status.connectingBrowserWallet);

      const connection = await connectBrowserWallet(connectedWalletRef.current?.provider);
      applyManagedWalletSnapshot(
        processId,
        {
          address: connection.address,
          privateKey: '',
          source: 'connected',
          sourceLabel: connection.sourceLabel,
        },
        connection
      );

      await refreshVoteReadiness();
      await refreshHasVotedFlag();
      setVoteStatusMessage(COPY.vote.status.browserWalletConnected(connection.sourceLabel));
    } catch (error) {
      setVoteStatusMessage(error instanceof Error ? error.message : COPY.vote.status.failedConnectBrowserWallet, true);
    } finally {
      setWalletConnectPending(false);
    }
  }, [applyManagedWalletSnapshot, refreshHasVotedFlag, refreshVoteReadiness, setVoteStatusMessage, walletConnectPending]);

  const importManagedPrivateKey = useCallback(async () => {
    const processId = resolutionRef.current.processId;
    if (!processId) {
      setVoteStatusMessage(COPY.vote.dialogs.importBeforeProcess, true);
      return;
    }
    if (!importKeyPreview.normalizedKey || !importKeyPreview.address) {
      setVoteStatusMessage(importKeyPreview.error || COPY.vote.dialogs.invalidPrivateKey, true);
      return;
    }

    setWalletOverride(processId, importKeyPreview.normalizedKey);
    applyManagedWalletSnapshot(processId, {
      address: importKeyPreview.address,
      privateKey: importKeyPreview.normalizedKey,
      source: 'imported',
    });
    await refreshVoteReadiness();
    await refreshHasVotedFlag();
    setVoteStatusMessage(COPY.vote.dialogs.importedKeyApplied);
  }, [applyManagedWalletSnapshot, importKeyPreview, refreshHasVotedFlag, refreshVoteReadiness, setVoteStatusMessage]);

  const restoreLocalManagedWallet = useCallback(async () => {
    const processId = resolutionRef.current.processId;
    if (!processId) {
      setVoteStatusMessage(COPY.vote.dialogs.resetBeforeProcess, true);
      return;
    }

    const wallet = loadManagedWallet(processId);
    applyManagedWalletSnapshot(processId, wallet, null);
    await refreshVoteReadiness();
    await refreshHasVotedFlag();
    setVoteStatusMessage(COPY.vote.dialogs.localWalletRestored);
  }, [applyManagedWalletSnapshot, refreshHasVotedFlag, refreshVoteReadiness, setVoteStatusMessage]);

  const resolveManagedVoteSigner = useCallback(() => {
    const wallet = managedWalletRef.current;
    if (!wallet) return null;
    if (wallet.source === 'connected') {
      return connectedWalletRef.current?.signer || null;
    }
    if (!wallet.privateKey) return null;
    return new Wallet(wallet.privateKey);
  }, []);

  const submitVoteSnapshot = useCallback(
    async (selectedChoices: number[]): Promise<boolean> => {
      if (voteBallotRef.current.submitting) return false;

      const resolution = resolutionRef.current;
      const ballot = voteBallotRef.current;
      const wallet = managedWalletRef.current;
      const processId = resolution.processId;
      const signer = resolveManagedVoteSigner();

      if (!processId || !wallet) {
        setVoteStatusMessage(COPY.vote.status.resolveBeforeSubmit, true);
        return false;
      }
      if (!signer) {
        setVoteStatusMessage(
          wallet.source === 'connected' ? COPY.vote.status.browserWalletSignerRequired : COPY.vote.status.resolveBeforeSubmit,
          true
        );
        return false;
      }
      if (isVoteProcessClosed(resolution)) {
        setVoteStatusMessage(getClosedProcessMessage(resolution), true);
        return false;
      }
      if (!hasVoteReadiness(resolution)) {
        const message = isOnchainReadinessRequired(resolution)
          ? COPY.vote.status.registrationPendingBoth
          : COPY.vote.status.registrationPendingSequencer;
        setVoteStatusMessage(message, true);
        return false;
      }
      if (!canOverwriteVote(ballot)) {
        setVoteStatusMessage(COPY.vote.status.voteInProgressOverwrite, true);
        return false;
      }
      if (!ballot.question) {
        setVoteStatusMessage(COPY.vote.status.noQuestionAvailable, true);
        return false;
      }
      if (selectedChoices.length !== 1) {
        setVoteStatusMessage(COPY.vote.status.selectOneOption, true);
        return false;
      }

      const censusUrl = trimTrailingSlash(CONFIG.onchainIndexerUrl);
      if (!censusUrl) {
        setVoteStatusMessage(COPY.vote.status.missingCensusConfig, true);
        return false;
      }

      try {
        setVoteBallot((previous) => ({ ...previous, submitting: true }));
        setVoteStatusMessage(COPY.vote.status.submittingVote);

        const sdk = createSequencerSdk({
          signer,
          sequencerUrl: CONFIG.davinciSequencerUrl,
          censusUrl,
        });
        await sdk.init();

        let ballotValues: number[] = [];
        try {
          ballotValues = buildSingleQuestionBallotValues(
            Number(selectedChoices[0]),
            ballot.question.choices.map((choice) => Number(choice.value))
          );
        } catch (error) {
          setVoteStatusMessage(error instanceof Error ? error.message : COPY.vote.status.invalidOptionForQuestion, true);
          return false;
        }

        const result = await sdk.submitVote({ processId, choices: ballotValues });
        const voteId = String(result?.voteId || '');
        const voteStatus = String(result?.status || 'pending');

        setVoteBallot((previous) => ({
          ...previous,
          submissionId: voteId,
          submissionStatus: voteStatus,
          statusPanelVoteId: '',
          hasVoted: true,
        }));

        persistVoteSubmission(processId, wallet.address, {
          voteId,
          status: voteStatus,
        });
        setVoteStatusMessage(COPY.vote.status.voteSubmitted);

        const watcherToken = voteBallotRef.current.statusWatcherToken + 1;
        setVoteBallot((previous) => ({ ...previous, statusWatcherToken: watcherToken }));
        void trackVoteSubmissionStatus(sdk, processId, voteId, watcherToken, wallet.address);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : COPY.vote.status.failedSubmitVote;
        if (voteBallotRef.current.submissionId) {
          setVoteBallot((previous) => ({ ...previous, hasVoted: false, submissionStatus: 'error' }));
          persistVoteSubmission(processId, wallet.address, {
            voteId: voteBallotRef.current.submissionId,
            status: 'error',
          });
        }
        setVoteStatusMessage(message, true);
        return false;
      } finally {
        setVoteBallot((previous) => ({ ...previous, submitting: false }));
      }
    },
    [resolveManagedVoteSigner, setVoteStatusMessage, trackVoteSubmissionStatus]
  );

  const emitVote = useCallback(async () => {
    if (voteBallotRef.current.submitting || pendingVoteIntent) return;

    const resolution = resolutionRef.current;
    const ballot = voteBallotRef.current;
    const wallet = managedWalletRef.current;
    const processId = resolution.processId;
    const walletAddress = wallet?.address || '';

    const hasQuestion = Boolean(ballot.question);
    const selectedChoice = ballot.choice;
    const hasAllSelectedChoices =
      hasQuestion &&
      Number.isInteger(selectedChoice) &&
      Number(selectedChoice) >= 0 &&
      (ballot.question?.choices || []).some((choice) => Number(choice.value) === selectedChoice);

    const gate = evaluateVoteSubmitGate(
      {
        hasProcessId: Boolean(processId),
        hasWalletSigner: Boolean(wallet && (wallet.source === 'connected' ? connectedWalletRef.current?.signer : wallet.privateKey)),
        isProcessClosed: isVoteProcessClosed(resolution),
        hasQuestion,
        hasAllChoices: hasAllSelectedChoices,
        canOverwriteVote: canOverwriteVote(ballot),
        hasVoteReadiness: hasVoteReadiness(resolution),
      },
      {
        missingContext: wallet?.source === 'connected' ? COPY.vote.status.browserWalletSignerRequired : COPY.vote.status.resolveBeforeSubmit,
        processClosed: getClosedProcessMessage(resolution),
      }
    );

    if (gate.result === 'blocked') {
      setVoteStatusMessage(gate.blockMessage, true);
      return;
    }

    let pendingIntent: PendingVoteIntent;
    try {
      pendingIntent = createPendingVoteIntent(processId, walletAddress, [ballot.choice]);
    } catch (error) {
      setVoteStatusMessage(error instanceof Error ? error.message : COPY.vote.status.selectOneOption, true);
      return;
    }

    if (gate.result === 'ready') {
      await submitVoteSnapshot(pendingIntent.choiceSnapshot);
      return;
    }

    await refreshVoteReadiness();
    if (hasVoteReadiness(resolutionRef.current)) {
      await submitVoteSnapshot(pendingIntent.choiceSnapshot);
      return;
    }

    setPendingVoteIntent(pendingIntent);
    setRegistrationModal({
      open: true,
      dismissReason: '',
      isMobile: detectRegistrationMobileMode(),
      status: 'waiting',
    });
    setVoteStatusMessage(COPY.vote.status.registrationRequired);
  }, [pendingVoteIntent, refreshVoteReadiness, setVoteStatusMessage, submitVoteSnapshot]);

  const closeRegistrationModal = useCallback(
    (
      dismissReason: RegistrationModalState['dismissReason'],
      options: { keepPending?: boolean; statusMessage?: string; error?: boolean } = {}
    ) => {
      setRegistrationModal((previous) => ({
        ...previous,
        open: false,
        dismissReason,
        status: 'idle',
      }));
      pendingAutoSubmitRef.current = false;
      registrationQrRequestKeyRef.current = '';
      if (!options.keepPending) {
        setPendingVoteIntent(null);
      }
      if (options.statusMessage) {
        setVoteStatusMessage(options.statusMessage, Boolean(options.error));
      }
    },
    [setVoteStatusMessage]
  );

  const closeContextGatePopup = useCallback(() => {
    setContextBlocked(false);
    setVoteStatusMessage(COPY.vote.context.requiredToContinue, true);
  }, [setVoteStatusMessage]);

  useEffect(() => {
    setVoteStatusDetailsOpen(false);
  }, [voteBallot.submissionId]);

  useEffect(() => {
    const rawSegment = decodeURIComponent(String(params.processId || '')).trim();

    if (!rawSegment) {
      const message = COPY.vote.context.missingInUrl;
      setContextBlocked(true);
      setContextMessage(message);
      resetVoteResolution();
      setVoteStatusMessage(message, true);
      return;
    }

    const normalized = normalizeProcessId(rawSegment);
    if (!isValidProcessId(normalized)) {
      const message = COPY.vote.context.invalidInUrl;
      setContextBlocked(true);
      setContextMessage(message);
      resetVoteResolution();
      setVoteStatusMessage(message, true);
      return;
    }

    setContextBlocked(false);
    setContextMessage('');
    void resolveVoteProcess(normalized, false);
  }, [params.processId, resetVoteResolution, resolveVoteProcess, setVoteStatusMessage]);

  useEffect(() => () => stopVotePolling(), [stopVotePolling]);

  useEffect(() => {
    const updateMode = () => {
      const isMobile = detectRegistrationMobileMode();
      setRegistrationModal((previous) => (previous.isMobile === isMobile ? previous : { ...previous, isMobile }));
    };

    updateMode();
    window.addEventListener('resize', updateMode);
    return () => {
      window.removeEventListener('resize', updateMode);
    };
  }, []);

  useEffect(() => {
    if (!registrationModal.open) return;
    if (registrationModal.status === 'error') return;
    if (hasVoteReadiness(voteResolution)) return;
    if (isVoteProcessClosed(voteResolution)) return;
    if (!voteResolution.processId || !voteResolution.censusContract || !managedWallet?.address || !voteSelf.scopeSeed) return;
    if (voteSelf.generating) return;

    const requestKey = [
      String(voteResolution.processId || '').toLowerCase(),
      String(voteResolution.censusContract || '').toLowerCase(),
      String(managedWallet?.address || '').toLowerCase(),
      normalizeScope(voteSelf.scopeSeed || ''),
    ].join('|');
    if (!requestKey.replace(/\|/g, '')) return;
    if (registrationQrRequestKeyRef.current === requestKey) return;

    registrationQrRequestKeyRef.current = requestKey;
    void generateVoteSelfQr(true);
  }, [
    registrationModal.open,
    registrationModal.status,
    managedWallet?.address,
    voteResolution.censusContract,
    voteResolution.processId,
    voteResolution.endDateMs,
    voteResolution.isAcceptingVotes,
    voteResolution.sequencerWeight,
    voteResolution.statusCode,
    voteResolution.onchainWeight,
    voteSelf.generating,
    voteSelf.scopeSeed,
  ]);

  useEffect(() => {
    if (!registrationModal.open) return;
    if (registrationModal.status === 'error') return;
    const nextStatus = voteBallot.submitting
      ? 'submitting'
      : hasVoteReadiness(voteResolution)
        ? 'ready'
        : voteSelf.generating
          ? 'waiting'
          : 'waiting';
    setRegistrationModal((previous) => (previous.status === nextStatus ? previous : { ...previous, status: nextStatus }));
  }, [registrationModal.open, registrationModal.status, voteBallot.submitting, voteResolution, voteSelf.generating]);

  useEffect(() => {
    if (!pendingVoteIntent) return;
    const activeProcessId = normalizeProcessId(voteResolution.processId);
    if (!activeProcessId || pendingVoteIntent.processId !== activeProcessId) {
      closeRegistrationModal('process_changed', {
        statusMessage: COPY.vote.status.registrationProcessChanged,
      });
    }
  }, [closeRegistrationModal, pendingVoteIntent, voteResolution.processId]);

  useEffect(() => {
    if (!pendingVoteIntent) return;
    const activeWalletAddress = String(managedWallet?.address || '').toLowerCase();
    if (!activeWalletAddress || pendingVoteIntent.walletAddress.toLowerCase() !== activeWalletAddress) {
      closeRegistrationModal('wallet_changed', {
        statusMessage: COPY.vote.status.registrationWalletChanged,
      });
    }
  }, [closeRegistrationModal, managedWallet?.address, pendingVoteIntent]);

  useEffect(() => {
    if (!registrationModal.open) return;
    if (!isVoteProcessClosed(voteResolution)) return;
    closeRegistrationModal('process_closed', {
      statusMessage: getClosedProcessMessage(voteResolution),
      error: true,
    });
  }, [closeRegistrationModal, registrationModal.open, voteResolution]);

  useEffect(() => {
    if (
      !shouldAutoSubmitPendingVote({
        pendingVoteIntent,
        modalOpen: registrationModal.open,
        hasReadiness: hasVoteReadiness(voteResolution),
        submitting: voteBallot.submitting,
      })
    ) {
      return;
    }
    if (pendingAutoSubmitRef.current) return;

    pendingAutoSubmitRef.current = true;
    const snapshot = pendingVoteIntent?.choiceSnapshot || [];
    setRegistrationModal((previous) => ({ ...previous, status: 'submitting' }));

    void (async () => {
      const submitted = await submitVoteSnapshot(snapshot);

      if (submitted) {
        setPendingVoteIntent(null);
        closeRegistrationModal('submitted', { keepPending: true });
        pendingAutoSubmitRef.current = false;
        return;
      }

      setPendingVoteIntent(null);
      setRegistrationModal((previous) => ({ ...previous, status: 'error' }));
      setVoteStatusMessage(COPY.vote.status.autoSubmitFailed, true);
      pendingAutoSubmitRef.current = false;
    })();
  }, [
    closeRegistrationModal,
    pendingVoteIntent,
    registrationModal.open,
    setVoteStatusMessage,
    submitVoteSnapshot,
    voteBallot.submitting,
    voteResolution,
  ]);

  const lifecycle = formatVoteLifecycle(voteResolution);
  const processClosed = isVoteProcessClosed(voteResolution);
  const sequencerEligible = voteResolution.sequencerWeight > 0n;

  const hasStoredVoteId = Boolean(voteBallot.submissionId);
  const overwriteAllowed = canOverwriteVote(voteBallot);
  const answersEnabled = areVoteChoicesEnabled(voteResolution, voteBallot);
  const hasQuestion = Boolean(voteBallot.question);
  const selectedBallotChoice = voteBallot.choice;
  const hasAllChoices =
    hasQuestion &&
    Number.isInteger(selectedBallotChoice) &&
    Number(selectedBallotChoice) >= 0 &&
    (voteBallot.question?.choices || []).some((choice) => Number(choice.value) === selectedBallotChoice);
  const hasManagedWalletSigner = Boolean(
    managedWallet && (managedWallet.source === 'connected' ? connectedWallet?.signer : managedWallet.privateKey)
  );

  const canSubmitVote =
    Boolean(voteResolution.processId) &&
    hasManagedWalletSigner &&
    !processClosed &&
    hasQuestion &&
    hasAllChoices &&
    !voteBallot.submitting &&
    overwriteAllowed &&
    !registrationModal.open &&
    !pendingVoteIntent;

  const voteButtonLabel = voteBallot.submitting
    ? COPY.vote.buttons.submittingVote
    : processClosed
      ? COPY.vote.buttons.votingClosed
      : pendingVoteIntent
        ? COPY.vote.buttons.waitingForRegistration
        : hasStoredVoteId && isVoteStatusTerminal(voteBallot.submissionStatus)
          ? COPY.vote.buttons.submitVoteAgain
          : hasStoredVoteId
            ? COPY.vote.buttons.voteInProgress
            : COPY.vote.buttons.submitVote;

  const voteButtonIcon =
    voteBallot.submitting || pendingVoteIntent
      ? 'iconoir-refresh'
      : processClosed
        ? 'iconoir-lock'
        : hasVoteReadiness(voteResolution)
          ? 'iconoir-check'
          : 'iconoir-user-plus';

  const voteResultsVisible = Boolean(voteResolution.processId) && shouldShowVoteResults(voteResolution.statusCode);
  const voteResultsModel = useMemo(() => buildVoteResultsModel(voteResolution, voteBallot), [voteBallot, voteResolution]);
  const showRegistrationSubmittingNotice =
    registrationModal.status === 'submitting' || (hasVoteReadiness(voteResolution) && Boolean(pendingVoteIntent));
  const registrationManualCloseBlocked =
    registrationModal.open &&
    Boolean(pendingVoteIntent) &&
    (hasVoteReadiness(voteResolution) || voteBallot.submitting || registrationModal.status === 'submitting');
  const openIdentityFromRegistration = useCallback(() => {
    if (registrationManualCloseBlocked) return;
    closeRegistrationModal('close');
    setVoteIdentityOpen(true);
  }, [closeRegistrationModal, registrationManualCloseBlocked]);

  const registrationSteps = useMemo(() => {
    const onchainRequired = isOnchainReadinessRequired(voteResolution);
    const onchainReady = onchainRequired ? voteResolution.onchainWeight > 0n : true;
    const sequencerReady = voteResolution.sequencerWeight > 0n;
    const readyToVote = hasVoteReadiness(voteResolution);

    const steps: Array<{ id: string; label: string; description: string; done: boolean }> = [];

    if (onchainRequired) {
      steps.push({
        id: 'onchain',
        label: COPY.vote.registration.progressSteps.onchainLabel,
        description: COPY.vote.registration.progressSteps.onchainDescription,
        done: onchainReady,
      });
    }

    steps.push(
      {
        id: 'sequencer',
        label: COPY.vote.registration.progressSteps.sequencerLabel,
        description: COPY.vote.registration.progressSteps.sequencerDescription,
        done: sequencerReady,
      },
      {
        id: 'ready',
        label: COPY.vote.registration.progressSteps.readyLabel,
        description: COPY.vote.registration.progressSteps.readyDescription,
        done: readyToVote,
      }
    );

    return steps;
  }, [voteResolution]);

  const registrationCurrentId = registrationSteps.find((step) => !step.done)?.id || 'ready';

  const voteStatusFlow = (() => {
    const currentStatus = normalizeVoteStatus(voteBallot.submissionStatus) || (hasStoredVoteId ? 'pending' : '');
    const isError = currentStatus === 'error';
    const flow = (isError ? [...VOTE_STATUS_FLOW, 'error'] : [...VOTE_STATUS_FLOW]) as Array<VoteStatusKey>;
    const currentIndex = flow.indexOf(currentStatus as VoteStatusKey);

    return flow.map((status, index) => ({
      status,
      isCurrent: Boolean(hasStoredVoteId || currentStatus) && (isError ? status === 'error' : index === currentIndex),
      isComplete: !isError && currentIndex >= 0 && index < currentIndex,
      isError: isError && status === 'error',
      marker:
        (Boolean(hasStoredVoteId || currentStatus) && (isError ? status === 'error' : index === currentIndex) && voteBallot.submitting)
          ? 'spinner'
          : !isError && currentIndex >= 0 && (index < currentIndex || status === 'settled' && index === currentIndex)
            ? 'check'
            : isError && status === 'error'
              ? 'error'
              : String(index + 1),
    }));
  })();

  const voteSubmitResult = (() => {
    if (!hasStoredVoteId) return null;

    const normalizedStatus = normalizeVoteStatus(voteBallot.submissionStatus) || 'pending';
    const isErrorStatus = normalizedStatus === 'error';
    const isSettledStatus = normalizedStatus === 'settled';

    let title: string = COPY.vote.submitResult.receivedTitle;
    let description: string = COPY.vote.submitResult.receivedDescription;
    let iconClass: string = 'iconoir-check-circle';

    if (isSettledStatus) {
      title = COPY.vote.submitResult.finalizedTitle;
      description = COPY.vote.submitResult.finalizedDescription;
    } else if (isErrorStatus) {
      title = COPY.vote.submitResult.failedTitle;
      description = COPY.vote.submitResult.failedDescription;
      iconClass = 'iconoir-warning-circle';
    }

    return {
      isErrorStatus,
      title,
      description,
      iconClass,
      statusLabel: formatVoteStatusLabel(normalizedStatus),
    };
  })();

  const voteHeaderQuestionTitle = (() => {
    const questionTitle = String(voteBallot.question?.title || '').trim();
    if (questionTitle) return questionTitle;
    if (voteBallot.loading) return COPY.vote.header.loadingQuestion;
    return COPY.vote.header.chooseOption;
  })();

  const voteHeaderHelpText = voteResultsVisible ? (
    COPY.vote.header.resultsAvailable
  ) : (
    <>
      {COPY.vote.header.helpBeforeSelf}{' '}
      <a className="field-link" href="https://self.xyz" target="_blank" rel="noreferrer">
        Self.xyz
      </a>{' '}
      {COPY.vote.header.helpAfterSelf}
    </>
  );
  const voteSelfCountriesText =
    voteSelf.countries.length > 0 ? voteSelf.countries.join(', ') : voteSelf.country ? voteSelf.country : '-';
  const voteConfiguredDuration = formatDurationMs(extractProcessDurationMs(voteResolution.process, null));
  const voteRemainingTimeText = formatRemainingTimeFromEndMs(voteResolution.endDateMs);
  const showCopyPrivateKey = Boolean(managedWallet && managedWallet.source !== 'connected' && managedWallet.privateKey);
  const showRegistrationWalletAddress = Boolean(managedWallet && managedWallet.source !== 'derived' && managedWallet.address);
  const registrationWalletAddressLabel = showRegistrationWalletAddress ? shortenRegistrationWalletAddress(managedWallet?.address || '') : '';
  const connectWalletButtonLabel = walletConnectPending
    ? COPY.vote.buttons.connectingBrowserWallet
    : COPY.vote.buttons.connectBrowserWallet;

  return (
    <>
      <section id="voteView" className="view">
        <AppNavbar
          id="voteNavbar"
          brandId="voteNavbarBrand"
          baseHref={baseUrl}
          logoSrc={withBase('davinci_logo.png')}
          brandLabel={COPY.brand.appName}
          navLinks={navbarLinks}
        >
          <div className="vote-lifecycle-card vote-lifecycle-header-card vote-navbar-widget" id="voteLifecycleCard" hidden={!voteResolution.processId} data-state={lifecycle.stateKey}>
            <div className="vote-lifecycle-head">
              <div className="vote-lifecycle-left">
                <span className="vote-lifecycle-dot" aria-hidden="true" />
                <strong id="voteLifecycleTitle">{lifecycle.title}</strong>
              </div>
              <div className="vote-lifecycle-right">
                <span className="iconoir-clock" aria-hidden="true" />
                <span id="voteLifecycleLabel">{lifecycle.label}</span>
              </div>
            </div>
            <div className="vote-header-actions">
              <button
                id="showVoteDetailsBtn"
                type="button"
                className="cta-btn secondary"
                disabled={!voteResolution.processId}
                onClick={() => setVoteDetailsOpen(true)}
              >
                <span className="btn-icon iconoir-info-circle" aria-hidden="true" />
                <span className="btn-text">{COPY.vote.buttons.details}</span>
              </button>
              <button
                id="showIdentityInfoBtn"
                type="button"
                className="cta-btn secondary"
                disabled={!voteResolution.processId}
                onClick={() => setVoteIdentityOpen(true)}
              >
                <span className="btn-icon iconoir-user" aria-hidden="true" />
                <span className="btn-text">{COPY.vote.buttons.identity}</span>
              </button>
            </div>
          </div>
        </AppNavbar>

        <header className="app-header create-header vote-header question-hero-header" id="voteHeader">
          <h1 id="voteHeaderTitle" className="question-hero-title">
            {voteHeaderQuestionTitle}
          </h1>
          <p id="voteHeaderHelp" className="create-intro vote-help-text question-hero-helper">
            {voteHeaderHelpText}
          </p>
        </header>

        <PopupModal
          id="voteDetailsDialog"
          open={voteDetailsOpen}
          title={COPY.vote.dialogs.processDetailsTitle}
          titleId="voteDetailsDialogTitle"
          className="vote-popup vote-details-popup"
          cardClassName="vote-popup-card vote-details-popup-card"
          bodyClassName="vote-popup-body"
          closeButtonId="closeVoteDetailsBtn"
          closeLabel={COPY.vote.dialogs.processDetailsClose}
          onClose={() => setVoteDetailsOpen(false)}
        >
          <table className="details-table">
            <tbody>
              <tr>
                <th>{COPY.vote.dialogs.processId}</th>
                <td>
                  <code id="voteProcessId" className="output-scroll details-url-scroll">
                    {voteResolution.processId || '-'}
                  </code>
                </td>
              </tr>
              <tr>
                <th>{COPY.vote.dialogs.duration}</th>
                <td>
                  <strong id="voteProcessDuration">{voteConfiguredDuration}</strong>
                </td>
              </tr>
              <tr>
                <th>{COPY.vote.dialogs.censusContract}</th>
                <td>
                  <code id="voteCensusContract" className="output-scroll details-url-scroll">
                    {voteResolution.censusContract || '-'}
                  </code>
                </td>
              </tr>
              <tr>
                <th>{COPY.vote.dialogs.censusUri}</th>
                <td>
                  <span id="voteCensusUri" className="output-scroll details-url-scroll">
                    {voteResolution.censusUri || '-'}
                  </span>
                </td>
              </tr>
              <tr>
                <th>{COPY.vote.dialogs.sequencer}</th>
                <td>
                  <span id="voteSequencerUrl" className="output-scroll details-url-scroll">
                    {CONFIG.davinciSequencerUrl || '-'}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </PopupModal>

        <PopupModal
          id="voteIdentityDialog"
          open={voteIdentityOpen}
          title={COPY.vote.dialogs.managedIdentityTitle}
          titleId="voteIdentityDialogTitle"
          className="vote-popup vote-identity-popup"
          cardClassName="vote-popup-card vote-identity-popup-card"
          bodyClassName="vote-popup-body vote-identity-popup-body"
          closeButtonId="closeVoteIdentityBtn"
          closeLabel={COPY.vote.dialogs.managedIdentityClose}
          onClose={() => setVoteIdentityOpen(false)}
        >
          <div className="identity-dialog-content">
            <div className="identity-dialog-copy">
              <p>{COPY.vote.dialogs.identityIntroPrimary}</p>
              <p>{COPY.vote.dialogs.identityIntroSecondary}</p>
              <p>{COPY.vote.dialogs.identityIntroRisks}</p>
            </div>

            <section className="identity-wallet-panel" aria-labelledby="walletAddressLabel">
              <div className="identity-wallet-head">
                <label id="walletAddressLabel" className="identity-field-label" htmlFor="walletAddressInput">
                  {COPY.vote.dialogs.walletAddress}
                </label>
                <span id="walletSource" className="identity-source-tag" data-source={managedWalletSourceMeta.key}>
                  <span className={`identity-source-icon ${managedWalletSourceMeta.iconClass}`} aria-hidden="true" />
                  <span>{managedWalletSourceMeta.label}</span>
                </span>
              </div>

              <div className={`identity-address-row${showCopyPrivateKey ? ' has-action' : ''}`}>
                <input
                  id="walletAddressInput"
                  className="identity-address-input"
                  type="text"
                  readOnly
                  value={managedWallet?.address || ''}
                  placeholder="-"
                  title={managedWallet?.address || COPY.shared.unknown}
                />

                {showCopyPrivateKey && (
                  <button
                    id="copyKeyBtn"
                    type="button"
                    className="secondary identity-address-action"
                    onClick={async () => {
                      if (!managedWallet?.privateKey) return;
                      try {
                        await navigator.clipboard.writeText(managedWallet.privateKey);
                        setVoteStatusMessage(COPY.vote.dialogs.privateKeyCopied);
                      } catch {
                        setVoteStatusMessage(COPY.vote.dialogs.failedCopyPrivateKey, true);
                      }
                    }}
                  >
                    <span className="btn-icon iconoir-copy" aria-hidden="true" />
                    <span className="btn-text">{COPY.vote.buttons.copyPrivateKey}</span>
                  </button>
                )}
              </div>

              {managedWalletSourceMeta.helper ? <p className="identity-source-helper">{managedWalletSourceMeta.helper}</p> : null}

              {showCopyPrivateKey && <p className="muted danger identity-risk-copy">{COPY.vote.dialogs.warningKeyExposure}</p>}
            </section>

            <div className="identity-divider" aria-hidden="true" />

            <section className="identity-actions-section">
              <div className="identity-action-grid">
                <button
                  id="toggleImportKeyBtn"
                  type="button"
                  className={`cta-btn secondary identity-action-btn${showImportPanel ? ' is-active' : ''}`}
                  aria-expanded={showImportPanel}
                  aria-controls="identityImportPanel"
                  onClick={() => setShowImportPanel((previous) => !previous)}
                >
                  <span className="btn-icon iconoir-key" aria-hidden="true" />
                  <span className="btn-text">{COPY.vote.buttons.importKey}</span>
                </button>

                {managedWallet?.source === 'connected' ? (
                  <button
                    id="restoreLocalWalletBtn"
                    type="button"
                    className="cta-btn identity-action-btn identity-action-btn-muted"
                    disabled={!voteResolution.processId}
                    onClick={() => void restoreLocalManagedWallet()}
                  >
                    <span className="btn-icon iconoir-refresh" aria-hidden="true" />
                    <span className="btn-text">{COPY.vote.buttons.useLocalDerivedWallet}</span>
                  </button>
                ) : (
                  <button
                    id="connectBrowserWalletBtn"
                    type="button"
                    className="cta-btn identity-action-btn"
                    disabled={!voteResolution.processId || walletConnectPending}
                    onClick={() => void connectManagedBrowserWallet()}
                  >
                    <span className={`btn-icon ${walletConnectPending ? 'iconoir-refresh' : 'iconoir-wallet'}`} aria-hidden="true" />
                    <span className="btn-text">{connectWalletButtonLabel}</span>
                  </button>
                )}
              </div>

              <div id="identityImportPanel" className="identity-import-panel" hidden={!showImportPanel}>
                <label htmlFor="importKeyInput">{COPY.vote.dialogs.importPrivateKeyLabel}</label>
                <input
                  id="importKeyInput"
                  name="import_private_key"
                  spellCheck={false}
                  autoComplete="off"
                  type="password"
                  placeholder={COPY.vote.dialogs.importPrivateKeyPlaceholder}
                  value={importKey}
                  onChange={(event) => setImportKey(event.target.value)}
                />

                {importKeyPreview.address ? (
                  <div id="importedWalletAddressPreview" className="identity-import-preview">
                    <span className="identity-import-preview-label">{COPY.vote.dialogs.importPreviewAddress}</span>
                    <code>{importKeyPreview.address}</code>
                  </div>
                ) : importKeyPreview.error ? (
                  <p id="importKeyError" className="field-helper danger">
                    {importKeyPreview.error}
                  </p>
                ) : null}

                <div className="row identity-import-actions">
                  <button
                    id="importKeyBtn"
                    type="button"
                    className="secondary"
                    disabled={!importKeyPreview.address}
                    onClick={() => void importManagedPrivateKey()}
                  >
                    <span className="btn-icon iconoir-key" aria-hidden="true" />
                    <span className="btn-text">{COPY.vote.buttons.confirmImport}</span>
                  </button>
                </div>
              </div>
            </section>
          </div>
        </PopupModal>

        <article className="card vote-results-card" id="voteResultsCard" hidden={!voteResultsVisible}>
          <div className="vote-results-body">
            <section className="panel vote-results-summary">
              <p className="label">{COPY.vote.results.summaryTitle}</p>
              <div className="grid two vote-results-summary-grid">
                <div>
                  <p id="voteResultsTotalVotes" className="vote-results-summary-value">
                    {voteResultsModel.totalVotes}
                  </p>
                  <p className="muted">{COPY.vote.results.totalVotes}</p>
                </div>
                <div>
                  <p id="voteResultsChoicesWithVotes" className="vote-results-summary-value">
                    {voteResultsModel.choicesWithVotes}
                  </p>
                  <p className="muted">{COPY.vote.results.choicesWithVotes}</p>
                </div>
              </div>
            </section>

            <section className="panel vote-results-detail">
              <div className="vote-results-detail-head">
                <h4>{COPY.vote.results.detailedResults}</h4>
                <p id="voteResultsTotalVotesLabel" className="muted">
                  {COPY.vote.results.totalLabel(voteResultsModel.totalVotes)}
                </p>
              </div>

              <div id="voteResultsContent" className="vote-results-content">
                {!voteResultsModel.hasComputedResults && (
                  <div className="vote-results-empty">
                    <span className="timeline-spinner" aria-hidden="true" />
                    <span>{COPY.vote.results.computing}</span>
                  </div>
                )}

                {voteResultsModel.hasComputedResults && !voteResultsModel.choices.length && (
                  <div className="vote-results-empty">{COPY.vote.results.noMetadata}</div>
                )}

                {voteResultsModel.hasComputedResults && voteResultsModel.choices.length > 0 && (
                  <section className="vote-results-question">
                    {voteResultsModel.choices.map((choice, choiceIndex) => (
                      <div className="vote-results-choice" key={choiceIndex}>
                        <div className="vote-results-choice-head">
                          <p className="vote-results-choice-title">{choice.title}</p>
                          <p className="vote-results-choice-votes">{choice.votes}</p>
                        </div>
                        <div className="vote-results-choice-meta">
                          <p className="muted">
                            {formatVotePercent(choice.votes, voteResultsModel.totalVotes)} {COPY.vote.results.ofTotalVotes}
                          </p>
                          <p className="muted">{COPY.vote.results.rank(choice.rank)}</p>
                        </div>
                        <div className="vote-results-bar">
                          <span style={{ width: `${choice.percentage.toFixed(1)}%` }} />
                        </div>
                      </div>
                    ))}
                  </section>
                )}
              </div>
            </section>
          </div>
        </article>

        <article className="card vote-focus-card" id="voteBallotCard" hidden={voteResultsVisible}>
          <div id="voteQuestions" className="vote-questions">
            {!voteBallot.question && (
              <p className="muted">
                {voteBallot.loading ? COPY.vote.status.loadingQuestion : COPY.vote.status.noQuestionAvailable}
              </p>
            )}

            {voteBallot.question && (
              <fieldset className="vote-question-card">
                <legend className="vote-question-legend-hidden">
                  {voteBallot.question.title || COPY.vote.ballot.questionLegendFallback}
                </legend>

                {voteBallot.question.choices.map((choice, choiceIndex) => {
                  const checked = voteBallot.choice !== null && Number(voteBallot.choice) === Number(choice.value);
                  return (
                    <label className={`vote-choice ${checked ? 'is-selected' : ''} ${!answersEnabled ? 'is-disabled' : ''}`} key={choiceIndex}>
                      <input
                        type="radio"
                        name="vote-question"
                        value={choice.value}
                        checked={checked}
                        disabled={!answersEnabled}
                        onChange={() => {
                          setVoteBallot((previous) => ({
                            ...previous,
                            choice: Number(choice.value),
                          }));
                        }}
                      />
                      <span>{choice.title}</span>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>

          <div className="vote-submit-row">
            <button id="emitVoteBtn" type="button" className="cta-btn" disabled={!canSubmitVote} onClick={() => void emitVote()}>
              <span className={`btn-icon ${voteButtonIcon}`} aria-hidden="true" />
              <span className="btn-text">{voteButtonLabel}</span>
            </button>
            <div className="vote-submit-remaining" id="voteRemainingCard">
              <span className="vote-submit-remaining-label">{COPY.vote.ballot.timeUntilClose}</span>
              <strong id="voteProcessRemainingTime">{voteRemainingTimeText}</strong>
            </div>
          </div>

          <div className="vote-status-guide vote-submit-guide" id="voteStatusGuide" hidden={!hasStoredVoteId}>
            {voteSubmitResult && (
              <div id="voteSubmitResult" className={`vote-submit-result ${voteSubmitResult.isErrorStatus ? 'is-error' : ''}`}>
                <span id="voteSubmitResultIcon" className={`vote-submit-result-icon ${voteSubmitResult.iconClass}`} aria-hidden="true" />
                <div className="vote-submit-result-content">
                  <p id="voteSubmitResultTitle" className="vote-submit-result-title">
                    {voteSubmitResult.title}
                  </p>
                  <p id="voteSubmitResultText" className="muted">
                    {voteSubmitResult.description}
                  </p>
                </div>
              </div>
            )}

            <details id="voteStatusDetails" className="vote-status-details" open={voteStatusDetailsOpen}>
              <summary
                className="vote-status-details-summary"
                onClick={(event) => {
                  event.preventDefault();
                  setVoteStatusDetailsOpen((previous) => !previous);
                }}
              >
                <span className="vote-status-details-label-wrap">
                  <span className="vote-status-details-label">{COPY.vote.ballot.trackVoteStatus}</span>
                  <span id="voteStatusDetailsMeta" className="muted vote-status-details-meta">
                    {voteSubmitResult?.statusLabel || COPY.shared.pending}
                  </span>
                </span>
              </summary>

              <div className="vote-status-details-body">
                <div id="voteStatusFlowIdLine" className="vote-status-id-row" hidden={!hasStoredVoteId}>
                  <p className="label">{COPY.vote.ballot.voteId}</p>
                  <div className="vote-status-id-actions">
                    <code id="voteStatusFlowVoteId" className="output-scroll">
                      {voteBallot.submissionId || '-'}
                    </code>
                    <button
                      id="copyVoteStatusIdBtn"
                      type="button"
                      className="ghost"
                      disabled={!hasStoredVoteId}
                      onClick={async () => {
                        const voteId = String(voteBallot.submissionId || '').trim();
                        if (!voteId) return;
                        try {
                          await navigator.clipboard.writeText(voteId);
                          setCopyVoteIdLabel(COPY.shared.copied);
                        } catch {
                          setCopyVoteIdLabel(COPY.shared.error);
                        }
                        window.setTimeout(() => {
                          setCopyVoteIdLabel(COPY.shared.copy);
                        }, 1200);
                      }}
                    >
                      <span
                        className={`btn-icon ${
                          copyVoteIdLabel === COPY.shared.error
                            ? 'iconoir-warning-circle'
                            : copyVoteIdLabel === COPY.shared.copied
                              ? 'iconoir-check'
                              : 'iconoir-copy'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="btn-text">{copyVoteIdLabel}</span>
                    </button>
                  </div>
                </div>

                <ol id="voteStatusTimeline" className="vote-status-timeline">
                  {voteStatusFlow.map((entry) => (
                    <li
                      key={entry.status}
                      className={`vote-status-item ${entry.isComplete ? 'is-complete' : ''} ${entry.isCurrent ? 'is-current' : ''} ${
                        entry.isError ? 'is-error' : ''
                      }`}
                    >
                      <span className="vote-status-marker" aria-hidden="true">
                        {entry.marker === 'spinner' ? (
                          <span className="timeline-spinner" />
                        ) : entry.marker === 'check' ? (
                          '✓'
                        ) : entry.marker === 'error' ? (
                          '!'
                        ) : (
                          entry.marker
                        )}
                      </span>
                      <div className="vote-status-content">
                        <p className="vote-status-label">{VOTE_STATUS_INFO[entry.status].label}</p>
                        <p className="vote-status-description">{VOTE_STATUS_INFO[entry.status].description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          </div>
        </article>

      </section>

      <PopupModal
        id="voteRegistrationPopup"
        open={registrationModal.open}
        title={COPY.vote.registration.popupTitle}
        titleId="voteRegistrationPopupTitle"
        className="vote-popup vote-registration-popup"
        cardClassName="vote-popup-card vote-registration-card"
        bodyClassName="vote-popup-body vote-registration-popup-body"
        closeLabel={COPY.vote.registration.popupClose}
        eyebrow={COPY.vote.registration.popupEyebrow}
        onClose={
          registrationManualCloseBlocked
            ? undefined
            : () =>
                closeRegistrationModal('close', {
                  statusMessage: COPY.vote.status.popupClosed,
                })
        }
        backdropClosable={!registrationManualCloseBlocked}
      >
        <div className="self-registration-layout vote-registration-layout">
          {!registrationModal.isMobile && (
            <div className="vote-registration-qr-column">
              <div id="voteSelfQrWrap" className="self-qr-wrap" hidden={!voteSelf.selfApp}>
                <div id="voteSelfQrRoot" className="self-qr-root" aria-label={COPY.vote.registration.qrAria}>
                  {voteSelf.selfApp ? (
                    <SelfQRcodeWrapper
                      key={`${voteResolution.processId}-${voteSelf.link}`}
                      selfApp={voteSelf.selfApp}
                      type="deeplink"
                      size={280}
                      onSuccess={() => {
                        setVoteStatusMessage(COPY.vote.status.selfVerificationCompleted);
                        void refreshVoteReadiness();
                      }}
                      onError={(data: any = {}) => {
                        const reason = String(data.reason || data.error_code || '').trim();
                        setVoteStatusMessage(COPY.vote.status.selfQrError(reason), true);
                      }}
                    />
                  ) : (
                    <p className="muted">{COPY.vote.registration.preparingQr}</p>
                  )}
                </div>

                <button
                  id="copyVoteSelfLinkBtn"
                  type="button"
                  className="cta-btn secondary qr-copy-btn"
                  aria-label={COPY.vote.registration.copySelfLinkAria}
                  title={COPY.vote.registration.copySelfLinkTitle}
                  disabled={!voteSelf.link || processClosed}
                  onClick={() => void copyVoteSelfLink()}
                >
                  <span className="btn-icon iconoir-copy" aria-hidden="true" />
                  <span className="btn-text">{COPY.vote.buttons.copyLink}</span>
                </button>
              </div>

              <div className="vote-registration-requirements">
                <p className="label">{COPY.vote.registration.requirementsToVote}</p>
                <div className="vote-registration-requirements-grid">
                  <div className="vote-registration-requirement">
                    <p className="label">{COPY.vote.registration.minimumAge}</p>
                    <p className="value" id="voteSelfMinAgeInfo">
                      {voteSelf.minAge ? String(voteSelf.minAge) : '-'}
                    </p>
                  </div>
                  <div className="vote-registration-requirement">
                    <p className="label">{COPY.vote.registration.countries}</p>
                    <p className="value" id="voteCountryInfo">
                      {voteSelfCountriesText}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <aside className="panel self-steps-panel">
            <p className="label">{COPY.vote.registration.quickSteps}</p>
            <ol className={`self-registration-steps ${registrationModal.isMobile ? 'is-mobile' : ''}`}>
              <li>
                <p className="self-registration-step-title">
                  {registrationModal.isMobile ? COPY.vote.registration.openSelfApp : COPY.vote.registration.installSelfApp}
                </p>
                <p className="self-step-helper">
                  {registrationModal.isMobile ? (
                    <>
                      {COPY.vote.registration.mobileInstallHelpBeforeIos}{' '}
                      <a href="https://apps.apple.com/pl/app/self-zk-passport-identity/id6478563710" target="_blank" rel="noreferrer">
                        iOS
                      </a>{' '}
                      {COPY.vote.registration.mobileInstallHelpBetween}{' '}
                      <a
                        href="https://play.google.com/store/apps/details?id=com.proofofpassportapp&hl=en&pli=1"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Android
                      </a>
                      .
                    </>
                  ) : (
                    <>
                      {COPY.vote.registration.desktopInstallHelpBeforeIos}{' '}
                      <a href="https://apps.apple.com/pl/app/self-zk-passport-identity/id6478563710" target="_blank" rel="noreferrer">
                        iOS
                      </a>{' '}
                      {COPY.vote.registration.desktopInstallHelpBetween}{' '}
                      <a
                        href="https://play.google.com/store/apps/details?id=com.proofofpassportapp&hl=en&pli=1"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Android
                      </a>
                      .
                    </>
                  )}
                </p>
              </li>
              <li>
                <p className="self-registration-step-title">
                  {registrationModal.isMobile ? COPY.vote.registration.verifyMobile : COPY.vote.registration.verifyDesktop}
                </p>
                <p className="self-step-helper">
                  {registrationModal.isMobile
                    ? COPY.vote.registration.verifyMobileHelper
                    : COPY.vote.registration.verifyDesktopHelper}
                </p>
              </li>
              <li>
                <p className="self-registration-step-title">
                  {registrationModal.isMobile ? COPY.vote.registration.finishMobile : COPY.vote.registration.finishDesktop}
                </p>
                <p className="self-step-helper">
                  {registrationModal.isMobile
                    ? COPY.vote.registration.finishMobileHelper
                    : COPY.vote.registration.finishDesktopHelper}
                </p>
              </li>
            </ol>

            {registrationModal.isMobile && (
              <div id="voteSelfQrActions" className="row self-qr-actions">
                <button
                  id="openVoteSelfLinkBtn"
                  type="button"
                  className="cta-btn"
                  disabled={!voteSelf.link || processClosed}
                  onClick={openVoteSelfLink}
                >
                  <span className="btn-icon iconoir-link" aria-hidden="true" />
                  <span className="btn-text">{COPY.vote.buttons.openInSelfApp}</span>
                </button>
              </div>
            )}

            {registrationModal.isMobile && (
              <div className="vote-registration-requirements">
                <p className="label">{COPY.vote.registration.requirementsToVote}</p>
                <div className="vote-registration-requirements-grid">
                  <div className="vote-registration-requirement">
                    <p className="label">{COPY.vote.registration.minimumAge}</p>
                    <p className="value" id="voteSelfMinAgeInfo">
                      {voteSelf.minAge ? String(voteSelf.minAge) : '-'}
                    </p>
                  </div>
                  <div className="vote-registration-requirement">
                    <p className="label">{COPY.vote.registration.countries}</p>
                    <p className="value" id="voteCountryInfo">
                      {voteSelfCountriesText}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="vote-status-guide registration-status-guide" id="registrationStatusGuide">
              <p className="label">{COPY.vote.registration.registrationProgress}</p>
              <ol id="registrationStatusTimeline" className="vote-status-timeline">
                {registrationSteps.map((step, index) => {
                  const isComplete = step.done;
                  const isCurrent = !isComplete && step.id === registrationCurrentId;
                  return (
                    <li key={step.id} className={`vote-status-item ${isComplete ? 'is-complete' : ''} ${isCurrent ? 'is-current' : ''}`}>
                      <span className="vote-status-marker" aria-hidden="true">
                        {isCurrent ? <span className="timeline-spinner" /> : isComplete ? '✓' : String(index + 1)}
                      </span>
                      <div className="vote-status-content">
                        <p className="vote-status-label">{step.label}</p>
                        <p className="vote-status-description">{step.description}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </aside>
        </div>
        {managedWallet && (
          <div className="vote-registration-footer">
            <button
              id="registrationWalletWidget"
              type="button"
              className="registration-wallet-widget"
              aria-controls="voteIdentityDialog"
              aria-haspopup="dialog"
              disabled={registrationManualCloseBlocked}
              onClick={openIdentityFromRegistration}
            >
              <span className="identity-source-tag" data-source={managedWalletSourceMeta.key}>
                <span className={`identity-source-icon ${managedWalletSourceMeta.iconClass}`} aria-hidden="true" />
                <span>{managedWalletSourceMeta.label}</span>
                {showRegistrationWalletAddress && (
                  <code className="registration-wallet-source-address" title={managedWallet.address}>
                    {registrationWalletAddressLabel}
                  </code>
                )}
              </span>
            </button>
          </div>
        )}
        {showRegistrationSubmittingNotice && (
          <p className="vote-registration-submit-note" role="status" aria-live="polite">
            <span className="timeline-spinner" aria-hidden="true" />
            <span>{COPY.vote.registration.registrationCompletedSubmitting}</span>
          </p>
        )}
      </PopupModal>

      <PopupModal
        id="voteContextGatePopup"
        open={contextBlocked}
        role="alertdialog"
        title={COPY.vote.context.popupTitle}
        titleId="voteContextGatePopupTitle"
        descriptionId="voteContextGatePopupMessage"
        className="vote-popup vote-context-popup"
        cardClassName="vote-popup-card vote-context-popup-card"
        bodyClassName="vote-popup-body vote-context-popup-body"
        closeLabel={COPY.vote.context.popupClose}
        eyebrow={COPY.vote.context.popupEyebrow}
        onClose={closeContextGatePopup}
      >
        <p id="voteContextGatePopupMessage">{contextMessage}</p>
      </PopupModal>
    </>
  );
}
