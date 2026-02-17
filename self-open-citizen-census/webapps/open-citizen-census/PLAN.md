# Open Citizen Census - Planning Document

## Scope
This document defines the plan for a new webapp at:

- `/Users/lucasmenendez/Workspace/vocdoni/davinci-self/self-open-citizen-census/webapps/open-citizen-census`

Current status:

- Planning only.
- No implementation started.

## Product Goal
Build a webapp with two views:

1. Process creation:
- Collect process data + census constraints (country and minimum age).
- Execute the full pipeline in one action, in background, with transparent progress:
  - Register/check Self config.
  - Deploy onchain census contract.
  - Start indexer.
  - Wait until census is query-ready.
  - Create Davinci process using that census.
  - Wait until sequencer indexes and process is ready.

2. Voting page:
- Walletless UX for end users with Self QR registration.
- Use a deterministic device-managed wallet (option #1 selected).
- Wait for:
  - Onchain census inclusion (`weightOf(address) > 0`).
  - Davinci sequencer inclusion (`getAddressWeight(processId, address) > 0`).
- Allow vote only after both checks pass.

## Technical Requirements
- `@vocdoni/davinci-sdk` must be used on its latest stable release at implementation time.
- View 1 (process creation) must use WalletConnect instead of direct MetaMask flow.
- WalletConnect must be configured using `WALLETCONNECT_PROJECT_ID`.
- Because this is a Vite frontend, `WALLETCONNECT_PROJECT_ID` should be exposed to the client as `VITE_WALLETCONNECT_PROJECT_ID` (source can still be managed from the same secret value).

## Selected Wallet Strategy
Chosen strategy: `#1` (device-deterministic wallet).

Behavior:

- Generate and persist one local device master secret.
- Derive deterministic wallet per census/process context.
- No MetaMask required in voting flow.
- Self uniqueness/nullifier rules prevent duplicate registrations in the same census, even with different wallets.

## View 1: Create Process (Single Action Pipeline)
### UX Requirements
- Single button submission ("Create process").
- No manual step switching by user.
- Real-time timeline/log with stage-by-stage status.
- Each stage must show: pending/running/success/error + message.
- Final panel shows all outputs and links.
- Creator wallet connection should happen through WalletConnect to reduce network-switch issues.

### Pipeline Stages
1. `validate_form`
2. `connect_creator_wallet_walletconnect`
3. `ensure_self_config_registered`
4. `deploy_census_contract`
5. `start_indexer`
6. `wait_indexer_ready`
7. `create_davinci_process`
8. `wait_process_ready_in_sequencer`
9. `done`

### Inputs (Create View)
- Country (ISO code).
- Minimum age.
- Scope seed.
- Process title.
- Process description.
- Maximum voters.
- Start datetime.
- Duration.
- Questions and choices.

### Outputs (Create View)
- Deployed census contract address.
- Deployment tx hash.
- Census URI used by Davinci.
- Created process ID.
- Process creation tx hash.
- Final voting URL (`/vote/:processId`).

## View 2: Vote (Walletless)
### UX Requirements
- No wallet extension needed.
- Automatically create/load deterministic wallet.
- Show wallet address and readiness progress.
- Integrate Self QR registration.
- Block vote submission until both readiness checks pass.

### Registration and Readiness Flow
1. Resolve process from URL.
2. Resolve census contract address and sequencer config.
3. Load or derive deterministic wallet.
4. Build Self app payload with derived wallet address as `userId`.
5. Show QR and websocket status.
6. Poll onchain inclusion (`weightOf`).
7. Poll sequencer inclusion (`getAddressWeight`).
8. Enable vote form when both are positive.
9. Submit vote with Davinci SDK and track vote status.

## Private Key Feature (Requested)
### Required Features
- Show generated wallet address.
- "Reveal private key" action (hidden by default).
- "Copy private key" action.
- "Import private key" action.

### Import Use Case
- User imports same key on another device.
- App uses imported key for signing/voting.
- Enables vote overwrite behavior from another device using same identity wallet.

### Safety UX
- Warning before revealing key.
- Warning before importing/replacing current managed wallet.
- Re-run readiness checks after import.

## Data and State Model
### Pipeline Event
- `stage`
- `status` (`pending|running|success|error`)
- `message`
- `startedAt`
- `endedAt`
- `meta`

### Voting Readiness
- `onchainWeight`
- `sequencerWeight`
- `onchainReady`
- `sequencerReady`

### Managed Wallet
- `address`
- `privateKey`
- `source` (`derived|imported`)
- `derivationVersion`

## Local Persistence Plan
- `occ.masterSecret.v1` -> device master secret.
- `occ.walletOverride.<processId>` -> optional imported key override.
- Optional session/local state for stage logs and last process result.

## Reuse Plan from Existing Apps
Use existing logic as base (adapt, not duplicate blindly):

- Deployer logic:
  - Config registration.
  - Contract deployment.
  - Indexer start.
- App logic:
  - Self QR + websocket flow.
  - Process creation with Davinci SDK `OnchainCensus`.
  - Sequencer readiness polling.

Source paths:

- `/Users/lucasmenendez/Workspace/vocdoni/davinci-self/self-open-citizen-census/webapps/open-citizen-census-deployer/src/main.js`
- `/Users/lucasmenendez/Workspace/vocdoni/davinci-self/self-open-citizen-census/webapps/open-citizen-census-app/src/main.js`
- `/Users/lucasmenendez/Workspace/vocdoni/davinci-self/self-open-citizen-census/webapps/open-citizen-census-app/src/selfApp.js`

## Environment Variables (Planned)
- `VITE_NETWORK`
- `VITE_SELF_WEBSOCKET`
- `VITE_ONCHAIN_CENSUS_INDEXER_URL`
- `VITE_DAVINCI_SEQUENCER_URL`
- `VITE_DAVINCI_CENSUS_URL`
- `VITE_DAVINCI_APP_URL`
- `WALLETCONNECT_PROJECT_ID` (deployment/runtime secret source)
- `VITE_WALLETCONNECT_PROJECT_ID` (frontend-exposed variable consumed by the app)
- Optional: `VITE_RPC_URL`

## Planned Delivery Phases
1. App scaffold and routing (`/create`, `/vote/:processId`).
2. Create-view orchestrator pipeline with transparent timeline.
3. Deterministic wallet manager + key reveal/import UX.
4. Vote-view registration + dual inclusion checks + submit vote.
5. Error handling, retries, timeout UX, and final polish.

## Acceptance Criteria
1. Create view runs full flow in one submission and shows each background stage.
2. Process creation produces a working process ID and vote URL.
3. Vote view works without MetaMask.
4. Deterministic wallet is generated and persisted locally.
5. User can reveal/copy/import private key.
6. Voting unlocks only after onchain and sequencer inclusion checks pass.
7. Imported key can be used to vote/overwrite from another device.

## Explicit Non-Goals For Now
- No implementation in this phase.
- No contract changes in this phase.
- No backend service added in this phase.
