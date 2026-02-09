# Open Citizen Census Webapp

Unified frontend for creating and voting in census-gated voting processes using Vocdoni + Self.

## Goal
This app provides two production flows in a single webapp:

1. **Create voting processes** backed by an onchain census contract with country + minimum-age constraints.
2. **Vote without browser-wallet interaction** using a managed identity wallet and Self registration.

The objective is to minimize user friction while preserving clear status visibility during creation, registration, and vote lifecycle.

## Scope
### In scope
- End-to-end process creation at `/`.
- Wallet connection for creation (injected wallet first, WalletConnect fallback).
- Full creation pipeline with stage-by-stage status.
- Voting flow at `/vote/:context` using a base64url context payload.
- Managed identity wallet generation/import for voting.
- Self QR registration and readiness tracking (onchain + sequencer inclusion).
- Vote submission and vote-status timeline.

### Out of scope
- Smart-contract development changes.
- Backend services added by this app.
- Generic process browsing/search features.

## Route behavior
- `/` -> create view.
- `/vote/:context` -> vote view with required context.
- `/vote` or invalid `/vote/:context` -> **blocking popup**; app is intentionally unusable until a valid context link is used.

## Functional requirements implemented
### Process creation
- Three guided form steps:
  1. Census parameters
  2. Process information
  3. Questions
- Form locked until creator wallet is connected.
- Input sanitization for ASCII-sensitive fields.
- Internal JSON-RPC retry handling for transient wallet/provider failures.
- Process creation status timeline with final vote URL and copy action.

### Vote flow
- Context-first navigation (`/vote/:context`) for deterministic process resolution.
- Process details popup with process metadata and URLs.
- Self-based process registration card with automatic QR generation when context is ready.
- Registration progress timeline:
  - Onchain census inclusion
  - Sequencer census inclusion
  - Ready to vote
- If already registered in sequencer census, registration area is locked/blurred with explicit success messaging.
- Question options remain disabled until readiness is satisfied.
- Vote status flow shown when a vote ID exists (with local persistence).

## Creation pipeline stages
1. `validate_form`
2. `connect_creator_wallet_walletconnect`
3. `ensure_self_config_registered`
4. `deploy_census_contract`
5. `start_indexer`
6. `wait_indexer_ready`
7. `create_davinci_process`
8. `wait_process_ready_in_sequencer`
9. `done`

## Technical requirements
- Node.js 18+ recommended.
- npm 9+ recommended.
- Browser with modern wallet support (MetaMask/injected) or WalletConnect-compatible wallet.
- Reachable external services:
  - Onchain census indexer
  - Davinci sequencer
  - Davinci census endpoint (or fallback to indexer URL)

## Configuration
Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|---|---|---|
| `VITE_NETWORK` | Yes | Network key. Supported in code: `celo`, `staging_celo`. |
| `VITE_ONCHAIN_CENSUS_INDEXER_URL` | Yes | Base URL for census indexer. |
| `VITE_DAVINCI_SEQUENCER_URL` | Yes | Sequencer API URL. |
| `VITE_DAVINCI_CENSUS_URL` | No | Census API URL used for proof generation. Falls back to indexer URL when empty. |
| `VITE_SELF_APP_NAME` | No | Display name used in Self payloads. |
| `VITE_WALLETCONNECT_PROJECT_ID` | Conditional | Required only when no injected wallet is available in creator flow. |

## Development
```bash
cd /Users/lucasmenendez/Workspace/vocdoni/davinci-miniapps/self-open-citizen-census/webapps/open-citizen-census
npm install
npm run dev
```

## Build and preview
```bash
npm run build
npm run preview
```

## Local persistence
The app stores minimal local state for continuity:
- `occ.masterSecret.v1` -> device master secret for managed identity wallet derivation.
- `occ.walletOverride.<processId>` -> optional imported private key override.
- `occ.voteSubmission.v1.<processId>.<address>` -> vote ID/status tracking.
- `occ.lastScopeSeed.v1` and per-process scope values.

## Security and UX notes
- Private key reveal/import actions include explicit warnings.
- Voting flow avoids browser-wallet interaction for end users; signing uses the managed identity wallet.
- Vote controls are gated by readiness checks to avoid invalid submissions.
- Raw technical errors are logged to console; user-facing messages are simplified.

## Related files
- Main app logic: `src/main.js`
- Styling: `src/style.css`
- Self payload adapter: `src/selfApp.js`
- Runtime HTML: `index.html`
- Historical planning document: `PLAN.md`
