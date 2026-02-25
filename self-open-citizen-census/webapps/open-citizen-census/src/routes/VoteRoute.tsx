import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wallet } from 'ethers';
import { useNavigate, useParams } from 'react-router-dom';
import { DavinciSDK, ProcessStatus } from '@vocdoni/davinci-sdk';
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
  encodeWeightOf,
  extractCensusContract,
  extractCensusUri,
  extractProcessDescription,
  extractProcessEndDateMs,
  extractVoteContextFromMetadata,
  formatProcessTypeLabel,
  formatReadinessCheckTime,
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
  wait,
  type VoteStatusKey,
} from '../lib/occ';
import { getUniversalLink } from '../selfApp';
import { isValidProcessId, normalizeCountry, normalizeMinAge, normalizeProcessId, normalizeScope } from '../utils/normalization';

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
  description: string;
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
  country: string;
  link: string;
  generating: boolean;
  autoTriggerKey: string;
  autoCollapsedForEligibility: boolean;
  autoCollapsedForClosedStatus: boolean;
  selfApp: any | null;
}

interface VoteBallotState {
  questions: VoteQuestion[];
  choices: Array<number | null>;
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
  description: '',
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
  country: '',
  link: '',
  generating: false,
  autoTriggerKey: '',
  autoCollapsedForEligibility: false,
  autoCollapsedForClosedStatus: false,
  selfApp: null,
};

const EMPTY_BALLOT: VoteBallotState = {
  questions: [],
  choices: [],
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

function shouldDefaultCollapseVoteSelfCard(statusCode: number | null): boolean {
  const normalized = normalizeProcessStatus(statusCode);
  return normalized === ProcessStatus.ENDED || normalized === ProcessStatus.RESULTS;
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

function areVoteChoicesEnabled(resolution: VoteResolutionState, ballot: VoteBallotState): boolean {
  return hasVoteReadiness(resolution) && !ballot.submitting && canOverwriteVote(ballot);
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
  const maxVoters = toSafeInteger(resolution.maxVoters);
  const rawValues = normalizeProcessResultValues(resolution.rawResult);
  const hasComputedResults = rawValues.length > 0;
  let cursor = 0;

  const questions = ballot.questions.map((question, questionIndex) => {
    const orderedChoices = [...question.choices].sort((a, b) => Number(a.value) - Number(b.value));
    const rankedChoices = orderedChoices
      .map((choice, order) => {
        const rawVotes = rawValues[cursor];
        cursor += 1;
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

    return {
      title: String(question.title || `Question ${questionIndex + 1}`),
      choices: rankedChoices,
    };
  });

  const choicesWithVotes = questions.reduce((sum, question) => sum + question.choices.filter((choice) => choice.votes > 0).length, 0);

  return {
    totalVotes,
    turnoutLabel: formatVotePercent(totalVotes, maxVoters),
    choicesWithVotes,
    questions,
    hasComputedResults,
  };
}

export default function VoteRoute() {
  const params = useParams();
  const navigate = useNavigate();

  const [voteStatus, setVoteStatus] = useState<{ message: string; error: boolean }>({
    message: 'Resolve process and managed wallet before generating Self QR.',
    error: false,
  });
  const [voteSelfStatus, setVoteSelfStatus] = useState<{ message: string; error: boolean }>({
    message: 'Resolve process and managed wallet before generating Self QR.',
    error: false,
  });

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
  const [voteProcessIdInput, setVoteProcessIdInput] = useState('');
  const [voteDetailsOpen, setVoteDetailsOpen] = useState(false);
  const [voteSelfCardOpen, setVoteSelfCardOpen] = useState(true);
  const [voteStatusDetailsOpen, setVoteStatusDetailsOpen] = useState(false);
  const [copyVoteIdLabel, setCopyVoteIdLabel] = useState('Copy');

  const votePollRef = useRef<number | null>(null);
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
    const title = String(voteResolution.title || '').trim();
    if (voteResolution.processId && title && title !== '-') {
      document.title = `${title} - ${DEFAULT_DOCUMENT_TITLE}`;
      return;
    }
    document.title = DEFAULT_DOCUMENT_TITLE;
  }, [voteResolution.processId, voteResolution.title]);

  useEffect(() => {
    document.body.classList.toggle('app-blocked', contextBlocked);
    return () => {
      document.body.classList.remove('app-blocked');
    };
  }, [contextBlocked]);

  const setVoteStatusMessage = useCallback((message: string, error = false) => {
    setVoteStatus({ message, error });
  }, []);

  const setVoteSelfStatusMessage = useCallback((message: string, error = false) => {
    setVoteSelfStatus({ message, error });
  }, []);

  const stopVotePolling = useCallback(() => {
    if (votePollRef.current) {
      window.clearInterval(votePollRef.current);
      votePollRef.current = null;
    }
  }, []);

  const getProcessFromSequencer = useCallback(async (sdk: any, processId: string) => {
    const normalized = normalizeProcessId(processId);
    try {
      return await sdk.api.sequencer.getProcess(normalized);
    } catch (error) {
      const withoutPrefix = normalized.replace(/^0x/, '');
      if (withoutPrefix === normalized) throw error;
      return sdk.api.sequencer.getProcess(withoutPrefix);
    }
  }, []);

  const ethCall = useCallback(async (to: string, data: string) => {
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

    const json = (await response.json()) as { error?: { message?: string }; result?: string };
    if (json.error) {
      throw new Error(json.error.message || 'eth_call failed');
    }
    return json.result || '0x0';
  }, []);

  const fetchOnchainWeight = useCallback(
    async (contractAddress: string, address: string) => {
      if (!/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) return 0n;
      const result = await ethCall(contractAddress, encodeWeightOf(address));
      return BigInt(result || '0x0');
    },
    [ethCall]
  );

  const fetchSequencerWeight = useCallback(async (processId: string, address: string) => {
    const sdk = resolutionRef.current.sdk;
    if (!sdk) return 0n;

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
        // Try next candidate.
      }
    }

    return 0n;
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
      const sequencerWeight = await fetchSequencerWeight(processId, managedAddress);
      setVoteResolution((previous) => ({ ...previous, sequencerWeight }));
    } catch {
      setVoteResolution((previous) => ({ ...previous, sequencerWeight: 0n }));
    }

    setVoteResolution((previous) => ({ ...previous, readinessCheckedAt: Date.now() }));
  }, [fetchOnchainWeight, fetchSequencerWeight, getProcessFromSequencer]);

  const startVotePolling = useCallback(() => {
    stopVotePolling();
    if (!resolutionRef.current.processId) return;
    votePollRef.current = window.setInterval(() => {
      void refreshVoteReadiness();
    }, VOTE_POLL_MS);
  }, [refreshVoteReadiness, stopVotePolling]);

  const restoreVoteSubmissionFromStorage = useCallback((processId: string, address: string) => {
    const stored = loadVoteSubmission(processId, address);
    if (!stored) return false;

    setVoteBallot((previous) => ({
      ...previous,
      submissionId: stored.voteId,
      submissionStatus: stored.status || 'pending',
      hasVoted: false,
    }));
    return true;
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

      void restoreVoteSubmissionFromStorage(normalizedProcessId, wallet.address);
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

  const clearVoteSelfArtifacts = useCallback((resetAutoTrigger = true) => {
    setVoteSelf((previous) => ({
      ...previous,
      link: '',
      selfApp: null,
      autoTriggerKey: resetAutoTrigger ? '' : previous.autoTriggerKey,
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
    setVoteSelfCardOpen(true);
    setVoteDetailsOpen(false);
    setVoteStatusMessage('Resolve process and managed wallet before generating Self QR.');
    setVoteSelfStatusMessage('Resolve process and managed wallet before generating Self QR.');
  }, [clearVoteBallot, setVoteSelfStatusMessage, setVoteStatusMessage, stopVotePolling]);

  const loadVoteQuestions = useCallback(
    async (process: any, metadata: any) => {
      clearVoteBallot('Loading process questions...');
      setVoteBallot((previous) => ({ ...previous, loading: true }));

      try {
        const metadataQuestions = normalizeVoteQuestions(metadata?.questions);
        const directQuestions = normalizeVoteQuestions(process?.questions);
        const resolvedQuestions = metadataQuestions.length ? metadataQuestions : directQuestions;

        setVoteBallot((previous) => ({
          ...previous,
          loading: false,
          questions: resolvedQuestions,
          choices: resolvedQuestions.map(() => null),
          submissionId: '',
          submissionStatus: '',
          hasVoted: false,
        }));

        if (!resolvedQuestions.length) {
          setVoteStatusMessage('No vote questions were found in this process.', true);
        }
      } catch (error) {
        clearVoteBallot(error instanceof Error ? error.message : 'Failed to load process questions.');
        setVoteStatusMessage(error instanceof Error ? error.message : 'Failed to load process questions.', true);
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
        setVoteStatusMessage('This identity wallet already has a vote in sequencer. You can emit again to overwrite it.');
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

  const getVoteSelfAutoTriggerKey = useCallback(() => {
    const resolution = resolutionRef.current;
    const self = voteSelfRef.current;
    const wallet = managedWalletRef.current;

    const processId = normalizeProcessId(resolution.processId);
    const contractAddress = String(resolution.censusContract || '').toLowerCase();
    const managedAddress = String(wallet?.address || '').toLowerCase();
    const scopeSeed = normalizeScope(self.scopeSeed || '');
    const minAge = self.minAge ? String(self.minAge) : '';

    if (!processId || !contractAddress || !managedAddress || !scopeSeed) {
      return '';
    }

    return [processId.toLowerCase(), contractAddress, managedAddress, scopeSeed, minAge].join('|');
  }, []);

  const maybeAutoGenerateVoteSelfQr = useCallback(async () => {
    const resolution = resolutionRef.current;
    const self = voteSelfRef.current;
    if (isVoteProcessClosed(resolution)) return;
    if (resolution.sequencerWeight > 0n) return;

    const key = getVoteSelfAutoTriggerKey();
    if (!key) return;
    if (self.generating || self.link) return;
    if (self.autoTriggerKey === key) return;

    setVoteSelf((previous) => ({ ...previous, autoTriggerKey: key }));
    await generateVoteSelfQr(true);
  }, [getVoteSelfAutoTriggerKey]);

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

      const metaCountry = normalizeCountry(meta?.country || '');
      const metaMinAge = Number(meta?.minAge);
      const resolvedMetaMinAge = contractMatches && Number.isFinite(metaMinAge) && metaMinAge > 0 ? Math.trunc(metaMinAge) : null;

      setVoteSelf((previous) => ({
        ...previous,
        scopeSeed,
        country: /^[A-Z]{2,3}$/.test(metaCountry) ? metaCountry : previous.country,
        minAge: resolvedMetaMinAge || previous.minAge,
      }));

      if (meta?.network && meta.network in NETWORKS) {
        setVoteResolution((previous) => ({ ...previous, network: String(meta.network) }));
      }

      clearVoteSelfArtifacts();
    },
    [clearVoteSelfArtifacts]
  );

  const fetchProcessMetadata = useCallback(async (sdk: any, process: any) => {
    const metadataUri = String(process?.metadataURI || process?.metadataUri || '').trim();
    if (!metadataUri || !sdk?.api?.sequencer?.getMetadata) return null;
    try {
      const metadata = await sdk.api.sequencer.getMetadata(metadataUri);
      return metadata && typeof metadata === 'object' ? metadata : null;
    } catch {
      return null;
    }
  }, []);

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
        country: '',
        autoCollapsedForEligibility: false,
        autoCollapsedForClosedStatus: false,
      }));
      clearVoteBallot('Resolving process...');

      if (!silent) {
        setVoteStatusMessage('Resolving process from sequencer...');
      }

      try {
        const sdk = new DavinciSDK({ sequencerUrl: CONFIG.davinciSequencerUrl } as any);
        await sdk.init();
        const process = await getProcessFromSequencer(sdk, normalizedProcessId);
        const metadata = await fetchProcessMetadata(sdk, process);

        const contractAddress = extractCensusContract(process);
        const censusUri = extractCensusUri(process, contractAddress);
        const title = String(
          getLocalizedText(metadata?.title) || process?.title || process?.metadata?.title || process?.metadata?.name || '-'
        ).trim();
        const description = extractProcessDescription(process, metadata);
        const endDateMs = extractProcessEndDateMs(process, metadata);
        const metadataContext = extractVoteContextFromMetadata(metadata);
        const statusCode = normalizeProcessStatus(process?.status);
        const isAcceptingVotes = isProcessAcceptingVotes(process);
        const rawResult = Array.isArray(process?.result) ? process.result : null;
        const votersCount = toSafeInteger(process?.votersCount);
        const maxVoters = toSafeInteger(process?.maxVoters);
        const processTypeName = String(metadata?.type?.name || process?.metadata?.type?.name || '').trim();

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
          description,
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
        if (metadataContext.country) {
          setVoteSelf((previous) => ({ ...previous, country: metadataContext.country }));
        }

        const existingMeta = loadProcessMeta(normalizedProcessId) || {};
        persistProcessMeta(normalizedProcessId, {
          ...existingMeta,
          title: title !== '-' ? title : existingMeta.title || '',
          contractAddress: contractAddress || existingMeta.contractAddress || '',
          censusUri: censusUri || existingMeta.censusUri || '',
          scopeSeed: metadataContext.scopeSeed || existingMeta.scopeSeed || '',
          minAge: metadataContext.minAge || existingMeta.minAge || undefined,
          country: metadataContext.country || existingMeta.country || '',
          network: metadataContext.network || existingMeta.network || CONFIG.network,
          updatedAt: new Date().toISOString(),
        });

        hydrateVoteSelfScope(normalizedProcessId, contractAddress);
        void refreshVoteSelfContractData(contractAddress);

        await loadVoteQuestions(process, metadata);

        const wallet = managedWalletRef.current;
        if (wallet) {
          const restoredVoteId = restoreVoteSubmissionFromStorage(normalizedProcessId, wallet.address);
          if (restoredVoteId) {
            const normalizedStatus = normalizeVoteStatus(voteBallotRef.current.submissionStatus);
            const shouldWatch = normalizedStatus && normalizedStatus !== 'settled' && normalizedStatus !== 'error';
            if (shouldWatch) {
              const watcherToken = voteBallotRef.current.statusWatcherToken + 1;
              setVoteBallot((previous) => ({ ...previous, statusWatcherToken: watcherToken }));
              void trackVoteSubmissionStatus(
                sdk,
                normalizedProcessId,
                voteBallotRef.current.submissionId,
                watcherToken,
                wallet.address || ''
              );
            }
          }
        }

        await refreshVoteReadiness();
        await refreshHasVotedFlag();
        startVotePolling();
        await maybeAutoGenerateVoteSelfQr();

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
      maybeAutoGenerateVoteSelfQr,
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
      setVoteSelfStatusMessage(getClosedProcessMessage(resolution), true);
      return;
    }
    if (!processId || !contractAddress || !managedAddress) {
      setVoteSelfStatusMessage('Resolve process and managed wallet before generating Self QR.', true);
      return;
    }
    if (!scopeSeed) {
      setVoteSelfStatusMessage('Scope seed is required to generate Self QR.', true);
      return;
    }
    if (!/^[\x00-\x7F]+$/.test(scopeSeed) || scopeSeed.length > 31) {
      setVoteSelfStatusMessage('Scope seed must be ASCII and up to 31 characters.', true);
      return;
    }

    persistVoteScopeSeed(processId, scopeSeed);

    setVoteSelf((previous) => ({ ...previous, generating: true, scopeSeed }));

    try {
      setVoteSelfStatusMessage('Generating Self QR...');

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
        appName: CONFIG.selfAppName || 'Open Citizen Census',
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

      setVoteSelfStatusMessage('QR ready. Scan it in the Self app to register this wallet.');
      if (!auto) {
        setVoteStatusMessage('Self QR ready. Complete verification in Self and wait for readiness to turn Yes.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate Self QR.';
      setVoteSelfStatusMessage(message, true);
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
      setVoteSelfStatusMessage('Self link copied to clipboard.');
    } catch {
      setVoteSelfStatusMessage('Failed to copy Self link.', true);
    }
  }, [setVoteSelfStatusMessage]);

  const openVoteSelfLink = useCallback(() => {
    const link = voteSelfRef.current.link;
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
  }, []);

  const emitVote = useCallback(async () => {
    if (voteBallotRef.current.submitting) return;

    const resolution = resolutionRef.current;
    const ballot = voteBallotRef.current;
    const wallet = managedWalletRef.current;
    const processId = resolution.processId;
    const choices = ballot.choices.map((value) => Number(value));

    if (!processId || !wallet?.privateKey) {
      setVoteStatusMessage('Resolve process and managed wallet before emitting vote.', true);
      return;
    }
    if (isVoteProcessClosed(resolution)) {
      setVoteStatusMessage(getClosedProcessMessage(resolution), true);
      return;
    }
    if (!ballot.questions.length) {
      setVoteStatusMessage('No questions available for this process.', true);
      return;
    }
    if (!hasVoteReadiness(resolution)) {
      const message = isOnchainReadinessRequired(resolution)
        ? 'Wait until Onchain and Sequencer readiness are both Yes.'
        : 'Wait until Sequencer readiness is Yes.';
      setVoteStatusMessage(message, true);
      return;
    }
    if (!canOverwriteVote(ballot)) {
      setVoteStatusMessage('Current vote is still processing. Wait until status becomes Settled or Error before overwriting.', true);
      return;
    }

    const censusUrl = trimTrailingSlash(CONFIG.onchainIndexerUrl);
    if (!censusUrl) {
      setVoteStatusMessage('Missing census URL config for vote proof generation.', true);
      return;
    }

    try {
      setVoteBallot((previous) => ({ ...previous, submitting: true }));
      setVoteStatusMessage('Emitting vote...');

      const sdk = new DavinciSDK({
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
      setVoteStatusMessage('Vote emitted successfully.');

      const watcherToken = voteBallotRef.current.statusWatcherToken + 1;
      setVoteBallot((previous) => ({ ...previous, statusWatcherToken: watcherToken }));
      void trackVoteSubmissionStatus(sdk, processId, voteId, watcherToken, wallet.address);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to emit vote.';
      if (voteBallotRef.current.submissionId) {
        setVoteBallot((previous) => ({ ...previous, hasVoted: false, submissionStatus: 'error' }));
        persistVoteSubmission(processId, wallet.address, {
          voteId: voteBallotRef.current.submissionId,
          status: 'error',
        });
      }
      setVoteStatusMessage(message, true);
    } finally {
      setVoteBallot((previous) => ({ ...previous, submitting: false }));
    }
  }, [setVoteStatusMessage, trackVoteSubmissionStatus]);

  useEffect(() => {
    setVoteStatusDetailsOpen(false);
  }, [voteBallot.submissionId]);

  useEffect(() => {
    const rawSegment = decodeURIComponent(String(params.processId || '')).trim();

    if (!rawSegment) {
      const message = 'Missing process ID in URL. Open the complete /vote/:processId link shared for this process.';
      setContextBlocked(true);
      setContextMessage(message);
      setVoteProcessIdInput('');
      resetVoteResolution();
      setVoteStatusMessage(message, true);
      return;
    }

    const normalized = normalizeProcessId(rawSegment);
    if (!isValidProcessId(normalized)) {
      const message = 'Invalid process ID in URL. Open a valid /vote/:processId link to use this app.';
      setContextBlocked(true);
      setContextMessage(message);
      setVoteProcessIdInput('');
      resetVoteResolution();
      setVoteStatusMessage(message, true);
      return;
    }

    setContextBlocked(false);
    setContextMessage('');
    setVoteProcessIdInput(normalized);
    void resolveVoteProcess(normalized, false);
  }, [params.processId, resetVoteResolution, resolveVoteProcess, setVoteStatusMessage]);

  useEffect(() => () => stopVotePolling(), [stopVotePolling]);

  useEffect(() => {
    const sequencerEligible = voteResolution.sequencerWeight > 0n;
    const closed = isVoteProcessClosed(voteResolution);

    if (sequencerEligible) {
      setVoteSelf((previous) => ({
        ...previous,
        autoCollapsedForEligibility: true,
      }));
      setVoteSelfStatusMessage('You are already registered in the sequencer census.');
      return;
    }

    if (closed) {
      setVoteSelf((previous) => ({
        ...previous,
        autoCollapsedForEligibility: false,
        autoCollapsedForClosedStatus: true,
      }));
      if (shouldDefaultCollapseVoteSelfCard(voteResolution.statusCode)) {
        setVoteSelfCardOpen(false);
      }
      setVoteSelfStatusMessage(getClosedProcessMessage(voteResolution));
      return;
    }

    setVoteSelf((previous) => ({
      ...previous,
      autoCollapsedForEligibility: false,
      autoCollapsedForClosedStatus: false,
    }));
  }, [setVoteSelfStatusMessage, voteResolution]);

  useEffect(() => {
    void maybeAutoGenerateVoteSelfQr();
  }, [maybeAutoGenerateVoteSelfQr, voteResolution.censusContract, voteResolution.processId, voteResolution.sequencerWeight, managedWallet, voteSelf.scopeSeed, voteSelf.minAge]);

  const processTypeLabel = formatProcessTypeLabel(voteResolution.processTypeName);
  const lifecycle = formatVoteLifecycle(voteResolution);
  const processClosed = isVoteProcessClosed(voteResolution);
  const sequencerEligible = voteResolution.sequencerWeight > 0n;
  const registrationLocked = sequencerEligible || processClosed;

  const hasStoredVoteId = Boolean(voteBallot.submissionId);
  const overwriteAllowed = canOverwriteVote(voteBallot);
  const answersEnabled = areVoteChoicesEnabled(voteResolution, voteBallot);
  const hasQuestions = voteBallot.questions.length > 0;
  const hasAllChoices =
    hasQuestions &&
    voteBallot.questions.every(
      (question, index) =>
        Number.isInteger(voteBallot.choices[index]) &&
        question.choices.some((choice) => Number(choice.value) === Number(voteBallot.choices[index]))
    );

  const canSubmitVote =
    Boolean(voteResolution.processId) &&
    Boolean(managedWallet?.privateKey) &&
    !processClosed &&
    hasVoteReadiness(voteResolution) &&
    hasQuestions &&
    hasAllChoices &&
    !voteBallot.submitting &&
    overwriteAllowed;

  const voteButtonLabel = voteBallot.submitting
    ? 'Emitting vote...'
    : processClosed
      ? 'Voting closed'
      : hasStoredVoteId && isVoteStatusTerminal(voteBallot.submissionStatus)
        ? 'Emit vote again'
        : hasStoredVoteId
          ? 'Vote in progress'
          : 'Emit vote';

  const voteButtonIcon = voteBallot.submitting ? 'iconoir-refresh' : processClosed ? 'iconoir-lock' : 'iconoir-check';

  const voteResultsVisible = Boolean(voteResolution.processId) && shouldShowVoteResults(voteResolution.statusCode);
  const voteResultsModel = useMemo(() => buildVoteResultsModel(voteResolution, voteBallot), [voteBallot, voteResolution]);

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
        description: 'After scanning the Self QR, this step completes when onchain weight is greater than zero.',
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
        label: 'Ready to vote',
        description: 'Questions unlock and vote can be emitted.',
        done: readyToVote,
      }
    );

    return steps;
  }, [voteResolution]);

  const registrationCurrentId = registrationSteps.find((step) => !step.done)?.id || 'ready';
  const pollSeconds = Math.max(1, Math.round(VOTE_POLL_MS / 1000));
  const checkTime = formatReadinessCheckTime(voteResolution.readinessCheckedAt);
  const onchainRequired = isOnchainReadinessRequired(voteResolution);

  let registrationSummary = 'Resolve process and load managed wallet to start registration.';
  if (processClosed) {
    registrationSummary = getClosedProcessMessage(voteResolution);
  } else if (voteResolution.processId && managedWallet?.address && voteSelf.scopeSeed && !voteSelf.link) {
    registrationSummary = voteSelf.generating
      ? 'Generating QR for Self...'
      : 'Scan the QR in Self after completing ID or passport verification to start registration.';
  } else if (voteResolution.processId && managedWallet?.address && onchainRequired && voteResolution.onchainWeight <= 0n) {
    registrationSummary = 'Waiting for onchain census inclusion.';
  } else if (voteResolution.processId && managedWallet?.address && voteResolution.sequencerWeight <= 0n) {
    registrationSummary = 'Waiting for sequencer census inclusion.';
  } else if (hasVoteReadiness(voteResolution)) {
    registrationSummary = 'Registration complete. You can now select options and emit your vote.';
  }

  const registrationDiagnostics = [
    onchainRequired
      ? `Onchain weight: ${voteResolution.onchainWeight.toString()}.`
      : voteResolution.onchainLookupFailed
        ? 'Onchain check unavailable (RPC fallback active).'
        : 'Onchain check not required for this process.',
    `Sequencer weight: ${voteResolution.sequencerWeight.toString()}.`,
    checkTime ? `Last check: ${checkTime}.` : '',
    `Auto-check every ${pollSeconds}s.`,
  ]
    .filter(Boolean)
    .join(' ');

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

  return (
    <>
      <section id="voteView" className="view">
        <article className="card">
          <div className="inline-form">
            <label className="inline-grow">
              Process ID
              <input
                id="voteProcessIdInput"
                name="vote_process_id"
                spellCheck={false}
                autoComplete="off"
                type="text"
                placeholder="0xabc…"
                value={voteProcessIdInput}
                onChange={(event) => setVoteProcessIdInput(event.target.value)}
                onKeyDown={(event) => {
                  if (contextBlocked) {
                    setVoteStatusMessage(contextMessage, true);
                    return;
                  }
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  const processId = normalizeProcessId(voteProcessIdInput);
                  if (!processId) {
                    setVoteStatusMessage('Process ID is required.', true);
                    return;
                  }
                  navigate(`/vote/${encodeURIComponent(processId)}`);
                }}
              />
            </label>
            <button id="showVoteDetailsBtn" type="button" className="ghost" disabled={!voteResolution.processId} onClick={() => setVoteDetailsOpen(true)}>
              <span className="btn-icon iconoir-info-circle" aria-hidden="true" />
              <span className="btn-text">Details</span>
            </button>
          </div>

          <div className="vote-lifecycle-card" id="voteLifecycleCard" hidden={!voteResolution.processId} data-state={lifecycle.stateKey}>
            <div className="vote-lifecycle-head">
              <div className="vote-lifecycle-left">
                <span className="vote-lifecycle-dot" aria-hidden="true" />
                <strong id="voteLifecycleTitle">{lifecycle.title}</strong>
                <span id="voteLifecycleType" className="vote-lifecycle-pill" hidden={!processTypeLabel}>
                  {processTypeLabel || '-'}
                </span>
              </div>
              <div className="vote-lifecycle-right">
                <span className="iconoir-clock" aria-hidden="true" />
                <span id="voteLifecycleLabel">{lifecycle.label}</span>
              </div>
            </div>
            <p id="voteLifecycleDescription" className="muted">
              {lifecycle.description}
            </p>
          </div>
        </article>

        <dialog id="voteDetailsDialog" className="details-dialog" open={voteDetailsOpen}>
          <div className="details-dialog-head">
            <h3>Process Details</h3>
            <button id="closeVoteDetailsBtn" type="button" className="ghost" onClick={() => setVoteDetailsOpen(false)}>
              <span className="btn-icon iconoir-xmark" aria-hidden="true" />
              <span className="btn-text">Close</span>
            </button>
          </div>
          <div className="details-dialog-body">
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
                  <th>Title</th>
                  <td>
                    <span id="voteProcessTitle">{voteResolution.title || '-'}</span>
                  </td>
                </tr>
                <tr>
                  <th>Description</th>
                  <td>
                    <span id="voteProcessDescription">{voteResolution.description || '-'}</span>
                  </td>
                </tr>
                <tr>
                  <th>Remaining time</th>
                  <td>
                    <strong id="voteProcessRemainingTime">{formatRemainingTimeFromEndMs(voteResolution.endDateMs)}</strong>
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
          </div>
        </dialog>

        <article className="card vote-results-card" id="voteResultsCard" hidden={!voteResultsVisible}>
          <div className="card-head vote-results-head">
            <div className="vote-results-process">
              <p className="label">Process</p>
              <h4 id="voteResultsProcessTitle" className="vote-results-process-title">
                {voteResolution.title && voteResolution.title !== '-' ? voteResolution.title : 'Untitled process'}
              </h4>
              <p id="voteResultsProcessDescription" className="muted vote-results-process-description" hidden={!voteResolution.description}>
                {voteResolution.description}
              </p>
            </div>
          </div>

          <div className="vote-results-body">
            <section className="panel vote-results-summary">
              <p className="label">Vote Summary</p>
              <div className="grid three vote-results-summary-grid">
                <div>
                  <p id="voteResultsTotalVotes" className="vote-results-summary-value">
                    {voteResultsModel.totalVotes}
                  </p>
                  <p className="muted">Total votes</p>
                </div>
                <div>
                  <p id="voteResultsTurnout" className="vote-results-summary-value">
                    {voteResultsModel.turnoutLabel}
                  </p>
                  <p className="muted">Turnout</p>
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

                {voteResultsModel.hasComputedResults && !voteResultsModel.questions.length && (
                  <div className="vote-results-empty">No question metadata available for this process.</div>
                )}

                {voteResultsModel.hasComputedResults &&
                  voteResultsModel.questions.map((question, questionIndex) => (
                    <section className="vote-results-question" key={questionIndex}>
                      <h5 className="vote-results-question-title">{question.title}</h5>
                      {question.choices.map((choice, choiceIndex) => (
                        <div className="vote-results-choice" key={`${questionIndex}-${choiceIndex}`}>
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
                  ))}
              </div>
            </section>
          </div>
        </article>

        <details className="card collapsible-card" id="voteSelfCard" open={voteSelfCardOpen} hidden={voteResultsVisible}>
          <summary
            className="collapsible-summary"
            onClick={(event) => {
              event.preventDefault();
              setVoteSelfCardOpen((previous) => !previous);
            }}
          >
            <span className="collapsible-title-group">
              <span className="collapsible-title-main">Process Registration</span>
              <span className="collapsible-title-meta">Powered by Self.xyz</span>
            </span>
          </summary>

          <div className="collapsible-body">
            <p className="muted">Generate a Self QR using your managed identity wallet to register in this census.</p>

            <div className="grid three info-widgets">
              <div className="panel info-widget">
                <p className="label">Scope seed</p>
                <p className="value" id="voteScopeSeedInfo">
                  {voteSelf.scopeSeed || '-'}
                </p>
              </div>
              <div className="panel info-widget">
                <p className="label">Minimum age</p>
                <p className="value" id="voteSelfMinAgeInfo">
                  {voteSelf.minAge ? String(voteSelf.minAge) : '-'}
                </p>
              </div>
              <div className="panel info-widget">
                <p className="label">Country</p>
                <p className="value" id="voteCountryInfo">
                  {voteSelf.country || '-'}
                </p>
              </div>
            </div>

            <div id="voteSelfRegistrationLayout" className={`self-registration-layout ${registrationLocked ? 'is-locked' : ''}`}>
              <div id="voteSelfQrWrap" className="self-qr-wrap" hidden={!voteSelf.selfApp}>
                <div id="voteSelfQrRoot" className="self-qr-root" aria-label="Self registration QR code">
                  {voteSelf.selfApp && (
                    <SelfQRcodeWrapper
                      key={`${voteResolution.processId}-${voteSelf.autoTriggerKey}-${voteSelf.link}`}
                      selfApp={voteSelf.selfApp}
                      type="deeplink"
                      size={280}
                      onSuccess={() => {
                        setVoteSelfStatusMessage('Verification completed in Self. Waiting for census inclusion...');
                        setVoteStatusMessage('Self verification completed. Waiting for onchain/sequencer readiness.');
                        void refreshVoteReadiness();
                      }}
                      onError={(data: any = {}) => {
                        const reason = String(data.reason || data.error_code || '').trim();
                        setVoteSelfStatusMessage(reason ? `Self QR error: ${reason}` : 'Self verification failed.', true);
                      }}
                    />
                  )}
                </div>

                <button
                  id="generateVoteSelfQrBtn"
                  type="button"
                  className="ghost qr-regen-btn"
                  aria-label="Regenerate Self QR"
                  title="Regenerate QR"
                  disabled={
                    !voteResolution.processId ||
                    !voteResolution.censusContract ||
                    !managedWallet?.address ||
                    !voteSelf.scopeSeed ||
                    voteSelf.generating ||
                    sequencerEligible ||
                    processClosed
                  }
                  onClick={() => void generateVoteSelfQr()}
                >
                  <span className="btn-icon iconoir-refresh" aria-hidden="true" />
                  <span className="btn-text">{voteSelf.generating ? 'Regenerating...' : 'Regenerate QR'}</span>
                </button>
              </div>

              <aside className="panel self-steps-panel">
                <p className="label">How to use Self</p>
                <ol className="self-steps-list">
                  <li>
                    <strong>Download the app</strong>
                    <p className="self-step-helper">
                      Install Self on{' '}
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
                    </p>
                  </li>
                  <li>
                    <strong>Register your identity</strong>
                    <p className="self-step-helper">Open Self and complete the verification using your ID card or passport.</p>
                  </li>
                  <li>
                    <strong>Scan the QR</strong>
                    <p className="self-step-helper">Use Self to scan this QR, join the census, and wait until voting is enabled.</p>
                  </li>
                </ol>
              </aside>

              <p id="voteAlreadyRegisteredMsg" className={`muted vote-registered-message ${processClosed ? 'is-closed' : ''}`} hidden={!registrationLocked}>
                <span
                  id="voteRegistrationLockIcon"
                  className={`vote-registered-icon ${processClosed ? 'iconoir-lock' : 'iconoir-check-circle'}`}
                  aria-hidden="true"
                />
                <span id="voteRegistrationLockText" className="vote-registered-text">
                  {processClosed ? 'Registration is closed for this process.' : 'You are already registered.'}
                </span>
              </p>
            </div>

            <div id="voteSelfQrActions" className={`row self-qr-actions ${registrationLocked ? 'is-locked' : ''}`}>
              <button id="copyVoteSelfLinkBtn" type="button" className="ghost" disabled={!voteSelf.link || registrationLocked} onClick={() => void copyVoteSelfLink()}>
                <span className="btn-icon iconoir-copy" aria-hidden="true" />
                <span className="btn-text">Copy Self link</span>
              </button>
              <button id="openVoteSelfLinkBtn" type="button" className="ghost" disabled={!voteSelf.link || registrationLocked} onClick={openVoteSelfLink}>
                <span className="btn-icon iconoir-link" aria-hidden="true" />
                <span className="btn-text">Open Self link</span>
              </button>
            </div>

            <p id="voteSelfStatus" className="status" data-state={voteSelfStatus.error ? 'error' : 'ok'} aria-live="polite">
              {voteSelfStatus.message}
            </p>

            <div className="vote-status-guide registration-status-guide" id="registrationStatusGuide">
              <p className="label">Registration progress</p>
              <ol id="registrationStatusTimeline" className="vote-status-timeline">
                {registrationSteps.map((step, index) => {
                  const isComplete = step.done;
                  const isCurrent = !isComplete && step.id === registrationCurrentId;
                  return (
                    <li
                      key={step.id}
                      className={`vote-status-item ${isComplete ? 'is-complete' : ''} ${isCurrent ? 'is-current' : ''}`}
                    >
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
              <p id="registrationHint" className="muted registration-hint">
                {`${registrationSummary} ${registrationDiagnostics}`.trim()}
              </p>
            </div>
          </div>
        </details>

        <article className="card vote-focus-card" id="voteBallotCard" hidden={voteResultsVisible}>
          <h2 id="voteFocusProcessTitle" className="vote-focus-title">
            {voteResolution.title && voteResolution.title !== '-' ? voteResolution.title : 'Questions'}
          </h2>
          <p id="voteFocusProcessDescription" className="vote-focus-description" hidden={!voteResolution.description}>
            {voteResolution.description || '-'}
          </p>
          <p id="voteFocusRemainingTime" className="vote-focus-meta" hidden={!voteResolution.endDateMs}>
            Remaining time: {formatRemainingTimeFromEndMs(voteResolution.endDateMs)}
          </p>
          <p className="muted vote-focus-note">Choose one option per question and emit your vote.</p>

          <div id="voteQuestions" className="vote-questions">
            {!voteBallot.questions.length && (
              <p className="muted">{voteBallot.loading ? 'Loading process questions...' : 'No questions available for this process.'}</p>
            )}

            {voteBallot.questions.map((question, questionIndex) => (
              <fieldset className="vote-question-card" key={questionIndex}>
                <legend>{question.title || `Question ${questionIndex + 1}`}</legend>
                {question.description && <p className="muted">{question.description}</p>}

                {question.choices.map((choice, choiceIndex) => {
                  const checked = Number(voteBallot.choices[questionIndex]) === Number(choice.value);
                  return (
                    <label className={`vote-choice ${!answersEnabled ? 'is-disabled' : ''}`} key={`${questionIndex}-${choiceIndex}`}>
                      <input
                        type="radio"
                        name={`vote-question-${questionIndex}`}
                        value={choice.value}
                        checked={checked}
                        disabled={!answersEnabled}
                        onChange={() => {
                          setVoteBallot((previous) => {
                            const nextChoices = [...previous.choices];
                            nextChoices[questionIndex] = Number(choice.value);
                            return {
                              ...previous,
                              choices: nextChoices,
                            };
                          });
                        }}
                      />
                      <span>{choice.title}</span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>

          <div className="row">
            <button id="emitVoteBtn" type="button" className="secondary" disabled={!canSubmitVote} onClick={() => void emitVote()}>
              <span className={`btn-icon ${voteButtonIcon}`} aria-hidden="true" />
              <span className="btn-text">{voteButtonLabel}</span>
            </button>
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

        <details className="card collapsible-card" id="managedWalletCard" hidden={voteResultsVisible}>
          <summary className="collapsible-summary">
            <span>Managed Identity Wallet</span>
          </summary>
          <div className="collapsible-body">
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
        </details>

        <p id="voteStatus" className="status" data-state={voteStatus.error ? 'error' : 'ok'} aria-live="polite">
          {voteStatus.message}
        </p>
      </section>

      <div
        id="voteContextGatePopup"
        className="blocking-popup"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="voteContextGatePopupTitle"
        aria-describedby="voteContextGatePopupMessage"
        hidden={!contextBlocked}
      >
        <div className="blocking-popup-backdrop" />
        <div className="blocking-popup-card">
          <p className="eyebrow">Process ID required</p>
          <h2 id="voteContextGatePopupTitle">This voting link is incomplete</h2>
          <p id="voteContextGatePopupMessage">{contextMessage}</p>
        </div>
      </div>
    </>
  );
}
