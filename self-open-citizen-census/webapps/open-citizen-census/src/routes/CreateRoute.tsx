import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, type JsonRpcSigner } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { DavinciSDK, OnchainCensus } from '@vocdoni/davinci-sdk';

import {
  ACTIVE_NETWORK,
  CENSUS_MEMBERS_QUERY,
  CONFIG,
  HUB_INTERFACE,
  INTERNAL_RPC_RETRY_DELAY_MS,
  INTERNAL_RPC_RETRY_MAX_ATTEMPTS,
  MAX_QUESTIONS,
  NETWORKS,
  PIPELINE_STAGES,
  buildBallotFromQuestions,
  buildCensusUri,
  buildDeployData,
  buildVoteUrl,
  collectErrorMessages,
  computeConfigId,
  computeIndexerExpiresAt,
  ensureAsciiField,
  isInternalJsonRpcError,
  newPipelineState,
  persistProcessMeta,
  persistVoteScopeSeed,
  stringifyMetaValues,
  toDateTimeLocal,
  toHttpCensusUri,
  toSequencerCensusUri,
  trimTrailingSlash,
  wait,
  type CreateQuestion,
  type CreateValues,
  type PipelineStageState,
} from '../lib/occ';
import {
  isAsciiText,
  normalizeCountry,
  normalizeMinAge,
  normalizeProcessId,
  normalizeScope,
  stripNonAscii,
} from '../utils/normalization';

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  enable?: () => Promise<any>;
  disconnect?: () => Promise<void>;
  isMetaMask?: boolean;
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: Eip1193Provider[];
}

interface CreatorWalletState {
  provider: Eip1193Provider | null;
  browserProvider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
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

interface CreateFormState {
  country: string;
  minAge: string;
  scopeSeed: string;
  processTitle: string;
  processDescription: string;
  maxVoters: string;
  startDate: string;
  durationHours: string;
  questions: CreateQuestion[];
}

interface PipelineContext {
  values: CreateValues | null;
  configId: string;
  provider: Eip1193Provider | null;
  browserProvider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  creatorAddress: string;
  contractAddress: string;
  deploymentBlock: number;
  censusUri: string;
  sdk: any;
  processId: string;
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

function getDefaultQuestions(): CreateQuestion[] {
  return [
    {
      title: '',
      description: '',
      choices: [
        { title: 'Yes', value: 0 },
        { title: 'No', value: 1 },
      ],
    },
  ];
}

function getInitialFormState(): CreateFormState {
  return {
    country: '',
    minAge: '18',
    scopeSeed: '',
    processTitle: '',
    processDescription: '',
    maxVoters: '10000',
    startDate: toDateTimeLocal(new Date(Date.now() + 10 * 60 * 1000)),
    durationHours: '24',
    questions: getDefaultQuestions(),
  };
}

function getInjectedProvider(): Eip1193Provider | null {
  const ethereum = (window as any).ethereum as Eip1193Provider | undefined;
  if (!ethereum) return null;

  if (Array.isArray(ethereum.providers) && ethereum.providers.length) {
    const metamaskProvider = ethereum.providers.find((provider) => provider?.isMetaMask && !provider?.isBraveWallet);
    return metamaskProvider || ethereum.providers[0] || null;
  }

  return ethereum;
}

function getWalletSourceLabel(provider: Eip1193Provider, fallback = 'WalletConnect'): string {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  return fallback;
}

function hasAnyOutputs(outputs: CreateOutputs): boolean {
  return Boolean(
    outputs.censusContract || outputs.deploymentTxHash || outputs.censusUri || outputs.processId || outputs.processTxHash
  );
}

function hasPipelineActivity(pipeline: PipelineStageState[]): boolean {
  return pipeline.some((stage) => stage.status !== 'pending' || stage.message !== 'Pending');
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

function sanitizeQuestionAscii(questions: CreateQuestion[]): CreateQuestion[] {
  return questions.map((question) => ({
    ...question,
    title: stripNonAscii(question.title),
    description: stripNonAscii(question.description),
    choices: question.choices.map((choice) => ({
      ...choice,
      title: stripNonAscii(choice.title),
    })),
  }));
}

export default function CreateRoute() {
  const [createStep, setCreateStep] = useState(1);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createFormDirty, setCreateFormDirty] = useState(false);

  const [createStatus, setCreateStatus] = useState<{ message: string; error: boolean }>({
    message: '',
    error: false,
  });

  const [creatorWalletStatus, setCreatorWalletStatus] = useState(CREATOR_WALLET_STATUS_DEFAULT);
  const [creatorWallet, setCreatorWallet] = useState<CreatorWalletState>({
    provider: null,
    browserProvider: null,
    signer: null,
    address: '',
    sourceLabel: '',
  });

  const [form, setForm] = useState<CreateFormState>(getInitialFormState);
  const [pipeline, setPipeline] = useState<PipelineStageState[]>(newPipelineState);
  const [outputs, setOutputs] = useState<CreateOutputs>(EMPTY_OUTPUTS);

  const walletRef = useRef(creatorWallet);

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
      setCreateStatus({ message: `Missing env vars: ${missing.join(', ')}`, error: true });
      return;
    }

    setCreateStatus({ message: 'Environment looks good. Connect wallet to unlock the create form.', error: false });
  }, []);

  useEffect(() => {
    document.title = 'Open Citizen Census';
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
  const timelineVisible = createSubmitting || hasPipelineActivity(pipeline) || Boolean(outputs.voteUrl);
  const outputsVisible = hasAnyOutputs(outputs);
  const timelineEntries = useMemo(() => timelineRows(pipeline), [pipeline]);

  const setStatus = useCallback((message: string, error = false) => {
    setCreateStatus({ message, error });
  }, []);

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

  const ensureProviderChain = useCallback(async (provider: Eip1193Provider) => {
    const currentChainId = await provider.request({ method: 'eth_chainId' });
    if (String(currentChainId).toLowerCase() === ACTIVE_NETWORK.chainHex.toLowerCase()) {
      return;
    }

    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ACTIVE_NETWORK.chainHex }],
    });
  }, []);

  const applyWalletConnection = useCallback((connection: CreatorWalletState) => {
    setCreatorWallet(connection);
    setCreatorWalletStatus(`Connected with ${connection.sourceLabel} on ${ACTIVE_NETWORK.label}.`);
  }, []);

  const createWalletConnectProvider = useCallback(async () => {
    if (!CONFIG.walletConnectProjectId) {
      throw new Error('Missing VITE_WALLETCONNECT_PROJECT_ID.');
    }

    const requiredChains = [1];
    const optionalChainsValues = Array.from(
      new Set([1, ACTIVE_NETWORK.chainId, ...Object.values(NETWORKS).map((network) => network.chainId)])
    );
    const optionalChains = (optionalChainsValues.length ? optionalChainsValues : [1]) as [number, ...number[]];

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
    }) as Promise<Eip1193Provider>;
  }, []);

  const connectInjectedWallet = useCallback(
    async (provider: Eip1193Provider): Promise<CreatorWalletState> => {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || !accounts.length) {
        throw new Error('No wallet account selected.');
      }
      await ensureProviderChain(provider);

      const browserProvider = new BrowserProvider(provider as any, 'any');
      const signer = await browserProvider.getSigner(accounts[0]);
      const address = await signer.getAddress();
      const connection: CreatorWalletState = {
        provider,
        browserProvider,
        signer,
        address,
        sourceLabel: getWalletSourceLabel(provider, 'Browser wallet'),
      };
      applyWalletConnection(connection);
      return connection;
    },
    [applyWalletConnection, ensureProviderChain]
  );

  const connectWalletConnect = useCallback(async (): Promise<CreatorWalletState> => {
    let provider = walletRef.current.provider;

    if (!provider || typeof provider.enable !== 'function') {
      provider = await createWalletConnectProvider();
    }

    await provider.enable?.();
    await ensureProviderChain(provider);

    const browserProvider = new BrowserProvider(provider as any, 'any');
    const signer = await browserProvider.getSigner();
    const address = await signer.getAddress();
    const connection: CreatorWalletState = {
      provider,
      browserProvider,
      signer,
      address,
      sourceLabel: 'WalletConnect',
    };
    applyWalletConnection(connection);
    return connection;
  }, [applyWalletConnection, createWalletConnectProvider, ensureProviderChain]);

  const connectBrowserWallet = useCallback(async (): Promise<CreatorWalletState> => {
    const injectedProvider = getInjectedProvider();
    if (injectedProvider) {
      return connectInjectedWallet(injectedProvider);
    }
    return connectWalletConnect();
  }, [connectInjectedWallet, connectWalletConnect]);

  const disconnectWalletConnection = useCallback(async () => {
    const provider = walletRef.current.provider;

    if (provider && typeof provider.disconnect === 'function' && typeof provider.enable === 'function') {
      try {
        await provider.disconnect();
      } catch {
        // Ignore provider disconnect errors and clear local app state anyway.
      }
    }

    setCreatorWallet({
      provider: null,
      browserProvider: null,
      signer: null,
      address: '',
      sourceLabel: '',
    });
    setCreatorWalletStatus(CREATOR_WALLET_STATUS_DEFAULT);
    setStatus('Creator wallet disconnected.');
  }, [setStatus]);

  const connectCreatorWallet = useCallback(async () => {
    try {
      setCreatorWalletStatus('Connecting browser wallet...');
      await connectBrowserWallet();
      setStatus('Creator wallet connected. Continue with step 2.');
    } catch (error) {
      const messages = collectErrorMessages(error);
      const message = messages[0] || (error instanceof Error ? error.message : 'Failed to connect creator wallet.');
      setCreatorWalletStatus(message);
      setStatus(message, true);
    }
  }, [connectBrowserWallet, setStatus]);

  const handleCreatorWalletButton = useCallback(async () => {
    if (walletRef.current.address) {
      await disconnectWalletConnection();
      return;
    }
    await connectCreatorWallet();
  }, [connectCreatorWallet, disconnectWalletConnection]);

  const updateForm = useCallback((patch: Partial<CreateFormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setCreateFormDirty(true);
  }, []);

  const updateQuestion = useCallback((questionIndex: number, patch: Partial<CreateQuestion>) => {
    setForm((previous) => ({
      ...previous,
      questions: previous.questions.map((question, index) =>
        index === questionIndex
          ? {
              ...question,
              ...patch,
            }
          : question
      ),
    }));
    setCreateFormDirty(true);
  }, []);

  const addQuestion = useCallback(() => {
    setForm((previous) => {
      if (previous.questions.length >= MAX_QUESTIONS) return previous;
      return {
        ...previous,
        questions: [...previous.questions, { title: '', description: '', choices: [{ title: 'Yes', value: 0 }, { title: 'No', value: 1 }] }],
      };
    });
    setCreateFormDirty(true);
  }, []);

  const removeQuestion = useCallback((questionIndex: number) => {
    setForm((previous) => {
      if (previous.questions.length <= 1) return previous;
      return {
        ...previous,
        questions: previous.questions.filter((_, index) => index !== questionIndex),
      };
    });
    setCreateFormDirty(true);
  }, []);

  const addChoice = useCallback((questionIndex: number) => {
    setForm((previous) => {
      const nextQuestions = previous.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        return {
          ...question,
          choices: [...question.choices, { title: '', value: question.choices.length }],
        };
      });
      return {
        ...previous,
        questions: nextQuestions,
      };
    });
    setCreateFormDirty(true);
  }, []);

  const removeChoice = useCallback((questionIndex: number, choiceIndex: number) => {
    setForm((previous) => {
      const nextQuestions = previous.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        if (question.choices.length <= 2) return question;
        const reindexed = question.choices.filter((_, idx) => idx !== choiceIndex).map((choice, idx) => ({ ...choice, value: idx }));
        return {
          ...question,
          choices: reindexed,
        };
      });
      return {
        ...previous,
        questions: nextQuestions,
      };
    });
    setCreateFormDirty(true);
  }, []);

  const updateChoice = useCallback((questionIndex: number, choiceIndex: number, value: string) => {
    setForm((previous) => ({
      ...previous,
      questions: previous.questions.map((question, index) => {
        if (index !== questionIndex) return question;
        return {
          ...question,
          choices: question.choices.map((choice, idx) => (idx === choiceIndex ? { ...choice, title: stripNonAscii(value) } : choice)),
        };
      }),
    }));
    setCreateFormDirty(true);
  }, []);

  const validateStepOne = useCallback(() => {
    const country = normalizeCountry(form.country);
    const minAge = normalizeMinAge(form.minAge);
    const scopeSeed = normalizeScope(form.scopeSeed);

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
    if (!walletRef.current.address) {
      throw new Error('Connect the creator browser wallet before continuing.');
    }
  }, [form.country, form.minAge, form.scopeSeed]);

  const validateStepTwo = useCallback(() => {
    const title = String(form.processTitle || '').trim();
    const description = String(form.processDescription || '').trim();
    const maxVoters = Number(form.maxVoters);
    const durationHours = Number(form.durationHours);

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
  }, [form.durationHours, form.maxVoters, form.processDescription, form.processTitle]);

  const validateStepThree = useCallback(() => {
    const questions = sanitizeQuestionAscii(form.questions);
    if (!questions.length) {
      throw new Error('Add at least one question.');
    }
    for (const [questionIndex, question] of questions.entries()) {
      const title = String(question.title || '').trim();
      if (!title) throw new Error(`Question ${questionIndex + 1} needs a title.`);

      const choices = question.choices.map((choice) => String(choice.title || '').trim()).filter(Boolean);
      if (choices.length < 2) throw new Error(`Question ${questionIndex + 1} needs at least two choices.`);
    }
  }, [form.questions]);

  const validateCurrentStep = useCallback(() => {
    if (createStep === 1) validateStepOne();
    if (createStep === 2) validateStepTwo();
    if (createStep === 3) validateStepThree();
  }, [createStep, validateStepOne, validateStepTwo, validateStepThree]);

  const collectCreateFormValues = useCallback((): CreateValues => {
    const country = normalizeCountry(form.country);
    const minAge = normalizeMinAge(form.minAge);
    const scopeSeed = normalizeScope(form.scopeSeed);
    const title = String(form.processTitle || '').trim();
    const description = String(form.processDescription || '').trim();
    const maxVoters = Number(form.maxVoters);
    const durationHours = Number(form.durationHours);

    if (!/^[A-Z]{2,3}$/.test(country)) {
      throw new Error('Country must be ISO alpha-2 or alpha-3 uppercase.');
    }
    if (!minAge) {
      throw new Error('Minimum age must be between 1 and 99.');
    }
    if (!scopeSeed || scopeSeed.length > 31) {
      throw new Error('Scope seed must contain 1-31 characters.');
    }
    if (!isAsciiText(scopeSeed)) {
      throw new Error('Scope seed must contain ASCII characters only.');
    }
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

    let startDate = form.startDate ? new Date(form.startDate) : new Date(Date.now() + 10 * 60 * 1000);
    if (Number.isNaN(startDate.getTime()) || startDate.getTime() < Date.now()) {
      startDate = new Date(Date.now() + 10 * 60 * 1000);
    }

    const questions = sanitizeQuestionAscii(form.questions).map((question, questionIndex) => {
      const qTitle = String(question.title || '').trim();
      if (!qTitle) {
        throw new Error(`Question ${questionIndex + 1} needs a title.`);
      }
      ensureAsciiField(qTitle, `Question ${questionIndex + 1} title`);

      const qDescription = String(question.description || '').trim();
      ensureAsciiField(qDescription, `Question ${questionIndex + 1} description`);

      const choices = question.choices.map((choice, choiceIndex) => {
        const choiceTitle = String(choice.title || '').trim();
        if (!choiceTitle) {
          throw new Error(`Question ${questionIndex + 1} has an empty choice.`);
        }
        ensureAsciiField(choiceTitle, `Question ${questionIndex + 1} choice ${choiceIndex + 1}`);
        return {
          title: choiceTitle,
          value: choiceIndex,
        };
      });

      if (choices.length < 2) {
        throw new Error(`Question ${questionIndex + 1} needs at least two choices.`);
      }

      return {
        title: qTitle,
        description: qDescription,
        choices,
      };
    });

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
      ballot: buildBallotFromQuestions(questions),
    };
  }, [form]);

  const waitForTransaction = useCallback(async (provider: BrowserProvider, hash: string, timeoutMs = 5 * 60 * 1000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
      await wait(2500);
    }
    throw new Error(`Timed out waiting for tx receipt: ${hash}`);
  }, []);

  const ensureCreatorWalletForPipeline = useCallback(
    async (ctx: PipelineContext) => {
      if (!walletRef.current.signer) {
        const connection = await connectBrowserWallet();
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
    },
    [connectBrowserWallet]
  );

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

  const createDavinciProcess = useCallback(async (ctx: PipelineContext) => {
    if (!CONFIG.davinciSequencerUrl) {
      throw new Error('Missing VITE_DAVINCI_SEQUENCER_URL.');
    }
    if (!ctx.values || !ctx.signer) {
      throw new Error('Missing signer or process values for sequencer process creation.');
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

    const questions = ctx.values.questions.map((question) => ({
      title: { default: question.title },
      description: { default: question.description || '' },
      choices: question.choices.map((choice) => ({
        title: { default: choice.title },
        value: choice.value,
        meta: {},
      })),
    }));

    const metadata = {
      title: { default: ctx.values.title },
      description: { default: ctx.values.description || '' },
      questions,
      type: {
        name: 'single-choice-multiquestion',
        properties: {},
      },
      version: '1.2',
      meta: stringifyMetaValues({
        selfConfig: {
          scope: normalizeScope(ctx.values.scopeSeed),
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
        startDate: ctx.values.startDate,
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

  const waitProcessReadyInSequencer = useCallback(
    async (ctx: PipelineContext) => {
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
    },
    [getProcessFromSequencer]
  );

  const handleStepNext = useCallback(() => {
    try {
      validateCurrentStep();
      setCreateStep((previous) => Math.min(3, previous + 1));
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Step validation failed.', true);
    }
  }, [setStatus, validateCurrentStep]);

  const handleStepBack = useCallback(() => {
    setCreateStep((previous) => Math.max(1, previous - 1));
  }, []);

  const handleCopyVoteUrl = useCallback(async () => {
    if (!outputs.voteUrl) return;
    try {
      await navigator.clipboard.writeText(outputs.voteUrl);
      setStatus('Vote URL copied to clipboard.');
    } catch {
      setStatus('Failed to copy vote URL.', true);
    }
  }, [outputs.voteUrl, setStatus]);

  const handleCreateSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (createSubmitting) return;
      if (createStep !== 3) {
        setStatus('Complete all steps before launching the process.', true);
        return;
      }

      try {
        validateStepThree();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Invalid questions.', true);
        return;
      }

      setOutputs(EMPTY_OUTPUTS);
      setPipeline(newPipelineState());
      setCreateSubmitting(true);
      setStatus('Running launch pipeline...');

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
            country: ctx.values.country,
            minAge: ctx.values.minAge,
            network: CONFIG.network,
            updatedAt: new Date().toISOString(),
          });
          persistVoteScopeSeed(ctx.processId, ctx.values.scopeSeed);
        }

        setCreateFormDirty(false);
        setStatus('Process launched successfully. You can open the generated vote URL.');
      } catch (error) {
        console.error('[OpenCitizenCensus] Create pipeline failed', error);
        setStatus('Pipeline failed. Check the failed stage and browser console for details.', true);
      } finally {
        setCreateSubmitting(false);
      }
    },
    [
      collectCreateFormValues,
      createStep,
      createDavinciProcess,
      createSubmitting,
      deployCensusContract,
      ensureCreatorWalletForPipeline,
      ensureSelfConfigRegistered,
      runStage,
      setStatus,
      startIndexer,
      validateStepThree,
      waitIndexerReady,
      waitProcessReadyInSequencer,
    ]
  );

  const processTitleSafe = stripNonAscii(form.processTitle);
  const processDescriptionSafe = stripNonAscii(form.processDescription);

  const formLocked = !creatorConnected || createSubmitting;

  return (
    <section id="createView" className="view">
      <article className="card">
        <div className="card-head">
          <h2>Create Process</h2>
          <p className="muted">Three-step flow: census parameters, process information, and questions.</p>
        </div>

        <div className="wallet-box">
          <div>
            <p className="value" id="creatorWalletAddress">{creatorWallet.address || 'Wallet not connected yet...'}</p>
            <p className="muted" id="creatorWalletStatus">
              {creatorWalletStatus}
            </p>
          </div>
          <button
            id="connectCreatorWalletBtn"
            type="button"
            className={creatorConnected ? 'disconnect' : 'secondary'}
            onClick={() => void handleCreatorWalletButton()}
          >
            <span className={`btn-icon ${creatorConnected ? 'iconoir-log-out' : 'iconoir-wallet'}`} aria-hidden="true" />
            <span className="btn-text">{creatorConnected ? 'Disconnect wallet' : 'Connect wallet'}</span>
          </button>
        </div>

        <ol className="stepper" id="createStepper">
          {[1, 2, 3].map((step) => {
            const labels = ['Census', 'Process', 'Questions'];
            const icons = ['iconoir-globe', 'iconoir-settings', 'iconoir-chat-bubble'];
            const active = step === createStep;
            const done = step < createStep;
            return (
              <li key={step}>
                <button
                  type="button"
                  className="step-chip"
                  data-step-indicator={step}
                  data-active={active ? 'true' : 'false'}
                  data-done={done ? 'true' : 'false'}
                  disabled={formLocked || step > createStep}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => {
                    if (step < createStep && !formLocked) setCreateStep(step);
                  }}
                >
                  <span className={`step-icon ${icons[step - 1]}`} aria-hidden="true" />
                  <span>{labels[step - 1]}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <form id="createForm" className="wizard" onSubmit={(event) => void handleCreateSubmit(event)}>
          {createStep === 1 && (
            <section className="step-panel" data-step-panel="1">
              <h3>Census Parameters</h3>

              <div className="grid two">
                <label>
                  Country (ISO alpha-2/3)
                  <input
                    id="country"
                    name="country"
                    autoComplete="off"
                    type="text"
                    maxLength={3}
                    placeholder="ESP…"
                    required
                    disabled={formLocked}
                    value={form.country}
                    onChange={(event) => updateForm({ country: stripNonAscii(event.target.value).toUpperCase() })}
                  />
                </label>
                <label>
                  Minimum age
                  <input
                    id="minAge"
                    name="min_age"
                    autoComplete="off"
                    type="number"
                    min={1}
                    max={99}
                    value={form.minAge}
                    required
                    disabled={formLocked}
                    onChange={(event) => updateForm({ minAge: event.target.value })}
                  />
                </label>
              </div>

              <p className="field-helper">
                Use two or three-letter uppercase code.
                <a
                  className="field-link"
                  href="https://docs.self.xyz/use-self/self-map-countries-list"
                  target="_blank"
                  rel="noreferrer"
                >
                  View the supported country codes.
                </a>
              </p>

              <label>
                Scope seed
                <input
                  id="scopeSeed"
                  name="scope_seed"
                  autoComplete="off"
                  type="text"
                  maxLength={31}
                  placeholder="open-citizen-census…"
                  required
                  disabled={formLocked}
                  value={form.scopeSeed}
                  onChange={(event) => updateForm({ scopeSeed: stripNonAscii(event.target.value) })}
                />
              </label>
            </section>
          )}

          {createStep === 2 && (
            <section className="step-panel" data-step-panel="2">
              <h3>Process Information</h3>

              <div className="grid two">
                <label>
                  Process title
                  <input
                    id="processTitle"
                    name="process_title"
                    autoComplete="off"
                    type="text"
                    placeholder="Community budget vote…"
                    required
                    disabled={formLocked}
                    value={processTitleSafe}
                    onChange={(event) => updateForm({ processTitle: stripNonAscii(event.target.value) })}
                  />
                </label>
                <label>
                  Maximum voters
                  <input
                    id="maxVoters"
                    name="max_voters"
                    autoComplete="off"
                    type="number"
                    min={1}
                    value={form.maxVoters}
                    required
                    disabled={formLocked}
                    onChange={(event) => updateForm({ maxVoters: event.target.value })}
                  />
                </label>
              </div>

              <label>
                Process description
                <textarea
                  id="processDescription"
                  name="process_description"
                  autoComplete="off"
                  rows={2}
                  placeholder="Optional context for voters…"
                  disabled={formLocked}
                  value={processDescriptionSafe}
                  onChange={(event) => updateForm({ processDescription: stripNonAscii(event.target.value) })}
                />
              </label>

              <div className="grid two">
                <label>
                  Start datetime
                  <input
                    id="startDate"
                    name="start_datetime"
                    autoComplete="off"
                    type="datetime-local"
                    disabled={formLocked}
                    value={form.startDate}
                    onChange={(event) => updateForm({ startDate: event.target.value })}
                  />
                </label>
                <label>
                  Duration (hours)
                  <input
                    id="durationHours"
                    name="duration_hours"
                    autoComplete="off"
                    type="number"
                    min={1}
                    value={form.durationHours}
                    required
                    disabled={formLocked}
                    onChange={(event) => updateForm({ durationHours: event.target.value })}
                  />
                </label>
              </div>
            </section>
          )}

          {createStep === 3 && (
            <section className="step-panel" data-step-panel="3">
              <div className="section-head">
                <h3>Questions</h3>
                <button id="addQuestion" type="button" className="secondary" disabled={formLocked || form.questions.length >= MAX_QUESTIONS} onClick={addQuestion}>
                  <span className="btn-icon iconoir-plus" aria-hidden="true" />
                  <span className="btn-text">Add question</span>
                </button>
              </div>

              <p className="muted">Add at least one question with two or more choices.</p>

              <div id="questionList">
                {form.questions.map((question, questionIndex) => (
                  <article className="question-card" key={questionIndex}>
                    <div className="question-head">
                      <strong className="question-index">Question {questionIndex + 1}</strong>
                      <button
                        type="button"
                        className="ghost"
                        disabled={formLocked || form.questions.length <= 1}
                        onClick={() => removeQuestion(questionIndex)}
                      >
                        Remove
                      </button>
                    </div>

                    <label>
                      Title
                      <input
                        type="text"
                        className="question-title"
                        placeholder="What should this process decide?…"
                        autoComplete="off"
                        required
                        disabled={formLocked}
                        value={question.title}
                        onChange={(event) => updateQuestion(questionIndex, { title: stripNonAscii(event.target.value) })}
                      />
                    </label>

                    <label>
                      Description
                      <textarea
                        className="question-description"
                        rows={2}
                        autoComplete="off"
                        placeholder="Optional context…"
                        disabled={formLocked}
                        value={question.description}
                        onChange={(event) => updateQuestion(questionIndex, { description: stripNonAscii(event.target.value) })}
                      />
                    </label>

                    <div className="choice-list" data-choices>
                      {question.choices.map((choice, choiceIndex) => (
                        <div className="choice-row" key={choiceIndex}>
                          <input
                            type="text"
                            className="choice-input"
                            autoComplete="off"
                            placeholder="Choice label…"
                            disabled={formLocked}
                            value={choice.title}
                            onChange={(event) => updateChoice(questionIndex, choiceIndex, event.target.value)}
                          />
                          <button
                            type="button"
                            className="ghost"
                            data-action="remove-choice"
                            disabled={formLocked || question.choices.length <= 2}
                            onClick={() => removeChoice(questionIndex, choiceIndex)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="row">
                      <button type="button" className="ghost" data-action="add-choice" disabled={formLocked} onClick={() => addChoice(questionIndex)}>
                        Add choice
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <div className="wizard-actions">
            <button
              id="stepBackBtn"
              type="button"
              className="ghost"
              hidden={createStep === 1}
              disabled={formLocked || createStep === 1}
              onClick={handleStepBack}
            >
              <span className="btn-icon iconoir-nav-arrow-left" aria-hidden="true" />
              <span className="btn-text">Back</span>
            </button>

            <button
              id="stepNextBtn"
              type="button"
              className="secondary"
              hidden={createStep === 3}
              disabled={formLocked}
              onClick={handleStepNext}
            >
              <span className="btn-icon iconoir-nav-arrow-right" aria-hidden="true" />
              <span className="btn-text">Continue</span>
            </button>

            <button id="createBtn" type="submit" hidden={createStep !== 3} disabled={formLocked}>
              <span className={`btn-icon ${createSubmitting ? 'iconoir-refresh' : 'iconoir-nav-arrow-right'}`} aria-hidden="true" />
              <span className="btn-text">{createSubmitting ? 'Launching...' : 'Launch Process'}</span>
            </button>
          </div>
        </form>
      </article>

      <article className="card" id="createTimelineCard" hidden={!timelineVisible}>
        <h3>Process Creation Status</h3>
        <ol id="timeline" className="timeline">
          {timelineEntries.map((entry) => {
            const isRunning = entry.status.status === 'running';
            const isError = entry.status.status === 'error';
            const isCompleted = entry.status.status === 'success';
            const isDone = entry.stage.id === 'done';
            return (
              <li
                key={entry.stage.id}
                className={`timeline-item ${isRunning ? 'is-current' : ''} ${isError ? 'is-error' : ''} ${isCompleted ? 'is-completed' : ''} ${
                  isDone && isCompleted ? 'is-done' : ''
                }`}
              >
                <span className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <p className="timeline-label">{entry.stage.label}</p>
                  <p className="timeline-meta">{entry.status.message || 'Running'}</p>
                  {entry.stage.id === 'done' && entry.status.status === 'success' && Boolean(outputs.voteUrl) && (
                    <div id="timelineVoteUrlWrap" className="timeline-vote-url">
                      <div className="output-link-actions">
                        <a id="outVoteUrl" className="timeline-vote-link" href={outputs.voteUrl} target="_blank" rel="noopener noreferrer">
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
        <p id="createStatus" className="status" data-state={createStatus.error ? 'error' : 'ok'} aria-live="polite">
          {createStatus.message || 'Fill in the form and run the pipeline.'}
        </p>
      </article>

      <article className="card" id="createOutputsCard" hidden={!outputsVisible}>
        <h3>Final details</h3>
        <dl className="outputs">
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
      </article>
    </section>
  );
}
