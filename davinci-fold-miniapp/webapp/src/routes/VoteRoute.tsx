import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { fold } from '../services/fold';
import { connectBrowserWallet, disconnectWallet } from '../services/wallet';
import type { WalletConnection } from '../services/wallet';
import type { ElectionResponse, VoteResponse } from '../lib/types';
import {
  COPY,
} from '../copy';
import {
  isElectionAcceptingVotes,
  electionHasResults,
  loadElectionMeta,
  loadCensusTree,
  formatEndTime,
  timeUntil,
  shortHex,
  isValidAddress,
  VOTE_POLL_INTERVAL_MS,
} from '../lib/dfc';
import type { VotePipelineStage } from './vote/types';
import { VOTE_STATUS_STEPS } from './vote/types';
import StatusBadge from '../components/StatusBadge';

export default function VoteRoute() {
  const { electionId } = useParams<{ electionId: string }>();

  const [election, setElection] = useState<ElectionResponse | null>(null);
  const [loadingElection, setLoadingElection] = useState(false);
  const [electionError, setElectionError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const walletRef = useRef<WalletConnection | null>(null);

  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [stage, setStage] = useState<VotePipelineStage>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [voteError, setVoteError] = useState<string | null>(null);
  const [voteId, setVoteId] = useState<string | null>(null);
  const [voteStatus, setVoteStatus] = useState<VoteResponse | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const meta = election ? loadElectionMeta(election.id) : null;
  const censusAddresses = election ? loadCensusTree(election.id) : null;

  // Load election
  useEffect(() => {
    if (!electionId) return;
    setLoadingElection(true);
    setElectionError(null);
    fold
      .election(electionId)
      .then((e) => setElection(e))
      .catch((err) => setElectionError(err instanceof Error ? err.message : COPY.vote.notFound))
      .finally(() => setLoadingElection(false));
  }, [electionId]);

  // Poll vote status after submission
  useEffect(() => {
    if (!election || !voteId) return;
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    const checkStatus = () => {
      fold
        .vote(election.id, voteId)
        .then((v) => {
          setVoteStatus(v);
          if (v.status === 'settled' || v.status === 'error') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setStage(v.status === 'settled' ? 'done' : 'error');
          }
        })
        .catch(() => undefined);
    };

    checkStatus();
    pollTimerRef.current = setInterval(checkStatus, VOTE_POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [election, voteId]);

  const connectWallet = useCallback(async () => {
    setStageMsg(COPY.vote.connectingWallet);
    try {
      const conn = await connectBrowserWallet(walletRef.current?.provider);
      walletRef.current = conn;
      setWallet(conn);
    } catch (e) {
      setVoteError(e instanceof Error ? e.message : 'Failed to connect wallet.');
    } finally {
      setStageMsg('');
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await disconnectWallet(walletRef.current?.provider);
    walletRef.current = null;
    setWallet(null);
  }, []);

  const isEligible = useCallback(
    (address: string): boolean => {
      if (!censusAddresses) return false;
      return censusAddresses.some((a) => a.toLowerCase() === address.toLowerCase());
    },
    [censusAddresses]
  );

  const submitVote = useCallback(async () => {
    if (!election || !wallet || selectedOption === null) return;

    setStage('encrypt_ballot');
    setVoteError(null);

    try {
      // Verify eligibility
      if (censusAddresses && !isEligible(wallet.address)) {
        throw new Error(COPY.vote.notEligible);
      }

      const censusRoot = loadCensusTree(election.id + '_root')?.[0] ?? '';
      const censusUri = loadCensusTree(election.id + '_uri')?.[0] ?? '';

      // Census index: position of the voter in the sorted address list
      const normalizedAddresses = (censusAddresses ?? []).map((a) => a.toLowerCase());
      const censusIdx = normalizedAddresses.indexOf(wallet.address.toLowerCase());
      if (censusIdx < 0) {
        throw new Error(COPY.vote.notEligible);
      }

      const circuitUrl = import.meta.env.VITE_CIRCUIT_URL as string | undefined;
      if (!circuitUrl || !censusUri) {
        throw new Error(
          'VITE_CIRCUIT_URL is required to generate the ballot ZK proof. ' +
          'Set this to the base URL where the fold circuit wasm and zkey files are hosted.'
        );
      }

      // Generate ballot proof via SDK
      setStage('generate_ballot_proof');
      setStageMsg('Downloading circuit files and generating ballot proof...');

      const { BallotInputGenerator, VocdoniCensusService } = await import('@vocdoni/davinci-sdk');

      // Fetch census proof for the voter from the census service
      const censusServiceUrl = import.meta.env.VITE_CENSUS_SERVICE_URL as string | undefined;
      if (!censusServiceUrl) {
        throw new Error(
          'VITE_CENSUS_SERVICE_URL is required to fetch census proof for the voter.'
        );
      }
      const censusService = new VocdoniCensusService(censusServiceUrl);
      const censusProofData = await censusService.getCensusProof(censusRoot, wallet.address);

      const encX = import.meta.env.VITE_ENC_X as string | undefined;
      const encY = import.meta.env.VITE_ENC_Y as string | undefined;
      if (!encX || !encY) throw new Error('VITE_ENC_X and VITE_ENC_Y are required.');

      // BallotMode must match the circuit used by fold.
      // These defaults assume a single-choice election; update if VITE_BALLOT_MODE encodes other modes.
      const ballotMode = {
        numFields: 8,
        maxValue: '1',
        minValue: '0',
        uniqueValues: false,
        costExponent: 1,
        maxValueSum: '1',
        minValueSum: '0',
      };

      const choices = new Array(ballotMode.numFields).fill(0);
      choices[selectedOption] = 1;

      const gen = new BallotInputGenerator();
      await gen.init();
      const ballotInputs = await gen.generateInputs(
        election.id,
        wallet.address.slice(2),
        { x: encX, y: encY },
        ballotMode,
        choices,
        '1'
      );

      // Generate Groth16 proof via snarkjs
      setStageMsg('Generating ZK proof...');
      const snarkjs = await import('snarkjs');
      const { proof: snarkProof, publicSignals } = await snarkjs.groth16.fullProve(
        ballotInputs.circomInputs as unknown as Record<string, unknown>,
        `${circuitUrl}/ballot.wasm`,
        `${circuitUrl}/ballot.zkey`
      );

      const ballot = JSON.stringify(ballotInputs.ballot);

      // Sign ballot
      setStage('sign_ballot');
      setStageMsg('Sign the ballot in your wallet...');
      const sig = await wallet.signer.signMessage(ballot);

      // Derive ECDSASignature fields from sig
      const r = sig.slice(0, 66);
      const s = '0x' + sig.slice(66, 130);
      const v = parseInt(sig.slice(130, 132), 16);

      const addrBigInt = BigInt(wallet.address);
      const addressLo16 = Number(addrBigInt & 0xffffn);
      const sdkVoteId = ballotInputs.voteId;
      const voteIdKey = '0x' + (BigInt(sdkVoteId) | (1n << 63n)).toString(16);

      // census siblings: MerkleCensusProof.siblings is a single hex string
      const merkleSiblings = 'siblings' in censusProofData ? [censusProofData.siblings] : [];

      // Submit vote
      setStage('submit_vote');
      setStageMsg('Submitting vote to fold backend...');

      const response = await fold.submitVote(election.id, {
        vote_id: sdkVoteId,
        address: wallet.address,
        census_idx: censusIdx,
        address_lo16: addressLo16,
        vote_id_key: voteIdKey,
        ballot,
        proof: snarkProof as unknown as import('../lib/types').Groth16Proof,
        public_inputs: publicSignals,
        sig: { r, s, v },
        census: {
          root: censusRoot,
          siblings: merkleSiblings,
          index: censusIdx,
        },
      });

      setVoteId(response.voteID);
      setStage('track_vote');
      setStageMsg('Tracking vote status...');
    } catch (e) {
      setVoteError(e instanceof Error ? e.message : COPY.vote.voteError);
      setStage('error');
    }
  }, [election, wallet, selectedOption, censusAddresses, isEligible]);

  if (!electionId) {
    return (
      <section className="view" id="voteView">
        <article className="card">
          <p className="muted">{COPY.vote.missingId}</p>
        </article>
      </section>
    );
  }

  if (loadingElection) {
    return (
      <section className="view" id="voteView">
        <article className="card">
          <p className="muted">{COPY.vote.headerLoadingTitle}</p>
        </article>
      </section>
    );
  }

  if (electionError || !election) {
    return (
      <section className="view" id="voteView">
        <article className="card">
          <p className="muted danger">{electionError ?? COPY.vote.notFound}</p>
        </article>
      </section>
    );
  }

  const accepting = isElectionAcceptingVotes(election.status);
  const hasResults = electionHasResults(election.status);
  const closedMsg = !accepting && !hasResults
    ? (COPY.vote.closedStatuses as Record<string, string>)[election.status]
    : null;

  const title = meta?.title ?? shortHex('0x' + election.id);
  const options = meta?.options ?? [];

  return (
    <section className="view" id="voteView">
      {/* Election header */}
      <article className="card vote-focus-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontFamily: 'Inter', fontWeight: 700, fontSize: 'clamp(24px,4vw,38px)', color: 'var(--accent)', lineHeight: 1.05, flex: 1, minWidth: 0 }}>
            {title}
          </h1>
          <StatusBadge status={election.status} />
        </div>
        {meta?.description && <p className="muted" style={{ marginTop: 10 }}>{meta.description}</p>}
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13, color: 'var(--muted)' }}>
          {election.endTime && (
            <span>
              {accepting ? `Closes in ${timeUntil(election.endTime)}` : formatEndTime(election.endTime)}
            </span>
          )}
          <span style={{ fontFamily: 'monospace' }}>{shortHex('0x' + election.id)}</span>
        </div>
      </article>

      {/* Closed notice */}
      {closedMsg && (
        <article className="card">
          <p className="muted">{closedMsg}</p>
        </article>
      )}

      {/* Results */}
      {hasResults && <ResultsCard electionId={election.id} options={options} />}

      {/* Vote form */}
      {accepting && (
        <article className="card">
          {/* Wallet */}
          {!wallet ? (
            <div style={{ marginBottom: 16 }}>
              <p className="muted" style={{ marginBottom: 12 }}>{COPY.vote.connectPrompt}</p>
              <button onClick={() => void connectWallet()} disabled={!!stageMsg}>
                {stageMsg || 'Connect wallet'}
              </button>
              {voteError && <p className="muted danger" style={{ marginTop: 8 }}>{voteError}</p>}
            </div>
          ) : (
            <>
              <div className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <div>
                  <p className="label">{COPY.navbar.walletTitle}</p>
                  <p className="value" style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {isValidAddress(wallet.address) ? wallet.address : wallet.address}
                  </p>
                  {censusAddresses && (
                    <p className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                      {isEligible(wallet.address) ? '✓ Address is eligible to vote' : '✗ Address is not in the census'}
                    </p>
                  )}
                </div>
                <button className="ghost" style={{ fontSize: 12, minHeight: 36 }} onClick={() => void handleDisconnect()}>
                  {COPY.navbar.disconnect}
                </button>
              </div>

              {/* Ballot */}
              {stage === 'idle' || stage === 'error' ? (
                <>
                  {options.length > 0 ? (
                    <fieldset className="vote-question-card" style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend>{title}</legend>
                      <div className="vote-choices" style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                        {options.map((opt, i) => (
                          <label
                            key={i}
                            className={`vote-choice${selectedOption === i ? ' is-selected' : ''}${!accepting ? ' is-disabled' : ''}`}
                            style={{ cursor: accepting ? 'pointer' : 'not-allowed' }}
                          >
                            <input
                              type="radio"
                              name="vote-option"
                              checked={selectedOption === i}
                              onChange={() => setSelectedOption(i)}
                              disabled={!accepting}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : (
                    <p className="muted">No vote options found locally. Open the vote URL shared by the election creator.</p>
                  )}

                  <div className="vote-submit-guide">
                    {voteError && <p className="muted danger">{voteError}</p>}
                    <button
                      onClick={() => void submitVote()}
                      disabled={selectedOption === null || !accepting || !isEligible(wallet.address)}
                    >
                      {COPY.vote.submitButton}
                    </button>
                  </div>
                </>
              ) : (
                <VotePipelineView stage={stage} stageMsg={stageMsg} voteStatus={voteStatus} voteId={voteId} />
              )}
            </>
          )}
        </article>
      )}
    </section>
  );
}

function VotePipelineView({
  stage,
  stageMsg,
  voteStatus,
  voteId,
}: {
  stage: VotePipelineStage;
  stageMsg: string;
  voteStatus: VoteResponse | null;
  voteId: string | null;
}) {
  if (stage === 'done') {
    return (
      <div className="vote-submit-guide">
        <p style={{ margin: 0, fontWeight: 600, color: 'var(--ok)' }}>✓ {COPY.vote.voteSubmitted}</p>
        {voteId && <p className="muted" style={{ marginTop: 6 }}>Vote ID: <code style={{ fontFamily: 'monospace' }}>{shortHex(voteId)}</code></p>}
      </div>
    );
  }

  const activeStageOrder: VotePipelineStage[] = [
    'encrypt_ballot',
    'generate_ballot_proof',
    'sign_ballot',
    'submit_vote',
    'track_vote',
  ];

  return (
    <div className="vote-submit-guide">
      {stageMsg && <p className="muted">{stageMsg}</p>}

      {/* Vote status timeline */}
      {voteId && (
        <ul className="vote-status-timeline">
          {VOTE_STATUS_STEPS.map((step) => {
            const current = voteStatus?.status === step.status;
            const done = voteStatus
              ? ['pending', 'batched', 'folded', 'settled'].indexOf(voteStatus.status) >
                ['pending', 'batched', 'folded', 'settled'].indexOf(step.status)
              : false;
            const cls = done ? 'is-complete' : current ? 'is-current' : '';
            return (
              <li key={step.status} className={`vote-status-item ${cls}`}>
                <span className="vote-status-marker">
                  {current && <span className="timeline-spinner" />}
                  {done && '✓'}
                </span>
                <span className="vote-status-content">
                  <strong className="vote-status-label">{step.label}</strong>
                  <p className="vote-status-description">{step.description}</p>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!voteId && activeStageOrder.includes(stage) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="timeline-spinner" />
          <span className="muted">{stageMsg || stage.replace(/_/g, ' ')}</span>
        </div>
      )}
    </div>
  );
}

function ResultsCard({ electionId, options }: { electionId: string; options: string[] }) {
  const [results, setResults] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fold
      .results(electionId)
      .then((r) => setResults(r.tally))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load results.'))
      .finally(() => setLoading(false));
  }, [electionId]);

  const total = results ? results.reduce((s, n) => s + n, 0) : 0;

  return (
    <article className="card">
      <div className="card-head">
        <h2>{COPY.vote.results.title}</h2>
      </div>
      {loading && <p className="muted">{COPY.shared.loading}</p>}
      {error && <p className="muted danger">{error}</p>}
      {results && (
        <>
          <p className="muted">{COPY.vote.results.totalVotes}: <strong>{total}</strong></p>
          <div style={{ marginTop: 14, display: 'grid', gap: 14 }}>
            {results.map((count, i) => {
              const label = options[i] ?? `Option ${i + 1}`;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={i} style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <strong style={{ fontSize: 15, color: 'var(--ink)' }}>{label}</strong>
                    <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>{count}</span>
                  </div>
                  <div className="vote-results-bar">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <p className="muted" style={{ fontSize: 12 }}>{pct}% of total votes</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </article>
  );
}
