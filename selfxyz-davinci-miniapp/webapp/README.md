# Ask The World - DAVINCI Webapp

Unified frontend for creating and voting in census-gated voting processes using Vocdoni + Self.

## Goal
This app provides two production flows in a single webapp:

1. **Create voting processes** backed by an onchain census contract with country list (1-5) + minimum-age constraints.
2. **Vote without browser-wallet interaction** using a managed identity wallet and Self registration.

The objective is to minimize user friction while preserving clear status visibility during creation, registration, and vote lifecycle.

## Scope
### In scope
- End-to-end process creation at `/`.
- Explore page at `/explore` listing compatible processes created with this app metadata conventions.
- Wallet connection for creation (injected wallet first, WalletConnect fallback).
- Full creation pipeline with stage-by-stage status.
- Voting flow at `/vote/:processId`.
- Managed identity wallet generation/import for voting.
- Self QR registration and readiness tracking (onchain + sequencer inclusion).
- Vote submission and vote-status timeline.

### Out of scope
- Smart-contract development changes.
- Backend services added by this app.
- Backend indexing/search endpoints beyond sequencer `listProcesses()`.

## Route behavior
- `/` -> create view.
- `/explore` -> explore compatible processes created with this app metadata shape.
- `/vote/:processId` -> vote view with required process ID.
- `/vote` or invalid `/vote/:processId` -> **blocking popup**; app is intentionally unusable until a valid process link is used.

## Functional requirements implemented
### Process creation
- Single-question creator UI:
  1. Question title
  2. Option list (minimum two, maximum eight)
  3. Eligibility cards (countries, minimum age, duration)
  4. Advanced max-voters control
- `scopeSeed` and `startDate` are derived at submit time.
- Input sanitization for ASCII-sensitive fields.
- Internal JSON-RPC retry handling for transient wallet/provider failures.
- Overlay-based process creation status timeline with final vote URL and copy action.
- External payload compatibility preserved:
  - Indexer payload keeps `chainId`, `address`, `startBlock`, `expiresAt`.
  - `expiresAt` remains RFC3339 (`startDate + duration`).

### Vote flow
- Process-first navigation (`/vote/:processId`) for deterministic process resolution.
- Additional voting context (`scope`, `minAge`, `countries`/`country`, `network`) is resolved from sequencer metadata (`metadata.meta.selfConfig` + `metadata.meta.network`).
- Process details popup with process metadata and URLs.
- Self-based process registration card with automatic QR generation when context is ready.
- Registration progress timeline:
  - Onchain census inclusion
  - Sequencer census inclusion
  - Ready to vote
- If already registered in sequencer census, registration area is locked/blurred with explicit success messaging.
- Question options remain disabled until readiness is satisfied.
- Vote status flow shown when a vote ID exists (with local persistence).

### Explore flow
- Compact list rows ordered newest-first.
- Filters processes by `metadata.meta.selfConfig` core fields:
  - `scope`/`scopeSeed`
  - `minAge`
  - `countries` (or legacy `country` fallback)
- Each row links directly to `/vote/:processId`.
- Row content includes status, countries, minimum age, and remaining time while status is READY.
- Pagination uses "Load more" and handles sparse matches.
- Auto-refresh updates loaded rows every 30 seconds.

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
| `VITE_PINATA_JWT` | Yes | Client-visible Pinata JWT used for public metadata uploads in the create flow. |
| `VITE_PINATA_GATEWAY_URL` | Yes | Dedicated Pinata gateway domain/host used by the SDK (for example `example-gateway.mypinata.cloud`). |
| `VITE_PINATA_PUBLIC_GATEWAY_URL` | No | Public gateway base URL used for stored metadata URLs and read fallbacks. Defaults to `https://gateway.pinata.cloud`. |
| `VITE_DAVINCI_CENSUS_URL` | No | Census API URL used for proof generation. Falls back to indexer URL when empty. |
| `VITE_SELF_APP_NAME` | No | Display name used in Self payloads. |
| `VITE_WALLETCONNECT_PROJECT_ID` | Conditional | Required only when no injected wallet is available in creator flow. |

Notes:
- Metadata upload now uses Pinata from the browser and stores an HTTP gateway URL in the process metadata.
- The current implementation intentionally uses a client-visible JWT for this flow, so use a token scoped appropriately for public uploads.
- `VITE_PINATA_GATEWAY_URL` should be the gateway host/domain, not a full `https://` URL.
- Stored metadata URLs default to the public Pinata gateway so voting/explore pages are not blocked by dedicated-gateway access controls.
- During local `npm run dev`, Vite proxies Pinata uploads through `/pinata-upload` to avoid browser CORS failures against `uploads.pinata.cloud`.

## Development
```bash
cd /Users/lucasmenendez/Workspace/vocdoni/davinci-miniapps/selfxyz-davinci-miniapp/webapp
npm install
npm run dev
```

## Build and preview
```bash
npm run build
npm run preview
```

### Static assets in production
- Runtime static files referenced by URL (for example `/assets/davinci_logo.png`) must be stored under `public/`.
- Vite copies `public/*` into `dist/*` at build time, so deployment platforms (including DigitalOcean App Platform) can serve them correctly.

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
- App shell and routing: `src/App.tsx`
- Create flow route: `src/routes/CreateRoute.tsx`
- Create flow model/constants/types: `src/routes/create/*`
- Vote flow route: `src/routes/VoteRoute.tsx`
- Styling: `src/style.css`
- Self payload adapter: `src/selfApp.ts`
- Runtime HTML: `index.html`
- Shared app constants/helpers: `src/lib/occ.ts`
