import { useState, useCallback, useRef } from 'react';
import { COPY } from '../copy';
import { fold } from '../services/fold';
import { connectBrowserWallet, disconnectWallet } from '../services/wallet';
import type { WalletConnection } from '../services/wallet';
import {
  ADMIN_JWT,
  FOLD_URL,
  isValidAddress,
  parseAddressList,
  saveElectionMeta,
  saveCensusTree,
  shortHex,
} from '../lib/dfc';
import type { PipelineStage, CreateFormValues, CreateResult } from './create/types';

const PIPELINE_STAGES: PipelineStage[] = [
  'validate_form',
  'connect_wallet',
  'build_census',
  'generate_keypair',
  'create_election',
  'done',
];

const STAGE_LABELS: Record<PipelineStage, string> = {
  idle: 'Not started',
  validate_form: COPY.create.pipeline.validateForm,
  connect_wallet: COPY.create.pipeline.connectWallet,
  build_census: COPY.create.pipeline.buildCensus,
  generate_keypair: COPY.create.pipeline.generateKeypair,
  create_election: COPY.create.pipeline.createElection,
  done: COPY.create.pipeline.done,
  error: COPY.shared.error,
};

function stageIndex(s: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(s);
}

export default function CreateRoute() {
  const [form, setForm] = useState<CreateFormValues>({
    title: '',
    description: '',
    options: ['', ''],
    addresses: '',
    endTime: '',
  });

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<PipelineStage>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [copied, setCopied] = useState(false);

  const walletRef = useRef<WalletConnection | null>(null);

  const setField = useCallback(
    (field: keyof CreateFormValues, value: string) => {
      setForm((f) => ({ ...f, [field]: value }));
    },
    []
  );

  const setOption = useCallback((i: number, value: string) => {
    setForm((f) => {
      const options = [...f.options];
      options[i] = value;
      return { ...f, options };
    });
  }, []);

  const addOption = useCallback(() => {
    setForm((f) => ({ ...f, options: [...f.options, ''] }));
  }, []);

  const removeOption = useCallback((i: number) => {
    setForm((f) => ({
      ...f,
      options: f.options.filter((_, idx) => idx !== i),
    }));
  }, []);

  const copyLink = useCallback(async (electionId: string) => {
    const url = `${window.location.origin}/vote/${electionId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      // 1. validate_form
      setStage('validate_form');
      setStageMsg('');
      const title = form.title.trim();
      if (!title) throw new Error(COPY.create.errors.missingTitle);

      const options = form.options.map((o) => o.trim()).filter(Boolean);
      if (options.length < 2) throw new Error(COPY.create.errors.missingOptions);
      if (new Set(options).size !== options.length) throw new Error(COPY.create.errors.duplicateOptions);

      const rawAddresses = parseAddressList(form.addresses);
      if (rawAddresses.length === 0) throw new Error(COPY.create.errors.missingAddresses);
      for (const addr of rawAddresses) {
        if (!isValidAddress(addr)) throw new Error(COPY.create.errors.invalidAddress(addr));
      }
      const addresses = rawAddresses.map((a) => a.trim().toLowerCase());

      if (!FOLD_URL) throw new Error(COPY.create.errors.missingFoldUrl);
      if (!ADMIN_JWT) throw new Error(COPY.create.errors.missingAdminJwt);

      // 2. connect_wallet
      setStage('connect_wallet');
      setStageMsg(COPY.create.walletConnecting);
      let conn = walletRef.current;
      if (!conn) {
        conn = await connectBrowserWallet();
        walletRef.current = conn;
        setWallet(conn);
      }
      setStageMsg('');

      // 3. build_census
      setStage('build_census');
      setStageMsg('Building Lean-IMT from addresses...');

      // Build census using the davinci-sdk OffchainCensus
      const { OffchainCensus } = await import('@vocdoni/davinci-sdk');
      const census = new OffchainCensus();
      census.add(addresses);
      // Census root will be set after publishing; the root is needed by fold.
      // We defer to a census service if VITE_CENSUS_SERVICE_URL is configured,
      // otherwise we throw a clear error guiding the operator to set it up.
      const censusServiceUrl = import.meta.env.VITE_CENSUS_SERVICE_URL as string | undefined;
      if (!censusServiceUrl) {
        throw new Error(
          'VITE_CENSUS_SERVICE_URL is required to publish the census and obtain its Merkle root. ' +
          'Point this to a running Vocdoni census service (e.g. the sequencer census endpoint).'
        );
      }

      const { VocdoniCensusService, CensusOrchestrator } = await import('@vocdoni/davinci-sdk');
      const censusService = new VocdoniCensusService(censusServiceUrl);
      const censusOrchestrator = new CensusOrchestrator(censusService);
      setStageMsg('Publishing census to census service...');
      await censusOrchestrator.publish(census);
      const censusRoot = census.censusRoot ?? '';
      const censusUri = census.censusURI ?? '';
      if (!censusRoot) throw new Error('Census publishing did not return a root.');
      setStageMsg(`Census published. Root: ${shortHex(censusRoot)}`);

      // Persist census tree so voters can compute proofs later
      saveCensusTree(conn.address + '_census_root', [censusRoot]);
      saveCensusTree(conn.address + '_census_uri', [censusUri]);

      // 4. generate_keypair
      setStage('generate_keypair');
      setStageMsg('Generating ElGamal encryption keypair...');
      // The ballot VK (verification key) and encryption keys are circuit-dependent.
      // The operator must supply these via env or a well-known location.
      // For now we throw a descriptive error if VITE_ELECTION_VK_URL is missing.
      const vkUrl = import.meta.env.VITE_ELECTION_VK_URL as string | undefined;
      if (!vkUrl) {
        throw new Error(
          'VITE_ELECTION_VK_URL is required. Set this to the URL of the ballot verification key JSON ' +
          'matching the fold circuit. Also set VITE_ENC_X and VITE_ENC_Y for the election encryption key.'
        );
      }
      const encX = import.meta.env.VITE_ENC_X as string | undefined;
      const encY = import.meta.env.VITE_ENC_Y as string | undefined;
      if (!encX || !encY) {
        throw new Error(
          'VITE_ENC_X and VITE_ENC_Y are required. Set these to the ElGamal public key coordinates ' +
          'for this election deployment.'
        );
      }
      const ballotMode = import.meta.env.VITE_BALLOT_MODE as string | undefined;
      if (!ballotMode) {
        throw new Error(
          'VITE_BALLOT_MODE is required. Set this to the hex ballot mode for the fold circuit.'
        );
      }

      setStageMsg('Fetching ballot verification key...');
      const vkRes = await fetch(vkUrl);
      if (!vkRes.ok) throw new Error(`Failed to fetch VK from ${vkUrl}: HTTP ${vkRes.status}`);
      const vk = (await vkRes.json()) as Record<string, unknown>;

      // 5. create_election
      setStage('create_election');
      setStageMsg('Creating election on fold backend...');

      // Derive a deterministic processID from wallet address + title + timestamp
      const idBytes = new TextEncoder().encode(`${conn.address}:${title}:${Date.now()}`);
      const hashBuf = await crypto.subtle.digest('SHA-256', idBytes);
      const processID = '0x' + Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

      const endTime = form.endTime ? new Date(form.endTime).toISOString() : undefined;

      const created = await fold.createElection({
        processID,
        ballotMode,
        encX,
        encY,
        censusOrigin: 1, // OffchainStatic
        censusRoot,
        vk,
        endTime,
      });

      const electionId = created.id;

      // Persist metadata for Explore and Vote routes
      saveElectionMeta(electionId, { title, description: form.description.trim(), options });
      saveCensusTree(electionId, addresses);
      // Also save census root + URI keyed by election ID
      saveCensusTree(electionId + '_root', [censusRoot]);
      saveCensusTree(electionId + '_uri', [censusUri]);

      setStage('done');
      setStageMsg('');
      setResult({ electionId, censusRoot, addresses });
    } catch (e) {
      setError(e instanceof Error ? e.message : COPY.create.errors.createFailed);
      setStage('error');
    } finally {
      setRunning(false);
    }
  }, [form]);

  const handleDisconnect = useCallback(async () => {
    await disconnectWallet(walletRef.current?.provider);
    walletRef.current = null;
    setWallet(null);
  }, []);

  const voteUrl = result ? `${window.location.origin}/vote/${result.electionId}` : '';

  return (
    <section className="view" id="createView">
      <article className="card">
        <div className="card-head">
          <h2>{COPY.create.headerTitle}</h2>
          <p className="muted">{COPY.create.headerIntro}</p>
        </div>

        {wallet && (
          <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <div>
              <p className="label">{COPY.navbar.walletTitle}</p>
              <p className="value" style={{ fontFamily: 'monospace', fontSize: 13 }}>{wallet.address}</p>
            </div>
            <button className="ghost" style={{ fontSize: 12, minHeight: 36 }} onClick={() => void handleDisconnect()}>
              {COPY.navbar.disconnect}
            </button>
          </div>
        )}

        {stage === 'idle' || stage === 'error' ? (
          <div className="wizard">
            <div className="step-panel">
              <label>
                {COPY.create.form.titleLabel}
                <input
                  type="text"
                  placeholder={COPY.create.form.titlePlaceholder}
                  value={form.title}
                  onChange={(e) => setField('title', e.target.value)}
                  disabled={running}
                />
              </label>

              <label>
                {COPY.create.form.descriptionLabel}
                <textarea
                  rows={2}
                  placeholder={COPY.create.form.descriptionPlaceholder}
                  value={form.description}
                  onChange={(e) => setField('description', e.target.value)}
                  disabled={running}
                />
              </label>

              <div>
                <p className="label" style={{ marginBottom: 8 }}>{COPY.create.form.optionsTitle}</p>
                {form.options.map((opt, i) => (
                  <div className="choice-row" key={i}>
                    <input
                      type="text"
                      placeholder={COPY.create.form.optionPlaceholder(i)}
                      value={opt}
                      onChange={(e) => setOption(i, e.target.value)}
                      disabled={running}
                    />
                    {form.options.length > 2 && (
                      <button
                        className="ghost"
                        style={{ minHeight: 36, padding: '6px 10px', fontSize: 12 }}
                        onClick={() => removeOption(i)}
                        disabled={running}
                      >
                        {COPY.create.form.removeOption}
                      </button>
                    )}
                  </div>
                ))}
                {form.options.length < 8 && (
                  <button
                    className="ghost"
                    style={{ fontSize: 13, minHeight: 36, marginTop: 6 }}
                    onClick={addOption}
                    disabled={running}
                  >
                    {COPY.create.form.addOption}
                  </button>
                )}
              </div>

              <label>
                {COPY.create.form.addressesLabel}
                <textarea
                  rows={6}
                  placeholder={COPY.create.form.addressesPlaceholder}
                  value={form.addresses}
                  onChange={(e) => setField('addresses', e.target.value)}
                  disabled={running}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
                <span className="field-helper">{COPY.create.form.addressesHelper}</span>
              </label>

              <label>
                {COPY.create.form.endTimeLabel}
                <input
                  type="datetime-local"
                  value={form.endTime}
                  onChange={(e) => setField('endTime', e.target.value)}
                  disabled={running}
                />
                <span className="field-helper">{COPY.create.form.endTimeHelper}</span>
              </label>
            </div>

            {error && <p className="muted danger">{error}</p>}

            <div className="wizard-actions">
              <button onClick={() => void run()} disabled={running}>
                {running ? COPY.create.form.creatingButton : COPY.create.form.createButton}
              </button>
            </div>
          </div>
        ) : stage === 'done' && result ? (
          <div className="wizard">
            <div className="panel">
              <p className="label">{COPY.create.success.shareLinkLabel}</p>
              <div className="output-link-actions" style={{ marginTop: 8 }}>
                <a className="output-scroll" href={voteUrl} target="_blank" rel="noreferrer">
                  {voteUrl}
                </a>
                <button
                  className="secondary"
                  style={{ fontSize: 12, minHeight: 36 }}
                  onClick={() => void copyLink(result.electionId)}
                >
                  {copied ? COPY.shared.copied : COPY.shared.copy}
                </button>
              </div>
            </div>

            <dl className="outputs">
              <div className="output-item">
                <dt>Election ID</dt>
                <dd><code className="output-scroll">{result.electionId}</code></dd>
              </div>
              <div className="output-item">
                <dt>Census root</dt>
                <dd><code className="output-scroll">{shortHex(result.censusRoot)}</code></dd>
              </div>
              <div className="output-item">
                <dt>Eligible addresses</dt>
                <dd>{result.addresses.length}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <PipelineOverlay stage={stage} stageMsg={stageMsg} />
        )}
      </article>
    </section>
  );
}

function PipelineOverlay({ stage, stageMsg }: { stage: PipelineStage; stageMsg: string }) {
  return (
    <div className="wizard">
      <ul className="timeline">
        {PIPELINE_STAGES.filter((s) => s !== 'idle' && s !== 'error').map((s) => {
          const current = s === stage;
          const done = stageIndex(stage) > stageIndex(s);
          const cls = done ? 'is-done' : current ? 'is-current' : '';
          return (
            <li key={s} className={`timeline-item ${cls}`}>
              <span className="timeline-marker">
                {current && <span className="timeline-spinner" />}
              </span>
              <span className="timeline-content">
                <strong className="timeline-label">{STAGE_LABELS[s]}</strong>
                {current && stageMsg && <p className="timeline-meta">{stageMsg}</p>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
