import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OnchainCensus } from '@vocdoni/davinci-sdk';

import {
  ACTIVE_NETWORK,
  CENSUS_MEMBERS_QUERY,
  CONFIG,
  HUB_INTERFACE,
  INTERNAL_RPC_RETRY_DELAY_MS,
  INTERNAL_RPC_RETRY_MAX_ATTEMPTS,
  PIPELINE_STAGES,
  buildCensusUri,
  buildDeployData,
  buildVoteUrl,
  collectErrorMessages,
  computeConfigId,
  computeIndexerExpiresAt,
  isInternalJsonRpcError,
  newPipelineState,
  persistProcessMeta,
  persistVoteScopeSeed,
  stringifyMetaValues,
  toHttpCensusUri,
  toSequencerCensusUri,
  trimTrailingSlash,
  wait,
  type CreateValues,
  type PipelineStageState,
} from '../lib/occ';
import { normalizeCountry, normalizeProcessId, normalizeScope, stripNonAscii } from '../utils/normalization';
import { buildAssetUrl } from '../utils/assets';
import { createSequencerSdk, getProcessFromSequencer } from '../services/sequencer';
import {
  connectBrowserWallet,
  disconnectWalletConnection,
  getInjectedProvider,
  type CreatorWalletConnection,
  type OCCProvider,
} from '../services/wallet';
import AppNavbar from '../components/AppNavbar';
import PopupModal from '../components/PopupModal';
import {
  COUNTRY_OPTIONS,
  DEFAULT_DURATION_HOURS,
  DEFAULT_MIN_AGE,
  ELIGIBILITY_TOOLTIP,
  MAX_NATIONALITIES,
  MAX_OPTIONS,
  MIN_OPTIONS,
} from './create/constants';
import {
  addOption,
  createInitialFormState,
  createInitialOverlayState,
  deriveCreateValuesFromForm,
  removeOption,
  updateOption,
} from './create/model';
import { searchCountryOptions } from './create/countrySearch';
import type { CreateFormState, CreateOverlayState } from './create/types';

interface CreatorWalletState extends Omit<CreatorWalletConnection, 'provider' | 'browserProvider' | 'signer'> {
  provider: OCCProvider | null;
  browserProvider: CreatorWalletConnection['browserProvider'] | null;
  signer: CreatorWalletConnection['signer'] | null;
  address: string;
  sourceLabel: string;
}

interface CreateOutputs {
  censusContract: string;
  deploymentTxHash: string;
  censusUri: string;
  processId: string;
  processTxHash: string;
  voteUrl: string;
}

interface PipelineContext {
  values: CreateValues | null;
  configId: string;
  provider: OCCProvider | null;
  browserProvider: CreatorWalletConnection['browserProvider'] | null;
  signer: CreatorWalletConnection['signer'] | null;
  creatorAddress: string;
  contractAddress: string;
  deploymentBlock: number;
  censusUri: string;
  sdk: any;
  processId: string;
}

interface ShareTarget {
  id: string;
  label: string;
  href: string;
  iconSrc?: string;
  iconFallbackSrc?: string;
  fallbackText: string;
}

const CREATOR_WALLET_STATUS_DEFAULT =
  'Connect MetaMask or another browser wallet. WalletConnect is used when no extension wallet is detected.';

const EMPTY_OUTPUTS: CreateOutputs = {
  censusContract: '',
  deploymentTxHash: '',
  censusUri: '',
  processId: '',
  processTxHash: '',
  voteUrl: '',
};

function hasAnyOutputs(outputs: CreateOutputs): boolean {
  return Boolean(
    outputs.censusContract || outputs.deploymentTxHash || outputs.censusUri || outputs.processId || outputs.processTxHash
  );
}

function hasPipelineActivity(pipeline: PipelineStageState[]): boolean {
  return pipeline.some((stage) => stage.status !== 'pending' || stage.message !== 'Pending');
}

function hasPipelineError(pipeline: PipelineStageState[]): boolean {
  return pipeline.some((stage) => stage.status === 'error');
}

function timelineRows(pipeline: PipelineStageState[]) {
  const stages = PIPELINE_STAGES.map((stage, index) => ({
    stage,
    index,
    status: pipeline.find((item) => item.id === stage.id) || { status: 'pending' as const, message: 'Pending' },
  }));

  const runningIndex = stages.findIndex((entry) => entry.status.status === 'running');
  const errorIndex = stages.findIndex((entry) => entry.status.status === 'error');
  const lastFinishedIndex = stages.reduce((last, entry) => (entry.status.status === 'success' ? entry.index : last), -1);

  let visibleUntil = -1;
  if (runningIndex >= 0) visibleUntil = runningIndex;
  else if (errorIndex >= 0) visibleUntil = errorIndex;
  else if (lastFinishedIndex >= 0) visibleUntil = lastFinishedIndex;

  if (visibleUntil < 0) return [];
  return stages.filter((entry) => entry.index <= visibleUntil);
}

export default function CreateRoute() {
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createFormDirty, setCreateFormDirty] = useState(false);
  const [overlayState, setOverlayState] = useState<CreateOverlayState>(createInitialOverlayState);

  const [creatorWalletStatus, setCreatorWalletStatus] = useState(CREATOR_WALLET_STATUS_DEFAULT);
  const [creatorWallet, setCreatorWallet] = useState<CreatorWalletState>({
    provider: null,
    browserProvider: null,
    signer: null,
    address: '',
    sourceLabel: '',
  });

  const [form, setForm] = useState<CreateFormState>(createInitialFormState);
  const [pipeline, setPipeline] = useState<PipelineStageState[]>(newPipelineState);
  const [outputs, setOutputs] = useState<CreateOutputs>(EMPTY_OUTPUTS);
  const [countriesMenuOpen, setCountriesMenuOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState('');
  const [activeCountryIndex, setActiveCountryIndex] = useState(-1);

  const walletRef = useRef(creatorWallet);
  const createTimelineRef = useRef<HTMLDetailsElement | null>(null);
  const countriesSelectRef = useRef<HTMLDivElement | null>(null);
  const countryQueryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    walletRef.current = creatorWallet;
  }, [creatorWallet]);

  useEffect(() => {
    const missing = [] as string[];
    if (!CONFIG.walletConnectProjectId && !getInjectedProvider()) {
      missing.push('VITE_WALLETCONNECT_PROJECT_ID (needed when no browser extension wallet is detected)');
    }
    if (!CONFIG.onchainIndexerUrl) missing.push('VITE_ONCHAIN_CENSUS_INDEXER_URL');
    if (!CONFIG.davinciSequencerUrl) missing.push('VITE_DAVINCI_SEQUENCER_URL');

    if (missing.length) {
      console.warn(`[OpenCitizenCensus] Missing env vars: ${missing.join(', ')}`);
    }
  }, []);

  useEffect(() => {
    document.title = 'Ask The World - DAVINCI';
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!createFormDirty || createSubmitting) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [createFormDirty, createSubmitting]);

  const creatorConnected = Boolean(creatorWallet.address);
  const timelineEntries = useMemo(() => timelineRows(pipeline), [pipeline]);
  const hasSuccessOutput = Boolean(String(outputs.voteUrl || '').trim());
  const hasError = useMemo(() => hasPipelineError(pipeline), [pipeline]);
  const hasActivity = useMemo(() => hasPipelineActivity(pipeline), [pipeline]);
  const showTimeline = createSubmitting || hasActivity || hasSuccessOutput;
  const canDismissOverlay = !createSubmitting;
  const overlayVisible = showTimeline && !overlayState.dismissed;
  const spinnerActive = !hasSuccessOutput && !hasError && (createSubmitting || hasActivity);
  const outputsVisible = hasAnyOutputs(outputs);
  const formLocked = createSubmitting;
  const selectedCountriesCount = form.countries.length;
  const countriesLimitReached = selectedCountriesCount >= MAX_NATIONALITIES;
  const shareTargets = useMemo<ShareTarget[]>(() => {
    const voteUrl = String(outputs.voteUrl || '').trim();
    if (!voteUrl) return [];

    const encodedUrl = encodeURIComponent(voteUrl);
    const shareText = encodeURIComponent('Join this vote on Ask The World - DAVINCI');
    const shareTextWithUrl = encodeURIComponent(`Join this vote on Ask The World - DAVINCI ${voteUrl}`);

    const simpleIconsBase = 'https://cdn.jsdelivr.net/npm/simple-icons@v16/icons';
    const simpleIconsFallbackBase = 'https://cdn.simpleicons.org';

    return [
      {
        id: 'x',
        label: 'X',
        href: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${shareText}`,
        iconSrc: `${simpleIconsBase}/x.svg`,
        iconFallbackSrc: `${simpleIconsFallbackBase}/x`,
        fallbackText: 'X',
      },
      {
        id: 'facebook',
        label: 'Facebook',
        href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        iconSrc: `${simpleIconsBase}/facebook.svg`,
        iconFallbackSrc: `${simpleIconsFallbackBase}/facebook`,
        fallbackText: 'f',
      },
      {
        id: 'linkedin',
        label: 'LinkedIn',
        href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
        fallbackText: 'in',
      },
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        href: `https://wa.me/?text=${shareTextWithUrl}`,
        iconSrc: `${simpleIconsBase}/whatsapp.svg`,
        iconFallbackSrc: `${simpleIconsFallbackBase}/whatsapp`,
        fallbackText: 'wa',
      },
      {
        id: 'telegram',
        label: 'Telegram',
        href: `https://t.me/share/url?url=${encodedUrl}&text=${shareText}`,
        iconSrc: `${simpleIconsBase}/telegram.svg`,
        iconFallbackSrc: `${simpleIconsFallbackBase}/telegram`,
        fallbackText: 'tg',
      },
      {
        id: 'farcaster',
        label: 'Farcaster',
        href: `https://warpcast.com/~/compose?text=${shareTextWithUrl}`,
        iconSrc: `${simpleIconsBase}/farcaster.svg`,
        iconFallbackSrc: `${simpleIconsFallbackBase}/farcaster`,
        fallbackText: 'fc',
      },
    ];
  }, [outputs.voteUrl]);
  const filteredCountryOptions = useMemo(
    () => searchCountryOptions(COUNTRY_OPTIONS, countryQuery),
    [countryQuery]
  );
  const activeCountryOption = activeCountryIndex >= 0 ? filteredCountryOptions[activeCountryIndex] : undefined;
  const activeCountryOptionId = countriesMenuOpen && activeCountryOption ? `country-option-${activeCountryOption.code}` : undefined;

  const closeCountriesMenu = useCallback(() => {
    setCountriesMenuOpen(false);
    setActiveCountryIndex(-1);
  }, []);

  useEffect(() => {
    if (!hasError) return;
    if (!createTimelineRef.current) return;
    createTimelineRef.current.open = true;
  }, [hasError]);

  const withBase = useCallback((file: string) => buildAssetUrl(file), []);
  const baseUrl = import.meta.env.BASE_URL || '/';

  useEffect(() => {
    document.body.classList.toggle('app-blocked', overlayVisible);
    return () => {
      document.body.classList.remove('app-blocked');
    };
  }, [overlayVisible]);

  useEffect(() => {
    if (!countriesMenuOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!countriesSelectRef.current) return;
      if (countriesSelectRef.current.contains(event.target)) return;
      closeCountriesMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeCountriesMenu();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeCountriesMenu, countriesMenuOpen]);

  useEffect(() => {
    if (formLocked && countriesMenuOpen) {
      closeCountriesMenu();
    }
  }, [closeCountriesMenu, countriesMenuOpen, formLocked]);

  useEffect(() => {
    if (!countriesMenuOpen) {
      setActiveCountryIndex(-1);
      return;
    }
    if (filteredCountryOptions.length === 0) {
      setActiveCountryIndex(-1);
      return;
    }
    setActiveCountryIndex((previous) => {
      if (previous < 0) return 0;
      if (previous >= filteredCountryOptions.length) return filteredCountryOptions.length - 1;
      return previous;
    });
  }, [countriesMenuOpen, filteredCountryOptions]);

  useEffect(() => {
    if (!countriesMenuOpen || formLocked) return;
    countryQueryInputRef.current?.focus();
  }, [countriesMenuOpen, formLocked]);

  const updateStage = useCallback((stageId: string, updates: Partial<PipelineStageState>) => {
    setPipeline((previous) => previous.map((stage) => (stage.id === stageId ? { ...stage, ...updates } : stage)));
  }, []);

  const runStage = useCallback(
    async <T,>(stageId: string, task: () => Promise<T>): Promise<T> => {
      updateStage(stageId, { status: 'running', message: 'Running' });
      for (let attempt = 1; attempt <= INTERNAL_RPC_RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
          const result = await task();
          updateStage(stageId, {
            status: 'success',
            message: typeof result === 'string' ? result : 'Completed',
          });
          return result;
        } catch (error) {
          const canRetry = isInternalJsonRpcError(error) && attempt < INTERNAL_RPC_RETRY_MAX_ATTEMPTS;
          if (canRetry) {
            updateStage(stageId, {
              status: 'running',
              message: `Internal wallet RPC error. Retrying (${attempt + 1}/${INTERNAL_RPC_RETRY_MAX_ATTEMPTS})...`,
            });
            await wait(INTERNAL_RPC_RETRY_DELAY_MS);
            continue;
          }

          const stageLabel = PIPELINE_STAGES.find((stage) => stage.id === stageId)?.label || stageId;
          updateStage(stageId, {
            status: 'error',
            message: `Could not complete "${stageLabel}". Check browser console for technical details.`,
          });
          throw error;
        }
      }

      throw new Error(`${stageId} failed`);
    },
    [updateStage]
  );

  const applyWalletConnection = useCallback((connection: CreatorWalletConnection) => {
    setCreatorWallet(connection);
    setCreatorWalletStatus(`Connected with ${connection.sourceLabel} on ${ACTIVE_NETWORK.label}.`);
  }, []);

  const resetWalletState = useCallback(() => {
    setCreatorWallet({
      provider: null,
      browserProvider: null,
      signer: null,
      address: '',
      sourceLabel: '',
    });
    setCreatorWalletStatus(CREATOR_WALLET_STATUS_DEFAULT);
  }, []);

  const connectCreatorWallet = useCallback(async () => {
    try {
      setCreatorWalletStatus('Connecting browser wallet...');
      const connection = await connectBrowserWallet(walletRef.current.provider);
      applyWalletConnection(connection);
    } catch (error) {
      const messages = collectErrorMessages(error);
      const message = messages[0] || (error instanceof Error ? error.message : 'Failed to connect creator wallet.');
      setCreatorWalletStatus(message);
    }
  }, [applyWalletConnection]);

  const handleCreatorWalletButton = useCallback(async () => {
    if (walletRef.current.address) {
      await disconnectWalletConnection(walletRef.current.provider);
      resetWalletState();
      return;
    }

    await connectCreatorWallet();
  }, [connectCreatorWallet, resetWalletState]);

  const updateForm = useCallback((patch: Partial<CreateFormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setCreateFormDirty(true);
  }, []);

  const addOptionRow = useCallback(() => {
    setForm((previous) => ({
      ...previous,
      options: addOption(previous.options),
    }));
    setCreateFormDirty(true);
  }, []);

  const removeOptionRow = useCallback((optionIndex: number) => {
    setForm((previous) => ({
      ...previous,
      options: removeOption(previous.options, optionIndex),
    }));
    setCreateFormDirty(true);
  }, []);

  const updateOptionRow = useCallback((optionIndex: number, value: string) => {
    setForm((previous) => ({
      ...previous,
      options: updateOption(previous.options, optionIndex, value),
    }));
    setCreateFormDirty(true);
  }, []);

  const collectCreateFormValues = useCallback((): CreateValues => deriveCreateValuesFromForm(form), [form]);

  const toggleCountrySelection = useCallback(
    (countryCode: string) => {
      if (formLocked) return;
      const normalizedCode = normalizeCountry(countryCode);
      if (!/^[A-Z]{2,3}$/.test(normalizedCode)) return;

      setForm((previous) => {
        const exists = previous.countries.includes(normalizedCode);
        if (exists) {
          return {
            ...previous,
            countries: previous.countries.filter((country) => country !== normalizedCode),
          };
        }
        if (previous.countries.length >= MAX_NATIONALITIES) {
          return previous;
        }
        return {
          ...previous,
          countries: [...previous.countries, normalizedCode],
        };
      });
      setCreateFormDirty(true);
    },
    [formLocked]
  );

  const handleCountrySelect = useCallback(
    (countryCode: string) => {
      toggleCountrySelection(countryCode);
      setCountryQuery('');
      closeCountriesMenu();
    },
    [closeCountriesMenu, toggleCountrySelection]
  );

  const handleCountryQueryChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setCountryQuery(value);
      if (formLocked) return;
      setCountriesMenuOpen(true);
    },
    [formLocked]
  );

  const handleCountryQueryKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (formLocked) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!countriesMenuOpen) {
          setCountriesMenuOpen(true);
          setActiveCountryIndex(filteredCountryOptions.length ? 0 : -1);
          return;
        }
        if (!filteredCountryOptions.length) return;
        setActiveCountryIndex((previous) => {
          if (previous < 0) return 0;
          return Math.min(previous + 1, filteredCountryOptions.length - 1);
        });
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!countriesMenuOpen) {
          setCountriesMenuOpen(true);
          setActiveCountryIndex(filteredCountryOptions.length ? 0 : -1);
          return;
        }
        if (!filteredCountryOptions.length) return;
        setActiveCountryIndex((previous) => {
          if (previous < 0) return 0;
          return Math.max(previous - 1, 0);
        });
        return;
      }

      if (event.key === 'Enter') {
        if (!countriesMenuOpen) return;
        const option = filteredCountryOptions[activeCountryIndex];
        if (!option) return;
        event.preventDefault();
        handleCountrySelect(option.code);
        return;
      }

      if (event.key === 'Escape') {
        closeCountriesMenu();
      }
    },
    [activeCountryIndex, closeCountriesMenu, countriesMenuOpen, filteredCountryOptions, formLocked, handleCountrySelect]
  );

  const adjustMinAge = useCallback((delta: number) => {
    setForm((previous) => {
      const parsed = Number(previous.minAge);
      const fallback = Number(DEFAULT_MIN_AGE);
      const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
      const next = Math.min(99, Math.max(1, base + delta));
      return { ...previous, minAge: String(next) };
    });
    setCreateFormDirty(true);
  }, []);

  const adjustDurationHours = useCallback((delta: number) => {
    setForm((previous) => {
      const parsed = Number(previous.durationHours);
      const fallback = Number(DEFAULT_DURATION_HOURS);
      const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
      const next = Math.max(1, base + delta);
      return { ...previous, durationHours: String(next) };
    });
    setCreateFormDirty(true);
  }, []);

  const getCountryLabel = useCallback((code: string) => {
    return COUNTRY_OPTIONS.find((option) => option.code === code)?.label || code;
  }, []);

  const waitForTransaction = useCallback(
    async (
      provider: CreatorWalletConnection['browserProvider'],
      hash: string,
      timeoutMs = 5 * 60 * 1000
    ) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) return receipt;
        await wait(2500);
      }
      throw new Error(`Timed out waiting for tx receipt: ${hash}`);
    },
    []
  );

  const ensureCreatorWalletForPipeline = useCallback(async (ctx: PipelineContext) => {
    if (!walletRef.current.signer) {
      const connection = await connectBrowserWallet(walletRef.current.provider);
      ctx.provider = connection.provider;
      ctx.browserProvider = connection.browserProvider;
      ctx.signer = connection.signer;
      ctx.creatorAddress = connection.address;
      return `Connected ${connection.address}`;
    }

    ctx.provider = walletRef.current.provider;
    ctx.browserProvider = walletRef.current.browserProvider;
    ctx.signer = walletRef.current.signer;
    ctx.creatorAddress = walletRef.current.address;
    return `Using connected wallet ${ctx.creatorAddress}`;
  }, []);

  const ensureSelfConfigRegistered = useCallback(
    async (ctx: PipelineContext) => {
      if (!ctx.provider || !ctx.signer || !ctx.values || !ctx.browserProvider) {
        throw new Error('Missing wallet context for Self config registration.');
      }

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

      const verificationConfig = {
        olderThanEnabled: ctx.values.minAge > 0,
        olderThan: BigInt(ctx.values.minAge),
        forbiddenCountriesEnabled: false,
        forbiddenCountriesListPacked: [0n, 0n, 0n, 0n],
        ofacEnabled: [false, false, false],
      };

      const txData = HUB_INTERFACE.encodeFunctionData('setVerificationConfigV2', [verificationConfig]);
      const tx = await ctx.signer.sendTransaction({
        to: ACTIVE_NETWORK.hubAddress,
        data: txData,
      });

      await waitForTransaction(ctx.browserProvider, tx.hash);
      return `Config registered (${tx.hash})`;
    },
    [waitForTransaction]
  );

  const deployCensusContract = useCallback(
    async (ctx: PipelineContext) => {
      if (!ctx.values || !ctx.signer || !ctx.browserProvider) {
        throw new Error('Missing wallet context for contract deployment.');
      }

      const data = buildDeployData({
        scopeSeed: ctx.values.scopeSeed,
        countries: ctx.values.countries,
        country: ctx.values.country,
        minAge: ctx.values.minAge,
        configId: ctx.configId,
      });

      const tx = await ctx.signer.sendTransaction({ data });
      setOutputs((previous) => ({ ...previous, deploymentTxHash: tx.hash }));

      const receipt = await waitForTransaction(ctx.browserProvider, tx.hash);
      if (!receipt.contractAddress) {
        throw new Error('Contract address was not found in deployment receipt.');
      }

      const contractAddress = String(receipt.contractAddress || '');
      ctx.contractAddress = contractAddress;
      ctx.deploymentBlock = Number(receipt.blockNumber || 0);
      setOutputs((previous) => ({ ...previous, censusContract: contractAddress }));

      return receipt.contractAddress;
    },
    [waitForTransaction]
  );

  const startIndexer = useCallback(async (ctx: PipelineContext) => {
    if (!CONFIG.onchainIndexerUrl) {
      throw new Error('Missing VITE_ONCHAIN_CENSUS_INDEXER_URL.');
    }
    if (!ctx.values) {
      throw new Error('Missing process values for indexer bootstrap.');
    }

    const expiresAt = computeIndexerExpiresAt(ctx.values);
    const url = `${trimTrailingSlash(CONFIG.onchainIndexerUrl)}/contracts`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId: ACTIVE_NETWORK.chainId,
        address: ctx.contractAddress,
        startBlock: ctx.deploymentBlock,
        expiresAt,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Indexer bootstrap failed (${response.status}) ${text}`.trim());
    }

    return 'Indexer accepted contract';
  }, []);

  const waitIndexerReady = useCallback(async (ctx: PipelineContext) => {
    const censusUri = buildCensusUri(ctx.contractAddress);
    const queryUri = toHttpCensusUri(censusUri);
    setOutputs((previous) => ({ ...previous, censusUri }));

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
          const json = (await response.json()) as { errors?: Array<{ message?: string }> };
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
  }, []);

  const createDavinciProcess = useCallback(async (ctx: PipelineContext) => {
    if (!CONFIG.davinciSequencerUrl) {
      throw new Error('Missing VITE_DAVINCI_SEQUENCER_URL.');
    }
    if (!ctx.values || !ctx.signer) {
      throw new Error('Missing signer or process values for sequencer process creation.');
    }

    const sdk = createSequencerSdk({
      signer: ctx.signer,
      sequencerUrl: CONFIG.davinciSequencerUrl,
    });
    await sdk.init();

    const sequencerCensusUri = toSequencerCensusUri(ctx.censusUri);
    if (!sequencerCensusUri) {
      throw new Error('Missing census URI for sequencer process creation.');
    }

    const question = ctx.values.question;
    const questions = [
      {
        title: { default: question.title },
        description: { default: question.description || '' },
        choices: question.choices.map((choice) => ({
          title: { default: choice.title },
          value: choice.value,
          meta: {},
        })),
      },
    ];

    const metadata = {
      title: { default: ctx.values.title },
      description: { default: ctx.values.description || '' },
      questions,
      type: {
        name: 'single-choice',
        properties: {},
      },
      version: '1.2',
      meta: stringifyMetaValues({
        selfConfig: {
          scope: normalizeScope(ctx.values.scopeSeed),
          countries: ctx.values.countries,
          minAge: ctx.values.minAge,
          country: normalizeCountry(ctx.values.country),
        },
        network: CONFIG.network,
      }),
    };

    const hash = await (sdk.api.sequencer.pushMetadata as any)(metadata as any);
    const metadataUri = sdk.api.sequencer.getMetadataUrl(hash);

    const census = new OnchainCensus(ctx.contractAddress, sequencerCensusUri);
    const processConfig = {
      metadataUri,
      census,
      maxVoters: ctx.values.maxVoters,
      ballot: ctx.values.ballot,
      timing: {
        duration: ctx.values.duration,
      },
    };

    const result = await sdk.createProcess(processConfig);
    const processId = normalizeProcessId(result.processId);
    if (!processId) throw new Error('Process creation did not return a process ID.');

    ctx.sdk = sdk;
    ctx.processId = processId;

    setOutputs((previous) => ({
      ...previous,
      processId,
      processTxHash: String((result as any).txHash || (result as any).transactionHash || ''),
    }));

    return `Process created (${processId})`;
  }, []);

  const waitProcessReadyInSequencer = useCallback(async (ctx: PipelineContext) => {
    const timeoutMs = 90_000;
    const start = Date.now();
    let lastError = '';

    while (Date.now() - start < timeoutMs) {
      try {
        const process = await getProcessFromSequencer(ctx.sdk, ctx.processId);
        if (process && process.isAcceptingVotes === true) {
          const voteUrl = buildVoteUrl(ctx.processId);
          setOutputs((previous) => ({ ...previous, voteUrl }));
          return 'Process is ready in sequencer';
        }
        lastError = 'Process is not accepting votes yet';
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Sequencer lookup failed';
      }
      await wait(3_000);
    }

    throw new Error(`Sequencer readiness timeout. Last error: ${lastError}`);
  }, []);

  const handleCopyVoteUrl = useCallback(async () => {
    if (!outputs.voteUrl) return;
    try {
      await navigator.clipboard.writeText(outputs.voteUrl);
    } catch {
      // No inline status in create form.
    }
  }, [outputs.voteUrl]);

  const closeCreateOverlay = useCallback(() => {
    if (createSubmitting) return;
    setOverlayState({ dismissed: true });
  }, [createSubmitting]);

  const handleCreateSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (createSubmitting) return;
      if (!creatorConnected) {
        return;
      }

      try {
        collectCreateFormValues();
      } catch (error) {
        console.warn('[OpenCitizenCensus] Create form validation failed before submit', error);
        return;
      }

      setOutputs(EMPTY_OUTPUTS);
      setPipeline(newPipelineState());
      setOverlayState(createInitialOverlayState());
      setCreateSubmitting(true);

      const ctx: PipelineContext = {
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

        if (ctx.values && ctx.processId) {
          persistProcessMeta(ctx.processId, {
            contractAddress: ctx.contractAddress,
            censusUri: ctx.censusUri,
            title: ctx.values.title,
            scopeSeed: ctx.values.scopeSeed,
            countries: ctx.values.countries,
            country: ctx.values.country,
            minAge: ctx.values.minAge,
            network: CONFIG.network,
            updatedAt: new Date().toISOString(),
          });
          persistVoteScopeSeed(ctx.processId, ctx.values.scopeSeed);
        }

        setForm(createInitialFormState());
        setCountryQuery('');
        closeCountriesMenu();
        setCreateFormDirty(false);
      } catch (error) {
        console.error('[OpenCitizenCensus] Create pipeline failed', error);
      } finally {
        setCreateSubmitting(false);
      }
    },
    [
      collectCreateFormValues,
      creatorConnected,
      createDavinciProcess,
      createSubmitting,
      deployCensusContract,
      ensureCreatorWalletForPipeline,
      ensureSelfConfigRegistered,
      runStage,
      startIndexer,
      waitIndexerReady,
      waitProcessReadyInSequencer,
      closeCountriesMenu,
    ]
  );

  return (
    <section id="createView" className="view create-route">
      <AppNavbar id="appNavbar" brandId="navbarBrand" baseHref={baseUrl} logoSrc={withBase('davinci_logo.png')} brandLabel="Ask The World">
        <article
          className="vote-lifecycle-card vote-lifecycle-header-card create-wallet-widget"
          id="createWalletWidget"
          data-state={creatorConnected ? 'ready' : 'paused'}
        >
          <div className="vote-lifecycle-head">
            <div className="create-wallet-summary">
              <div className="vote-lifecycle-left">
                <span className="vote-lifecycle-dot" aria-hidden="true" />
                <strong id="createWalletWidgetTitle">Creator Wallet</strong>
              </div>
              <p
                id="creatorWalletNavbarAddress"
                className="create-wallet-address"
                data-connected={creatorConnected ? 'true' : 'false'}
                title={creatorConnected ? creatorWallet.address : 'Disconnected'}
              >
                {creatorConnected ? creatorWallet.address : 'Disconnected'}
              </p>
            </div>
          </div>
          {creatorConnected && (
            <div className="vote-header-actions create-wallet-actions">
              <button
                id="disconnectCreatorWalletBtn"
                type="button"
                className="cta-btn secondary"
                onClick={() => void handleCreatorWalletButton()}
              >
                <span className="btn-icon iconoir-log-out" aria-hidden="true" />
                <span>Disconnect</span>
              </button>
            </div>
          )}
        </article>
      </AppNavbar>

      <header className={`app-header create-header question-hero-header ${overlayVisible ? 'form-blurred' : ''}`} id="appHeader">
        <h1 id="appHeaderTitle" className="question-hero-title">
          What do you want to ask?
        </h1>
        <p className="create-intro question-hero-helper">
          Ask a question to one or more countries. Citizens who match your criteria can authenticate with their ID or
          passport and vote immediately, using{' '}
          <a className="field-link" href="https://self.xyz" target="_blank" rel="noreferrer">
            <strong>Self.xyz</strong>
          </a>{' '}
          app.
          <br />
          The{' '}
          <a className="field-link" href="https://davinci.vote" target="_blank" rel="noreferrer">
            <strong>DAVINCI</strong>
          </a>{' '}
          Protocol makes every vote anonymous, verifiable from end to end, and protected against censorship, coercion,
          and bribery.
        </p>
      </header>

      <form
        id="createForm"
        className={`create-form ${overlayVisible ? 'form-blurred' : ''}`}
        onSubmit={(event) => void handleCreateSubmit(event)}
      >
        <input
          id="processTitle"
          name="process_title"
          className="hero-input"
          autoComplete="off"
          type="text"
          placeholder="Type your question here..."
          required
          disabled={formLocked}
          value={form.processTitle}
          onChange={(event) => updateForm({ processTitle: stripNonAscii(event.target.value) })}
        />

        <section className="options-section">
          <h2 className="options-title">The options</h2>
          <div id="questionList" className="options-list">
            {form.options.map((option, index) => (
              <div className="option-row" key={`option-${index}`}>
                <input
                  type="text"
                  className="option-input"
                  autoComplete="off"
                  placeholder={`Option ${index + 1}`}
                  disabled={formLocked}
                  value={option.title}
                  onChange={(event) => updateOptionRow(index, event.target.value)}
                />
                <button
                  type="button"
                  className="option-remove-btn"
                  data-action="remove-option"
                  title="Remove"
                  disabled={formLocked || form.options.length <= MIN_OPTIONS}
                  onClick={() => removeOptionRow(index)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            id="addQuestion"
            type="button"
            className="add-option-btn"
            disabled={formLocked || form.options.length >= MAX_OPTIONS}
            onClick={addOptionRow}
          >
            + Add a new option
          </button>
        </section>

        <h2 className="options-title">
          Who can vote and for how long?
          <span
            className="tooltip-icon"
            data-tooltip={ELIGIBILITY_TOOLTIP}
            aria-label="Eligibility information"
            tabIndex={0}
            role="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M9.09445 9.17647C9.28014 8.48398 9.91036 8 10.6272 8H12.9863C13.8149 8 14.4866 8.67175 14.4866 9.50035C14.4866 10.2796 13.5677 10.8752 12.8727 11.2359L12.0003 11.6888V13.0118M12.0003 15.6588V15.8794"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </h2>

        <div className="setting-cards">
          <div className="setting-card setting-card-countries" title="Select up to five countries allowed to vote">
            <span className="setting-label">Country</span>
            <p className="setting-country-helper">
              Select up to {MAX_NATIONALITIES} countries ({selectedCountriesCount}/{MAX_NATIONALITIES})
            </p>
            <div
              ref={countriesSelectRef}
              className={`country-multiselect ${countriesMenuOpen ? 'is-open' : ''} ${formLocked ? 'is-disabled' : ''}`}
            >
              <div
                id="country"
                className="country-multiselect-trigger"
                onClick={() => {
                  if (formLocked) return;
                  setCountriesMenuOpen(true);
                  countryQueryInputRef.current?.focus();
                }}
              >
                <div className="country-chip-list">
                  {form.countries.map((code) => (
                    <span className="country-chip" key={code}>
                      <span className="country-chip-text">
                        {getCountryLabel(code)} ({code})
                      </span>
                      <button
                        type="button"
                        className="country-chip-remove"
                        aria-label={`Remove ${getCountryLabel(code)}`}
                        disabled={formLocked}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleCountrySelection(code);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    ref={countryQueryInputRef}
                    id="countryQuery"
                    className="country-query-input"
                    type="text"
                    autoComplete="off"
                    role="combobox"
                    aria-label="Choose allowed countries"
                    aria-haspopup="listbox"
                    aria-expanded={countriesMenuOpen}
                    aria-controls="countryList"
                    aria-activedescendant={activeCountryOptionId}
                    aria-disabled={formLocked}
                    disabled={formLocked}
                    placeholder="Type to search countries..."
                    value={countryQuery}
                    onChange={handleCountryQueryChange}
                    onFocus={() => {
                      if (formLocked) return;
                      setCountriesMenuOpen(true);
                    }}
                    onKeyDown={handleCountryQueryKeyDown}
                  />
                </div>
                <span className="country-multiselect-caret" aria-hidden="true">
                  ▾
                </span>
              </div>

              <div id="countryList" className="country-dropdown" role="listbox" aria-label="Allowed countries" aria-multiselectable="true">
                {filteredCountryOptions.length === 0 ? (
                  <div className="country-dropdown-empty" role="status" aria-live="polite">
                    No countries found
                  </div>
                ) : (
                  filteredCountryOptions.map((option, optionIndex) => {
                    const checked = form.countries.includes(option.code);
                    const disabled = formLocked || (!checked && countriesLimitReached);
                    const isActive = optionIndex === activeCountryIndex;
                    return (
                      <button
                        key={option.code}
                        id={`country-option-${option.code}`}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        className={`country-dropdown-option ${checked ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`}
                        disabled={disabled}
                        onMouseEnter={() => setActiveCountryIndex(optionIndex)}
                        onClick={() => handleCountrySelect(option.code)}
                      >
                        <span className="country-dropdown-check" aria-hidden="true">
                          {checked ? '✓' : ''}
                        </span>
                        <span className="country-dropdown-label">
                          {option.label} ({option.code})
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <div className="setting-card" title="Minimum age required to vote">
            <span className="setting-label">Minimum age to vote</span>
            <div className="setting-value-row">
              <button
                type="button"
                className="setting-step-btn"
                aria-label="Decrease minimum age"
                disabled={formLocked}
                onClick={() => adjustMinAge(-1)}
              >
                −
              </button>
              <input
                id="minAge"
                name="min_age"
                className="setting-value-input"
                autoComplete="off"
                type="number"
                min={1}
                max={99}
                required
                disabled={formLocked}
                value={form.minAge}
                onChange={(event) => updateForm({ minAge: event.target.value })}
              />
              <button
                type="button"
                className="setting-step-btn"
                aria-label="Increase minimum age"
                disabled={formLocked}
                onClick={() => adjustMinAge(1)}
              >
                +
              </button>
            </div>
          </div>

          <div className="setting-card" title="How long the voting process will remain open">
            <span className="setting-label">Vote duration</span>
            <div className="setting-value-row">
              <button
                type="button"
                className="setting-step-btn"
                aria-label="Decrease vote duration"
                disabled={formLocked}
                onClick={() => adjustDurationHours(-1)}
              >
                −
              </button>
              <input
                id="durationHours"
                name="duration_hours"
                className="setting-value-input"
                autoComplete="off"
                type="number"
                min={1}
                required
                disabled={formLocked}
                value={form.durationHours}
                onChange={(event) => updateForm({ durationHours: event.target.value })}
              />
              <button
                type="button"
                className="setting-step-btn"
                aria-label="Increase vote duration"
                disabled={formLocked}
                onClick={() => adjustDurationHours(1)}
              >
                +
              </button>
              <span className="setting-value-suffix">Hours</span>
            </div>
          </div>
        </div>

        <input id="scopeSeed" type="hidden" name="scope_seed" value="" readOnly />
        <input id="startDate" type="hidden" name="start_datetime" value="" readOnly />

        <details className="advanced-details" id="advancedDetails">
          <summary className="advanced-summary">▾ Advanced Settings</summary>
          <div className="advanced-body">
            <div className="advanced-field">
              <span className="advanced-field-label">Maximum voters</span>
              <input
                id="maxVoters"
                name="max_voters"
                className="advanced-field-input"
                autoComplete="off"
                type="number"
                min={1}
                required
                disabled={formLocked}
                value={form.maxVoters}
                onChange={(event) => updateForm({ maxVoters: event.target.value })}
              />
              <span className="advanced-field-helper">Limit the number of participants.</span>
            </div>
          </div>
        </details>

        <div className="create-actions">
          {creatorConnected ? (
            <button id="createBtn" type="submit" className="cta-btn" disabled={formLocked}>
              <span className={`btn-icon ${createSubmitting ? 'iconoir-refresh' : 'iconoir-check-circle'}`} aria-hidden="true" />
              <span>{createSubmitting ? 'Creating process...' : 'Create the voting process'}</span>
            </button>
          ) : (
            <button
              id="connectCreatorWalletBtn"
              type="button"
              className="cta-btn cta-btn-connect"
              disabled={formLocked}
              onClick={() => void handleCreatorWalletButton()}
            >
              <span className="btn-icon iconoir-wallet" aria-hidden="true" />
              <span>Connect wallet to create</span>
            </button>
          )}
        </div>

        <p id="creatorWalletAddress" hidden>
          {creatorWallet.address}
        </p>
        <p id="creatorWalletStatus" hidden>
          {creatorWalletStatus}
        </p>
      </form>

      <PopupModal
        id="createOverlay"
        open={overlayVisible}
        title={hasSuccessOutput ? 'Process created' : spinnerActive ? 'Creating process...' : 'Process creation status'}
        titleId="createOverlayTitle"
        className="create-overlay"
        cardClassName={hasSuccessOutput ? 'create-overlay-card create-success-popup-card' : 'create-overlay-card create-timeline-popup-card'}
        bodyClassName="create-overlay-body"
        closeButtonId="createTimelineCloseBtn"
        closeLabel="Close creation popup"
        onClose={canDismissOverlay ? closeCreateOverlay : undefined}
        backdropClosable={canDismissOverlay}
      >
        <details ref={createTimelineRef} className="create-timeline-panel" id="createTimelineCard" hidden={!showTimeline || hasSuccessOutput}>
          <summary className="create-timeline-summary">
            <div className="create-timeline-summary-main">
              <p className="timeline-popup-status">
                <span id="createSpinner" className="timeline-spinner" aria-hidden="true" hidden={!spinnerActive} />
                <span id="createTimelineSummaryText">{spinnerActive ? 'Creating process...' : 'Process creation status'}</span>
              </p>
              <span className="create-timeline-chevron" aria-hidden="true">
                ▾
              </span>
            </div>
            <p className="timeline-popup-subtitle" hidden={!spinnerActive}>
              Keep your wallet open. You will be prompted to confirm transactions and sign messages during setup.
            </p>
          </summary>
          <div className="create-timeline-body">
            <ol id="timeline" className="timeline">
              {timelineEntries.map((entry) => {
                const isRunning = entry.status.status === 'running';
                const isError = entry.status.status === 'error';
                const isCompleted = entry.status.status === 'success';
                const isDone = entry.stage.id === 'done';

                return (
                  <li
                    key={entry.stage.id}
                    className={`timeline-item ${isRunning ? 'is-current' : ''} ${isError ? 'is-error' : ''} ${
                      isCompleted ? 'is-completed' : ''
                    } ${isDone && isCompleted ? 'is-done' : ''}`}
                  >
                    <span className="timeline-marker" aria-hidden="true" />
                    <div className="timeline-content">
                      <p className="timeline-label">{entry.stage.label}</p>
                      <p className="timeline-meta">{entry.status.message || 'Running'}</p>
                      {entry.stage.id === 'done' && entry.status.status === 'success' && Boolean(outputs.voteUrl) && (
                        <div id="timelineVoteUrlWrap" className="timeline-vote-url">
                          <div className="output-link-actions">
                            <a
                              id="outVoteUrl"
                              className="timeline-vote-link"
                              href={outputs.voteUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {outputs.voteUrl}
                            </a>
                            <button id="copyVoteUrlBtn" type="button" className="ghost" onClick={() => void handleCopyVoteUrl()}>
                              <span className="btn-icon iconoir-copy" aria-hidden="true" />
                              <span className="btn-text">Copy link</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    {isRunning && <span className="timeline-spinner" aria-hidden="true" />}
                  </li>
                );
              })}
            </ol>
          </div>
        </details>

        <article className="success-card" id="createOutputsCard" hidden={!hasSuccessOutput}>
          <div className="success-header">
            <span className="iconoir-check-circle success-icon" aria-hidden="true" />
            <h2>Your voting process is live and ready for the world.</h2>
          </div>

          <div className="vote-link-wrapper">
            <label className="vote-link-label">Share this link to start collecting votes</label>
            <div className="vote-link-box">
              <a
                id="outVoteUrlSuccess"
                className="vote-link-text"
                href={outputs.voteUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                {outputs.voteUrl || '-'}
              </a>
              <button id="copyVoteUrlBtnSuccess" type="button" className="icon-btn" title="Copy link" onClick={() => void handleCopyVoteUrl()}>
                <span className="iconoir-copy" aria-hidden="true" />
              </button>
            </div>

            <div className="vote-share-wrapper" id="createShareLinks" hidden={shareTargets.length === 0}>
              <span className="vote-share-label">Share on social networks</span>
              <div className="vote-share-grid">
                {shareTargets.map((target) => (
                  <a
                    key={target.id}
                    id={`shareVoteUrl${target.id}`}
                    className={`share-link-btn share-link-btn--${target.id}`}
                    href={target.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Share on ${target.label}`}
                    title={`Share on ${target.label}`}
                    data-fallback={target.fallbackText}
                  >
                    {target.id === 'linkedin' ? (
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        className="share-link-inline-icon"
                        focusable="false"
                      >
                        <circle cx="7" cy="7" r="1.5" fill="#1f2a3a" />
                        <rect x="5.7" y="10" width="2.6" height="8.3" fill="#1f2a3a" />
                        <path
                          d="M10.4 10h2.5v1.2c.5-.8 1.4-1.4 2.8-1.4 2.5 0 3.4 1.6 3.4 4.2v4.3h-2.7v-3.8c0-1.3-.2-2.5-1.4-2.5-1.2 0-1.6.8-1.6 2.4v3.9h-2.9z"
                          fill="#1f2a3a"
                        />
                      </svg>
                    ) : (
                      <img
                        src={target.iconSrc}
                        alt={target.label}
                        loading="lazy"
                        decoding="async"
                        onError={(event) => {
                          const element = event.currentTarget;
                          if (element.dataset.fallbackApplied !== '1' && target.iconFallbackSrc) {
                            element.dataset.fallbackApplied = '1';
                            element.src = target.iconFallbackSrc;
                            return;
                          }
                          element.style.display = 'none';
                          const button = element.closest('.share-link-btn');
                          if (button instanceof HTMLElement) {
                            button.classList.add('share-link-btn--fallback');
                          }
                        }}
                      />
                    )}
                  </a>
                ))}
              </div>
            </div>
          </div>

          <details className="final-details">
            <summary>Advanced Details</summary>
            <dl className="outputs" hidden={!outputsVisible}>
              <div id="outputContractItem" className="output-item" hidden={!outputs.censusContract}>
                <dt>Census contract</dt>
                <dd id="outContract" className="output-scroll">
                  {outputs.censusContract || '-'}
                </dd>
              </div>
              <div id="outputDeployTxItem" className="output-item" hidden={!outputs.deploymentTxHash}>
                <dt>Deployment tx</dt>
                <dd id="outDeployTx" className="output-scroll">
                  {outputs.deploymentTxHash || '-'}
                </dd>
              </div>
              <div id="outputCensusUriItem" className="output-item" hidden={!outputs.censusUri}>
                <dt>Census URI</dt>
                <dd id="outCensusUri" className="output-scroll">
                  {outputs.censusUri || '-'}
                </dd>
              </div>
              <div id="outputProcessIdItem" className="output-item" hidden={!outputs.processId}>
                <dt>Process ID</dt>
                <dd id="outProcessId" className="output-scroll">
                  {outputs.processId || '-'}
                </dd>
              </div>
              <div id="outputProcessTxItem" className="output-item" hidden={!outputs.processTxHash}>
                <dt>Process tx</dt>
                <dd id="outProcessTx" className="output-scroll">
                  {outputs.processTxHash || '-'}
                </dd>
              </div>
            </dl>
          </details>
        </article>
      </PopupModal>
    </section>
  );
}
