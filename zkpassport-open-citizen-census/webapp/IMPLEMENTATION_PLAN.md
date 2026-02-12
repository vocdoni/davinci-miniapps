# Webapp Implementation Plan

## Summary

Build a Sepolia-only webapp, following the structure and UX flow of `/Users/lucasmenendez/Workspace/vocdoni/davinci-miniapps/self-open-citizen-census/webapps/open-citizen-census`, to support:

1. Census contract deployment with zkPassport restrictions.
2. Davinci process creation referencing the deployed census.
3. Voter registration through sponsored backend (`POST /v1/register`).
4. Voting with Davinci SDK.
5. Results visualization.

## Scope

In scope:

1. Create flow (deploy census + create process).
2. Vote flow (register + readiness checks + vote submission + results).
3. zkPassport frontend integration.
4. Onchain census indexer integration for ICensusValidator contract tracking.
5. Sepolia network support only.

Out of scope:

1. Smart contract code implementation.
2. Backend implementation details beyond integration contract.
3. Multi-network UI in MVP.

## Public Interfaces and Types

### Environment variables

1. `VITE_NETWORK=sepolia`
2. `VITE_ONCHAIN_CENSUS_INDEXER_URL`
3. `VITE_DAVINCI_SEQUENCER_URL`
4. `VITE_DAVINCI_CENSUS_URL` (optional; fallback to indexer URL)
5. `VITE_BACKEND_URL`
6. `VITE_ZKPASSPORT_DOMAIN` (single source for both proof request domain/app identity and on-chain `scopeDomain` in `verifyScopes`)
7. `VITE_ZKPASSPORT_APP_NAME`
8. `VITE_ZKPASSPORT_VERIFIER_ADDRESS` (for frontend proof precheck if needed)

### Process metadata schema

1. `meta.network: "sepolia"`
2. `meta.zkPassportConfig.scopeDomain` (set from `VITE_ZKPASSPORT_DOMAIN`)
3. `meta.zkPassportConfig.scope`
4. `meta.zkPassportConfig.minAge`
5. `meta.zkPassportConfig.targetNationality`
6. `meta.zkPassportConfig.nationalityAliases`
7. `meta.zkPassportConfig.censusAddress`
8. `meta.zkPassportConfig.censusURI`
9. `meta.zkPassportConfig.backendRegisterUrl`

### Backend API contract used by webapp

1. `POST /v1/register`
2. Request fields: `voterAddress`, `proofVerificationParams`, `isIDCard`, `signature`, `signedPayload`
3. Success fields: `txHash`, `chainId`, `censusAddress`
4. Reject flow on `INVALID_PROOF`, `INVALID_SIGNATURE`, `EXPIRED_SIGNATURE`, `ALREADY_REGISTERED_UNIQUE_IDENTIFIER`, `TX_SUBMISSION_FAILED`, `INVALID_REQUEST`

## Functional Plan

### Create flow

1. Connect creator wallet.
2. Fill census restrictions form: minimum age, nationality target, aliases, scope seed.
3. Build deterministic scope from app rules (auto-generated, no manual raw scope editing).
4. Deploy zkPassport census contract on Sepolia with constructor restrictions.
5. Register the deployed validator in onchain-census-indexer and obtain `censusURI`.
6. Create Davinci process with census reference and metadata including `meta.zkPassportConfig`.
7. Wait for sequencer process availability and show vote URL.

### Voter registration flow

1. Resolve process by `processId` route.
2. Load metadata and enforce `meta.network === "sepolia"`.
3. Generate/recover voter deterministic wallet locally from `uniqueIdentifier + password`.
4. Generate zk proof with zkPassport SDK using process restrictions.
5. Sign canonical payload (including `proofHash`, `chainId`, `censusAddress`, timestamps) with voter wallet.
6. Call backend `POST /v1/register`.
7. Receive `txHash` and show tx-tracking UI.
8. Confirm readiness by:
   - tx mined success
   - census indexer reflects registration in census URI
   - sequencer census inclusion is ready for voting

### Vote flow

1. Keep vote controls disabled until readiness checks pass.
2. Submit vote with Davinci SDK using voter deterministic wallet.
3. Persist vote submission ID/status locally per `processId + voterAddress`.
4. Show submission lifecycle and final acceptance status.

### Results flow

1. Query process results from sequencer/Davinci SDK.
2. Render question-level aggregates.
3. Auto-refresh with manual refresh action.

## Application Structure (planned)

1. `webapp/src/main.js` route + orchestration.
2. `webapp/src/createFlow.js` creation pipeline.
3. `webapp/src/registerFlow.js` zkPassport + backend sponsor flow.
4. `webapp/src/voteFlow.js` voting + status tracking.
5. `webapp/src/resultsFlow.js` results queries/rendering.
6. `webapp/src/services/zkpassport.js` proof request and parameter transformation.
7. `webapp/src/services/backend.js` API client for `/v1/register`.
8. `webapp/src/services/indexer.js` censusURI and inclusion checks.
9. `webapp/src/services/davinci.js` process creation/vote/results wrappers.
10. `webapp/src/services/wallet.js` deterministic wallet derivation and secure local persistence.
11. `webapp/src/style.css` adapted from existing app style with zkPassport-specific states.

## Security and Data Handling

1. Private key derivation and password handling stay fully client-side.
2. Store encrypted wallet material only; no plaintext password storage.
3. Store password verifier hash for re-unlock UX.
4. Never log full proofs or secrets.
5. Reject flow immediately on proof/signature/backend failure.
6. Force chain checks (Sepolia, chainId `11155111`) before actions.

## Test Cases and Scenarios

1. Creator deploys census with restrictions and creates process successfully.
2. Process metadata contains complete `meta.zkPassportConfig` and `meta.network`.
3. Valid voter proof + signature returns txHash and eventually enables voting.
4. Invalid proof blocks registration and keeps vote disabled.
5. Invalid signature blocks registration and keeps vote disabled.
6. UID already registered returns backend error and keeps vote disabled.
7. Tx hash returned but tx fails on-chain shows failed state and retry guidance.
8. Registered user refreshes page and readiness state is restored from chain/indexer.
9. Vote submission succeeds and status persists across refresh.
10. Results view loads and updates after votes are counted.

## Acceptance Criteria

1. Webapp reproduces the same end-to-end UX quality as the reference app while using zkPassport flow.
2. Network is strictly Sepolia in create and vote flows.
3. Registration relies on sponsored backend and contract/indexer readiness checks.
4. Voting is impossible before registration readiness.
5. Results are visible from the same app without external tools.

## Assumptions and Defaults

1. Default document type exposed in UI: Passport; ID Card optional toggle.
2. `scope` is auto-generated by app rules; not manually edited.
3. Backend URL is single environment value per deployment.
4. Onchain-census-indexer supports the new validator because it follows `ICensusValidator`.
5. Frontend tracks tx by hash and does not require backend job pattern.
6. `VITE_ZKPASSPORT_DOMAIN` is reused as the single domain configuration for both SDK request domain and contract `scopeDomain`.
