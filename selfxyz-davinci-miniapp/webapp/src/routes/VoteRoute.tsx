import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wallet } from 'ethers';
import { useParams } from 'react-router-dom';
import { ProcessStatus } from '@vocdoni/davinci-sdk';
import { SelfAppBuilder, SelfQRcodeWrapper } from '@selfxyz/qrcode';

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
  clearWalletOverride,
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
import { isValidProcessId, normalizeCountry, normalizeMinAge, normalizeProcessId, normalizeScope } from '../utils/normalization';
import { ethCall, fetchOnchainWeight } from '../services/readiness';
import {
  createSequencerSdk,
  fetchProcessMetadata,
  fetchSequencerWeight,
  getProcessFromSequencer,
} from '../services/sequencer';
import AppNavbar from '../components/AppNavbar';
import PopupModal from '../components/PopupModal';
import { detectRegistrationMobileMode } from './vote/device';
import { createPendingVoteIntent, evaluateVoteSubmitGate, shouldAutoSubmitPendingVote } from './vote/submitFlow';
import type { PendingVoteIntent, RegistrationModalState } from './vote/types';

interface ManagedWalletSnapshot {
  address: string;
  privateKey: string;
  source: 'derived' | 'imported';
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
    return 'This process is in results stage. Registration and voting are closed.';
  }
  if (statusCode === ProcessStatus.ENDED || hasProcessEndedByTime(resolution.endDateMs)) {
    return 'This process has ended. Registration and voting are closed.';
  }
  if (statusCode === ProcessStatus.PAUSED) {
    return 'This process is paused. Registration and voting are closed.';
  }
  if (statusCode === ProcessStatus.CANCELED) {
    return 'This process was canceled. Registration and voting are closed.';
  }
  if (!resolution.isAcceptingVotes) {
    return 'This process is not accepting votes yet.';
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
    if (!/^[A-Z]{2,3}$/.test(country)) continue;
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
  let title = statusInfo?.title || 'Vote Active';
  let label = statusInfo?.label || 'Active';
  let description = statusInfo?.description || 'Voting is open while this process remains active.';

  if (!statusInfo && !resolution.isAcceptingVotes) {
    stateKey = 'paused';
    title = 'Vote Pending';
    label = 'Not started';
    description = 'This process is not accepting votes yet.';
  }

  if (endedByTime && stateKey === 'ready') {
    stateKey = 'ended';
    title = 'Vote Ended';
    label = 'Ended';
    description = 'Voting time has ended. Registration and voting are closed.';
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

export default function VoteRoute() {
  const params = useParams();
  const baseUrl = import.meta.env.BASE_URL || '/';
  const withBase = useCallback((file: string) => buildAssetUrl(file), []);

  const [contextBlocked, setContextBlocked] = useState(false);
  const [contextMessage, setContextMessage] = useState(
    'A valid process ID is required to use this app. Please request the complete /vote/:processId link from the person or team that shared this app.'
  );

  const [voteResolution, setVoteResolution] = useState<VoteResolutionState>(EMPTY_RESOLUTION);
  const [managedWallet, setManagedWallet] = useState<ManagedWalletSnapshot | null>(null);
  const [privateVisible, setPrivateVisible] = useState(false);
  const [voteSelf, setVoteSelf] = useState<VoteSelfState>(EMPTY_VOTE_SELF);
  const [voteBallot, setVoteBallot] = useState<VoteBallotState>(EMPTY_BALLOT);
  const [importKey, setImportKey] = useState('');
  const [voteDetailsOpen, setVoteDetailsOpen] = useState(false);
  const [voteIdentityOpen, setVoteIdentityOpen] = useState(false);
  const [registrationModal, setRegistrationModal] = useState<RegistrationModalState>(EMPTY_REGISTRATION_MODAL);
  const [pendingVoteIntent, setPendingVoteIntent] = useState<PendingVoteIntent | null>(null);
  const [voteStatusDetailsOpen, setVoteStatusDetailsOpen] = useState(false);
  const [copyVoteIdLabel, setCopyVoteIdLabel] = useState('Copy');

  const votePollRef = useRef<number | null>(null);
  const pendingAutoSubmitRef = useRef(false);
  const registrationQrRequestKeyRef = useRef('');
  const resolutionRef = useRef(voteResolution);
  const managedWalletRef = useRef(managedWallet);
  const voteSelfRef = useRef(voteSelf);
  const voteBallotRef = useRef(voteBallot);

  useEffect(() => {
    resolutionRef.current = voteResolution;
  }, [voteResolution]);
  useEffect(() => {
    managedWalletRef.current = managedWallet;
  }, [managedWallet]);
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

  const setVoteStatusMessage = useCallback((_message: string, _error = false) => {}, []);

  const stopVotePolling = useCallback(() => {
    if (votePollRef.current) {
      window.clearInterval(votePollRef.current);
      votePollRef.current = null;
    }
  }, []);

  const refreshVoteReadiness = useCallback(async () => {
    const resolution = resolutionRef.current;
    const processId = resolution.processId;
    const contractAddress = resolution.censusContract;
    const wallet = managedWalletRef.current;
    const managedAddress = wallet?.address || '';

    if (!processId) {
      setVoteResolution((previous) => ({ ...previous, readinessCheckedAt: null }));
      return;
    }

    if (resolution.sdk) {
      try {
        const latestProcess = await getProcessFromSequencer(resolution.sdk, processId);
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
      const sequencerWeight = await fetchSequencerWeight(resolution.sdk, processId, managedAddress);
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

  const bootstrapVoteManagedWallet = useCallback(
    (processId: string) => {
      const normalizedProcessId = normalizeProcessId(processId);
      if (!normalizedProcessId) {
        setManagedWallet(null);
        setPrivateVisible(false);
        return;
      }

      const wallet = loadManagedWallet(normalizedProcessId);
      setManagedWallet(wallet);
      setPrivateVisible(false);

      setVoteBallot((previous) => ({
        ...previous,
        submissionId: '',
        submissionStatus: '',
        hasVoted: false,
        statusWatcherToken: previous.statusWatcherToken + 1,
      }));

      restoreVoteSubmissionFromStorage(normalizedProcessId, wallet.address);
    },
    [restoreVoteSubmissionFromStorage]
  );

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

  const clearVoteBallot = useCallback((message?: string) => {
    setVoteBallot((previous) => ({
      ...EMPTY_BALLOT,
      statusWatcherToken: previous.statusWatcherToken + 1,
    }));
    if (message) setVoteStatusMessage(message);
  }, [setVoteStatusMessage]);

  const resetVoteResolution = useCallback(() => {
    stopVotePolling();
    setVoteResolution(EMPTY_RESOLUTION);
    setVoteSelf(EMPTY_VOTE_SELF);
    clearVoteBallot();
    setPendingVoteIntent(null);
    setRegistrationModal(EMPTY_REGISTRATION_MODAL);
    setVoteDetailsOpen(false);
    setVoteIdentityOpen(false);
    setVoteStatusMessage('Resolve process and managed wallet before generating Self QR.');
  }, [clearVoteBallot, setVoteStatusMessage, stopVotePolling]);

  const loadVoteQuestions = useCallback(
    async (process: any, metadata: any) => {
      clearVoteBallot('Loading process question...');
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
          setVoteStatusMessage('No vote question was found in this process.', true);
          return;
        }

        if (resolvedQuestions.length > 1) {
          setVoteStatusMessage('This app supports one question only. Showing the first question.');
        }
      } catch (error) {
        clearVoteBallot(error instanceof Error ? error.message : 'Failed to load process question.');
        setVoteStatusMessage(error instanceof Error ? error.message : 'Failed to load process question.', true);
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
        setVoteStatusMessage('This identity wallet already has a vote in sequencer. You can submit again to overwrite it.');
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
          setVoteStatusMessage(`Vote submitted. Current status: ${statusLabel}.`);

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
      const fallbackMetaCountries = /^[A-Z]{2,3}$/.test(metaCountry) ? [metaCountry] : [];
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
        setVoteStatusMessage('Enter a process ID to resolve it.');
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
      clearVoteBallot('Resolving process...');

      if (!silent) {
        setVoteStatusMessage('Resolving process from sequencer...');
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

        await refreshVoteReadiness();
        await refreshHasVotedFlag();
        startVotePolling();

        if (!silent) {
          setVoteStatusMessage('Process resolved. Readiness checks are active.');
        }
      } catch (error) {
        console.error('[OpenCitizenCensus] Failed to resolve process', error);
        resetVoteResolution();
        setVoteStatusMessage(error instanceof Error ? error.message : 'Failed to resolve process.', true);
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
      setVoteStatusMessage('Resolve process and managed wallet before generating Self QR.', true);
      return;
    }
    if (!scopeSeed) {
      setVoteStatusMessage('Scope seed is required to generate Self QR.', true);
      return;
    }
    if (!/^[\x00-\x7F]+$/.test(scopeSeed) || scopeSeed.length > 31) {
      setVoteStatusMessage('Scope seed must be ASCII and up to 31 characters.', true);
      return;
    }

    persistVoteScopeSeed(processId, scopeSeed);

    setVoteSelf((previous) => ({ ...previous, generating: true, scopeSeed }));

    try {
      if (!auto) {
        setVoteStatusMessage('Generating Self QR...');
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
        appName: CONFIG.selfAppName || 'Ask The World - DAVINCI',
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
        setVoteStatusMessage('Self QR ready. Complete verification in Self and wait for readiness to turn Yes.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate Self QR.';
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
      setVoteStatusMessage('Self link copied to clipboard.');
    } catch {
      setVoteStatusMessage('Failed to copy Self link.', true);
    }
  }, [setVoteStatusMessage]);

  const openVoteSelfLink = useCallback(() => {
    const link = voteSelfRef.current.link;
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
  }, []);

  const submitVoteSnapshot = useCallback(
    async (choices: number[]): Promise<boolean> => {
      if (voteBallotRef.current.submitting) return false;

      const resolution = resolutionRef.current;
      const ballot = voteBallotRef.current;
      const wallet = managedWalletRef.current;
      const processId = resolution.processId;

      if (!processId || !wallet?.privateKey) {
        setVoteStatusMessage('Resolve process and managed wallet before submitting vote.', true);
        return false;
      }
      if (isVoteProcessClosed(resolution)) {
        setVoteStatusMessage(getClosedProcessMessage(resolution), true);
        return false;
      }
      if (!hasVoteReadiness(resolution)) {
        const message = isOnchainReadinessRequired(resolution)
          ? 'Registration still pending. Wait until Onchain and Sequencer readiness are both Yes.'
          : 'Registration still pending. Wait until Sequencer readiness is Yes.';
        setVoteStatusMessage(message, true);
        return false;
      }
      if (!canOverwriteVote(ballot)) {
        setVoteStatusMessage('Current vote is still processing. Wait until status becomes Settled or Error before overwriting.', true);
        return false;
      }

      const censusUrl = trimTrailingSlash(CONFIG.onchainIndexerUrl);
      if (!censusUrl) {
        setVoteStatusMessage('Missing census URL config for vote proof generation.', true);
        return false;
      }

      try {
        setVoteBallot((previous) => ({ ...previous, submitting: true }));
        setVoteStatusMessage('Submitting vote...');

        const sdk = createSequencerSdk({
          signer: new Wallet(wallet.privateKey),
          sequencerUrl: CONFIG.davinciSequencerUrl,
          censusUrl,
        });
        await sdk.init();

        const result = await sdk.submitVote({ processId, choices });
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
        setVoteStatusMessage('Vote submitted successfully.');

        const watcherToken = voteBallotRef.current.statusWatcherToken + 1;
        setVoteBallot((previous) => ({ ...previous, statusWatcherToken: watcherToken }));
        void trackVoteSubmissionStatus(sdk, processId, voteId, watcherToken, wallet.address);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to submit vote.';
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
    [setVoteStatusMessage, trackVoteSubmissionStatus]
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
        hasWalletPrivateKey: Boolean(wallet?.privateKey),
        isProcessClosed: isVoteProcessClosed(resolution),
        hasQuestion,
        hasAllChoices: hasAllSelectedChoices,
        canOverwriteVote: canOverwriteVote(ballot),
        hasVoteReadiness: hasVoteReadiness(resolution),
      },
      {
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
      setVoteStatusMessage(error instanceof Error ? error.message : 'Select one option before submitting.', true);
      return;
    }

    if (gate.result === 'ready') {
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
    setVoteStatusMessage('Registration required. Complete Self verification and your vote will submit automatically.');

    if (!voteSelfRef.current.link && !voteSelfRef.current.generating) {
      void generateVoteSelfQr(true);
    }
  }, [pendingVoteIntent, setVoteStatusMessage, submitVoteSnapshot]);

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
    setVoteStatusMessage('A valid /vote/:processId link is required to continue.', true);
  }, [setVoteStatusMessage]);

  useEffect(() => {
    setVoteStatusDetailsOpen(false);
  }, [voteBallot.submissionId]);

  useEffect(() => {
    const rawSegment = decodeURIComponent(String(params.processId || '')).trim();

    if (!rawSegment) {
      const message = 'Missing process ID in URL. Open the complete /vote/:processId link shared for this process.';
      setContextBlocked(true);
      setContextMessage(message);
      resetVoteResolution();
      setVoteStatusMessage(message, true);
      return;
    }

    const normalized = normalizeProcessId(rawSegment);
    if (!isValidProcessId(normalized)) {
      const message = 'Invalid process ID in URL. Open a valid /vote/:processId link to use this app.';
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
    if (voteSelf.generating || voteSelf.link) return;

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
    voteSelf.link,
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
        statusMessage: 'Process changed while registration was pending. Submit vote again for this process.',
      });
    }
  }, [closeRegistrationModal, pendingVoteIntent, voteResolution.processId]);

  useEffect(() => {
    if (!pendingVoteIntent) return;
    const activeWalletAddress = String(managedWallet?.address || '').toLowerCase();
    if (!activeWalletAddress || pendingVoteIntent.walletAddress.toLowerCase() !== activeWalletAddress) {
      closeRegistrationModal('wallet_changed', {
        statusMessage: 'Managed wallet changed while registration was pending. Submit vote again.',
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
      setVoteStatusMessage('Vote was not submitted after registration. Review the error and click submit vote again.', true);
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

  const canSubmitVote =
    Boolean(voteResolution.processId) &&
    Boolean(managedWallet?.privateKey) &&
    !processClosed &&
    hasQuestion &&
    hasAllChoices &&
    !voteBallot.submitting &&
    overwriteAllowed &&
    !registrationModal.open &&
    !pendingVoteIntent;

  const voteButtonLabel = voteBallot.submitting
    ? 'Submitting vote...'
    : processClosed
      ? 'Voting closed'
      : pendingVoteIntent
        ? 'Waiting for registration...'
        : hasStoredVoteId && isVoteStatusTerminal(voteBallot.submissionStatus)
          ? 'Submit vote again'
          : hasStoredVoteId
            ? 'Vote in progress'
            : 'Submit vote';

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

  const registrationSteps = useMemo(() => {
    const onchainRequired = isOnchainReadinessRequired(voteResolution);
    const onchainReady = onchainRequired ? voteResolution.onchainWeight > 0n : true;
    const sequencerReady = voteResolution.sequencerWeight > 0n;
    const readyToVote = hasVoteReadiness(voteResolution);

    const steps: Array<{ id: string; label: string; description: string; done: boolean }> = [];

    if (onchainRequired) {
      steps.push({
        id: 'onchain',
        label: 'Onchain census inclusion',
        description: 'After Self verification, this step completes when onchain weight is greater than zero.',
        done: onchainReady,
      });
    }

    steps.push(
      {
        id: 'sequencer',
        label: 'Sequencer census inclusion',
        description: 'This step completes when sequencer weight is greater than zero.',
        done: sequencerReady,
      },
      {
        id: 'ready',
        label: 'Ready to submit',
        description: 'Vote submission unlocks as soon as readiness checks pass.',
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

    let title = 'Vote successfully received';
    let description = 'Your vote is secured and being finalized.';
    let iconClass = 'iconoir-check-circle';

    if (isSettledStatus) {
      title = 'Vote finalized successfully';
      description = 'Your vote has been fully settled.';
    } else if (isErrorStatus) {
      title = 'Vote processing failed';
      description = 'Processing failed for this vote. Expand the panel for details and try again if needed.';
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
    if (voteBallot.loading) return 'Loading question...';
    return 'Choose an option';
  })();

  const voteHeaderHelpText = voteResultsVisible ? (
    'Results are available for this process.'
  ) : (
    <>
      Choose an option, register with the{' '}
      <a className="field-link" href="https://self.xyz" target="_blank" rel="noreferrer">
        Self.xyz
      </a>{' '}
      app to join the census, and then submit your vote.
    </>
  );
  const voteSelfCountriesText =
    voteSelf.countries.length > 0 ? voteSelf.countries.join(', ') : voteSelf.country ? voteSelf.country : '-';
  const voteConfiguredDuration = formatDurationMs(extractProcessDurationMs(voteResolution.process, null));
  const voteRemainingTimeText = formatRemainingTimeFromEndMs(voteResolution.endDateMs);

  return (
    <>
      <section id="voteView" className="view">
        <AppNavbar
          id="voteNavbar"
          brandId="voteNavbarBrand"
          baseHref={baseUrl}
          logoSrc={withBase('davinci_logo.png')}
          brandLabel="Ask The World"
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
                <span className="btn-text">Details</span>
              </button>
              <button
                id="showIdentityInfoBtn"
                type="button"
                className="cta-btn secondary"
                disabled={!voteResolution.processId}
                onClick={() => setVoteIdentityOpen(true)}
              >
                <span className="btn-icon iconoir-user" aria-hidden="true" />
                <span className="btn-text">Identity</span>
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
          title="Process Details"
          titleId="voteDetailsDialogTitle"
          className="vote-popup vote-details-popup"
          cardClassName="vote-popup-card vote-details-popup-card"
          bodyClassName="vote-popup-body"
          closeButtonId="closeVoteDetailsBtn"
          closeLabel="Close process details popup"
          onClose={() => setVoteDetailsOpen(false)}
        >
          <table className="details-table">
            <tbody>
              <tr>
                <th>Process ID</th>
                <td>
                  <code id="voteProcessId" className="output-scroll details-url-scroll">
                    {voteResolution.processId || '-'}
                  </code>
                </td>
              </tr>
              <tr>
                <th>Duration</th>
                <td>
                  <strong id="voteProcessDuration">{voteConfiguredDuration}</strong>
                </td>
              </tr>
              <tr>
                <th>Census contract</th>
                <td>
                  <code id="voteCensusContract" className="output-scroll details-url-scroll">
                    {voteResolution.censusContract || '-'}
                  </code>
                </td>
              </tr>
              <tr>
                <th>Census URI</th>
                <td>
                  <span id="voteCensusUri" className="output-scroll details-url-scroll">
                    {voteResolution.censusUri || '-'}
                  </span>
                </td>
              </tr>
              <tr>
                <th>Sequencer</th>
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
          title="Managed Identity Wallet"
          titleId="voteIdentityDialogTitle"
          className="vote-popup vote-identity-popup"
          cardClassName="vote-popup-card vote-identity-popup-card"
          bodyClassName="vote-popup-body vote-identity-popup-body"
          closeButtonId="closeVoteIdentityBtn"
          closeLabel="Close identity popup"
          onClose={() => setVoteIdentityOpen(false)}
        >
          <div className="identity-dialog-content">
            <p>
              Address: <code id="walletAddress">{managedWallet?.address || '-'}</code>
            </p>
            <p>
              Source: <span id="walletSource">{managedWallet?.source || '-'}</span>
            </p>

            <div className="row">
              <button
                id="revealKeyBtn"
                type="button"
                className="secondary"
                onClick={() => {
                  if (!managedWallet) return;
                  if (!privateVisible) {
                    const confirmed = window.confirm('Revealing this key exposes signing authority. Continue?');
                    if (!confirmed) return;
                  }
                  setPrivateVisible((previous) => !previous);
                }}
              >
                <span className="btn-icon iconoir-eye" aria-hidden="true" />
                <span className="btn-text">{privateVisible ? 'Hide private key' : 'Reveal private key'}</span>
              </button>
              <button
                id="copyKeyBtn"
                type="button"
                className="secondary"
                disabled={!managedWallet || !privateVisible}
                onClick={async () => {
                  if (!managedWallet || !privateVisible) return;
                  try {
                    await navigator.clipboard.writeText(managedWallet.privateKey);
                    setVoteStatusMessage('Private key copied to clipboard.');
                  } catch {
                    setVoteStatusMessage('Failed to copy private key.', true);
                  }
                }}
              >
                <span className="btn-icon iconoir-copy" aria-hidden="true" />
                <span className="btn-text">Copy private key</span>
              </button>
            </div>

            <div id="walletSecretBox" hidden={!privateVisible || !managedWallet}>
              <code id="walletPrivateKey">{privateVisible && managedWallet ? managedWallet.privateKey : 'hidden'}</code>
            </div>

            <label>
              Import private key
              <input
                id="importKeyInput"
                name="import_private_key"
                spellCheck={false}
                autoComplete="off"
                type="password"
                placeholder="0xabc…"
                value={importKey}
                onChange={(event) => setImportKey(event.target.value)}
              />
            </label>

            <div className="row">
              <button
                id="importKeyBtn"
                type="button"
                className="secondary"
                onClick={() => {
                  const processId = resolutionRef.current.processId;
                  if (!processId) {
                    setVoteStatusMessage('Open /vote/:processId before importing a key.', true);
                    return;
                  }

                  let normalizedKey = '';
                  try {
                    normalizedKey = String(importKey || '').trim();
                    if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedKey)) {
                      throw new Error('Private key must be 0x-prefixed 64 hex chars.');
                    }
                    // eslint-disable-next-line no-new
                    new Wallet(normalizedKey);
                  } catch (error) {
                    setVoteStatusMessage(error instanceof Error ? error.message : 'Invalid private key.', true);
                    return;
                  }

                  const confirmed = window.confirm('Importing this key will replace the derived key for this process. Continue?');
                  if (!confirmed) return;

                  setWalletOverride(processId, normalizedKey);
                  setImportKey('');
                  bootstrapVoteManagedWallet(processId);
                  void refreshVoteReadiness();
                  void refreshHasVotedFlag();
                  setVoteStatusMessage('Imported key applied for this process.');
                }}
              >
                <span className="btn-icon iconoir-key" aria-hidden="true" />
                <span className="btn-text">Import key</span>
              </button>

              <button
                id="clearImportedKeyBtn"
                type="button"
                className="ghost"
                onClick={() => {
                  const processId = resolutionRef.current.processId;
                  if (!processId) {
                    setVoteStatusMessage('Open /vote/:processId before resetting key.', true);
                    return;
                  }

                  clearWalletOverride(processId);
                  bootstrapVoteManagedWallet(processId);
                  void refreshVoteReadiness();
                  void refreshHasVotedFlag();
                  setVoteStatusMessage('Derived key restored for this process.');
                }}
              >
                <span className="btn-icon iconoir-refresh" aria-hidden="true" />
                <span className="btn-text">Use derived key</span>
              </button>
            </div>

            <p className="muted danger">Warning: revealing or importing keys exposes signing authority for this process context.</p>
          </div>
        </PopupModal>

        <article className="card vote-results-card" id="voteResultsCard" hidden={!voteResultsVisible}>
          <div className="vote-results-body">
            <section className="panel vote-results-summary">
              <p className="label">Vote Summary</p>
              <div className="grid two vote-results-summary-grid">
                <div>
                  <p id="voteResultsTotalVotes" className="vote-results-summary-value">
                    {voteResultsModel.totalVotes}
                  </p>
                  <p className="muted">Total votes</p>
                </div>
                <div>
                  <p id="voteResultsChoicesWithVotes" className="vote-results-summary-value">
                    {voteResultsModel.choicesWithVotes}
                  </p>
                  <p className="muted">Choices with votes</p>
                </div>
              </div>
            </section>

            <section className="panel vote-results-detail">
              <div className="vote-results-detail-head">
                <h4>Detailed Results</h4>
                <p id="voteResultsTotalVotesLabel" className="muted">
                  Total: {voteResultsModel.totalVotes} vote{voteResultsModel.totalVotes === 1 ? '' : 's'}
                </p>
              </div>

              <div id="voteResultsContent" className="vote-results-content">
                {!voteResultsModel.hasComputedResults && (
                  <div className="vote-results-empty">
                    <span className="timeline-spinner" aria-hidden="true" />
                    <span>Computing results</span>
                  </div>
                )}

                {voteResultsModel.hasComputedResults && !voteResultsModel.choices.length && (
                  <div className="vote-results-empty">No question metadata available for this process.</div>
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
                          <p className="muted">{formatVotePercent(choice.votes, voteResultsModel.totalVotes)} of total votes</p>
                          <p className="muted">Rank #{choice.rank}</p>
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
              <p className="muted">{voteBallot.loading ? 'Loading process question...' : 'No question available for this process.'}</p>
            )}

            {voteBallot.question && (
              <fieldset className="vote-question-card">
                <legend className="vote-question-legend-hidden">{voteBallot.question.title || 'Question'}</legend>

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
              <span className="vote-submit-remaining-label">Time until close</span>
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
                  <span className="vote-status-details-label">Track vote status</span>
                  <span id="voteStatusDetailsMeta" className="muted vote-status-details-meta">
                    {voteSubmitResult?.statusLabel || 'Pending'}
                  </span>
                </span>
              </summary>

              <div className="vote-status-details-body">
                <div id="voteStatusFlowIdLine" className="vote-status-id-row" hidden={!hasStoredVoteId}>
                  <p className="label">Vote ID</p>
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
                          setCopyVoteIdLabel('Copied');
                        } catch {
                          setCopyVoteIdLabel('Error');
                        }
                        window.setTimeout(() => {
                          setCopyVoteIdLabel('Copy');
                        }, 1200);
                      }}
                    >
                      <span className={`btn-icon ${copyVoteIdLabel === 'Error' ? 'iconoir-warning-circle' : copyVoteIdLabel === 'Copied' ? 'iconoir-check' : 'iconoir-copy'}`} aria-hidden="true" />
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
        title="Complete Self verification to continue"
        titleId="voteRegistrationPopupTitle"
        className="vote-popup vote-registration-popup"
        cardClassName="vote-popup-card vote-registration-card"
        bodyClassName="vote-popup-body vote-registration-popup-body"
        closeLabel="Close registration popup"
        eyebrow="Registration required"
        onClose={
          registrationManualCloseBlocked
            ? undefined
            : () =>
                closeRegistrationModal('close', {
                  statusMessage: 'Registration popup closed. Click submit vote again when you are ready.',
                })
        }
        backdropClosable={!registrationManualCloseBlocked}
      >
        <div className="self-registration-layout vote-registration-layout">
          {!registrationModal.isMobile && (
            <div className="vote-registration-qr-column">
              <div id="voteSelfQrWrap" className="self-qr-wrap" hidden={!voteSelf.selfApp}>
                <div id="voteSelfQrRoot" className="self-qr-root" aria-label="Self registration QR code">
                  {voteSelf.selfApp ? (
                    <SelfQRcodeWrapper
                      key={`${voteResolution.processId}-${voteSelf.link}`}
                      selfApp={voteSelf.selfApp}
                      type="deeplink"
                      size={280}
                      onSuccess={() => {
                        setVoteStatusMessage('Self verification completed. Waiting for onchain/sequencer readiness.');
                        void refreshVoteReadiness();
                      }}
                      onError={(data: any = {}) => {
                        const reason = String(data.reason || data.error_code || '').trim();
                        setVoteStatusMessage(reason ? `Self QR error: ${reason}` : 'Self verification failed.', true);
                      }}
                    />
                  ) : (
                    <p className="muted">Preparing Self QR...</p>
                  )}
                </div>

                <button
                  id="copyVoteSelfLinkBtn"
                  type="button"
                  className="cta-btn secondary qr-copy-btn"
                  aria-label="Copy Self link"
                  title="Copy Self link"
                  disabled={!voteSelf.link || processClosed}
                  onClick={() => void copyVoteSelfLink()}
                >
                  <span className="btn-icon iconoir-copy" aria-hidden="true" />
                  <span className="btn-text">Copy link</span>
                </button>
              </div>

              <div className="vote-registration-requirements">
                <p className="label">Requirements to vote</p>
                <div className="vote-registration-requirements-grid">
                  <div className="vote-registration-requirement">
                    <p className="label">Minimum age</p>
                    <p className="value" id="voteSelfMinAgeInfo">
                      {voteSelf.minAge ? String(voteSelf.minAge) : '-'}
                    </p>
                  </div>
                  <div className="vote-registration-requirement">
                    <p className="label">Countries</p>
                    <p className="value" id="voteCountryInfo">
                      {voteSelfCountriesText}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <aside className="panel self-steps-panel">
            <p className="label">Quick steps</p>
            <ol className={`self-registration-steps ${registrationModal.isMobile ? 'is-mobile' : ''}`}>
              <li>
                <p className="self-registration-step-title">{registrationModal.isMobile ? 'Open Self app' : 'Install Self app'}</p>
                <p className="self-step-helper">
                  {registrationModal.isMobile ? (
                    <>
                      Get it on{' '}
                      <a href="https://apps.apple.com/pl/app/self-zk-passport-identity/id6478563710" target="_blank" rel="noreferrer">
                        iOS
                      </a>{' '}
                      or{' '}
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
                      Available on{' '}
                      <a href="https://apps.apple.com/pl/app/self-zk-passport-identity/id6478563710" target="_blank" rel="noreferrer">
                        iOS
                      </a>{' '}
                      and{' '}
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
                  {registrationModal.isMobile ? 'Verify your ID or passport' : 'Use a valid ID or passport'}
                </p>
                <p className="self-step-helper">
                  {registrationModal.isMobile
                    ? 'Complete verification in Self to join the census.'
                    : 'Complete identity verification in Self to be added to the census.'}
                </p>
              </li>
              <li>
                <p className="self-registration-step-title">
                  {registrationModal.isMobile ? 'Finish in Self and return here' : 'Finish this registration request'}
                </p>
                <p className="self-step-helper">
                  {registrationModal.isMobile
                    ? 'Tap "Open in Self app" below and complete verification.'
                    : 'Scan the QR (or open the deep-link) and wait for readiness.'}
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
                  <span className="btn-text">Open in Self app</span>
                </button>
              </div>
            )}

            {registrationModal.isMobile && (
              <div className="vote-registration-requirements">
                <p className="label">Requirements to vote</p>
                <div className="vote-registration-requirements-grid">
                  <div className="vote-registration-requirement">
                    <p className="label">Minimum age</p>
                    <p className="value" id="voteSelfMinAgeInfo">
                      {voteSelf.minAge ? String(voteSelf.minAge) : '-'}
                    </p>
                  </div>
                  <div className="vote-registration-requirement">
                    <p className="label">Countries</p>
                    <p className="value" id="voteCountryInfo">
                      {voteSelfCountriesText}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="vote-status-guide registration-status-guide" id="registrationStatusGuide">
              <p className="label">Registration progress</p>
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
        {showRegistrationSubmittingNotice && (
          <p className="vote-registration-submit-note" role="status" aria-live="polite">
            <span className="timeline-spinner" aria-hidden="true" />
            <span>Registration completed. Your vote is being submitted...</span>
          </p>
        )}
      </PopupModal>

      <PopupModal
        id="voteContextGatePopup"
        open={contextBlocked}
        role="alertdialog"
        title="This voting link is incomplete"
        titleId="voteContextGatePopupTitle"
        descriptionId="voteContextGatePopupMessage"
        className="vote-popup vote-context-popup"
        cardClassName="vote-popup-card vote-context-popup-card"
        bodyClassName="vote-popup-body vote-context-popup-body"
        closeLabel="Close context popup"
        eyebrow="Process ID required"
        onClose={closeContextGatePopup}
      >
        <p id="voteContextGatePopupMessage">{contextMessage}</p>
      </PopupModal>
    </>
  );
}
