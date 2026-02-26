# OpenCitizenCensus

Smart contract registry that implements `ICensusValidator` by building an on-chain Lean-IMT census of Self.xyz-verified humans. The `OpenCitizenCensus` contract verifies Self.xyz V2 proofs for a selected country set (1-5 entries) and minimum age, enforces one-person-one-entry via nullifiers, and exposes the current and historical census roots for on-chain validation.

## Contracts

- `contract/src/OpenCitizenCensus.sol`
  - Implements `ICensusValidator`
  - Extends Self.xyz `SelfVerificationRoot`
  - Ownable (admin can update verification config id)
  - Stores and updates a Lean-IMT census tree in contract

## How it works

1. **Deployment**
   - Constructor inputs:
     - `identityVerificationHubAddress`: Self.xyz IdentityVerificationHub V2 proxy address
     - `scopeSeed`: short string used to derive the on-chain scope
     - `configId`: verification configuration id known by the hub
     - `targetNationalitiesAlpha3`: ISO-3166-1 alpha-2/alpha-3 string array (must match Self output)
     - `minAge`: minimum age required to register
2. **Proof submission**
   - The parent `SelfVerificationRoot` contract validates a Self.xyz V2 proof.
   - After verification, it calls `customVerificationHook`.
3. **Eligibility checks**
   - Address bound in the proof must be non-zero.
   - Age must be at least the configured `minAge` (constructor arg).
   - Country must match one value from `targetNationalitiesAlpha3`.
   - Address must not be registered already.
   - Nullifier must not be used already.
4. **Census update**
   - Leaf is `uint256(uint160(user))`.
   - Leaf is inserted into the Lean-IMT tree.
   - Root history is rotated (ring buffer of last 100 roots).
   - `weightOf[user]` is set to `1`, `WeightChanged` is emitted.
5. **Validation API**
   - `getCensusRoot()` returns the current root.
   - `getRootBlockNumber(root)` returns:
     - `block.number` for the current root,
     - the last valid block for historical roots,
     - `0` if the root is unknown/evicted.

## Lean-IMT details

- Uses `zk-kit.solidity` Lean-IMT `InternalLeanIMT` with `LeanIMTData` stored in contract.
- Leaf format for `OpenCitizenCensus` is just the registering address: `uint256(uint160(user))`.
- Each successful registration calls `_tree._insert(leaf)` (no updates/removals).
- Root history is kept in a circular buffer of size `100` (see details below).
- Helper getters:
  - `treeSize()`, `treeDepth()`, `leafOf(address)`

## Circular buffer + root history (reference vs current)

The reference `DavinciDao.sol` uses OpenZeppelin’s `CircularBuffer.Bytes32CircularBuffer` to track recent Merkle roots. The key pattern is:

- Initialize buffer with capacity 100 via `_rootBuffer.setup(100)`.
- After any tree modification, call `_updateRootHistory()`:
  - `newRoot = _census._root()`; push to buffer with `_rootBuffer.push(bytes32(newRoot))`.
  - Store `block.number` in `_rootToBlock[newRootBytes]`.
  - Note: evicted roots are not cleaned from `_rootToBlock` (accepted as minor storage leak).
- `getRootBlockNumber(root)` returns `_rootToBlock[bytes32(root)]` (0 if never set).

`OpenCitizenCensus.sol` currently implements a manual ring buffer:

- Stores `_currentRoot` separately and returns `block.number` for the active root.
- Keeps `_historyRoots[_historyIndex]` and `_historyLastValidBlock[_historyIndex]` for the last 100 replaced roots.
- On each new root, it:
  - writes the previous root to the history arrays,
  - stores its `lastValidBlock` in `_rootLastValidBlock`,
  - deletes evicted root mapping entries when the buffer wraps.

If you want the Self contract to mirror the exact `DavinciDao` pattern, you can replace the manual arrays with `CircularBuffer.Bytes32CircularBuffer` and a `bytes32 => uint64` mapping, and drop the “current root is valid at block.number” logic in favor of “root valid at block it was set”.

## Merkle tree construction (reference vs current)

The reference `DavinciDao.sol` builds the census with **Lean-IMT updates** based on token delegation:

- Leaf format packs address + weight: `(uint256(uint160(account)) << 88) | weight`.
- Uses `_census._insert`, `_census._update`, `_census._remove` depending on whether:
  - a delegate gains first weight (insert),
  - weight changes (update),
  - weight returns to zero (remove).
- Verifies proofs for updates/removals and checks leaf values are within `SNARK_SCALAR_FIELD`.
- Weight is tracked off-chain (events/subgraph), and proofs carry `currentWeight`.

`OpenCitizenCensus.sol` uses a **simpler, append-only** Lean-IMT:

- Leaf is only the address (no weight packing).
- Each successful verification inserts one leaf; there are no updates/removals.
- Uniqueness is enforced by nullifiers + `weightOf[user]` guard.

If you plan to support removals or weight changes in the Self registry, you’ll need to:

- Define a packed leaf format (likely address + weight),
- Store or prove weights for `_update`/`_remove`,
- Keep `SNARK_SCALAR_FIELD` bounds checks as in `DavinciDao.sol`.

## Requirements and assumptions

### On-chain

- Solidity `0.8.28` (required by `@selfxyz/contracts`).
- `@selfxyz/contracts` available via submodule (`contract/lib/self`).
- Lean-IMT available via submodule (`contract/lib/zk-kit.solidity`, pulls `poseidon-solidity`).
- `@openzeppelin/contracts` for `Ownable`.

### Off-chain / operational

- A valid Self.xyz V2 verification config and `configId`.
- Frontend or client that generates and submits Self.xyz proofs for:
  - `olderThan >= minAge`
  - `country` is included in `targetNationalitiesAlpha3` (alpha-2 or alpha-3, must match Self output)
  - `userIdentifier` bound to the registering address
- Operational understanding of the scope seed and nullifier behavior for uniqueness.

## Web app

### Ask The World - DAVINCI

Path: `webapp`

Purpose: React + TypeScript SPA for end-to-end process creation and voting. It deploys the census contract, registers it in the onchain census indexer, creates the sequencer process, and serves the `/vote/:processId` flow with deferred Self.xyz registration.

Routes:

- `/create`
- `/vote/:processId`

Dev:

```bash
cd webapp
npm install
npm run dev
```

Quality gates:

```bash
npm run typecheck
npm run test
npm run build
```

Indexer repository: `https://github.com/vocdoni/onchain-census-indexer`.

## Step-by-step

### 1) Deploy the contract on Celo

Prereqs:

- Foundry installed (`forge --version`).
- A funded deployer key for Celo or Celo Sepolia.
- A Self.xyz `configId` for the verification config you want to use (or register it on-chain as part of deployment).
- Submodules initialized (needed for `zk-kit.solidity`, `poseidon-solidity`, and `self`):

```bash
cd contract
# Avoid --recursive: lib/self has a nested private submodule not needed for contracts
git submodule update --init lib/self lib/zk-kit.solidity lib/poseidon-solidity
```

Tip: You can generate `configId` and scope info with the Self Developer Tools at `https://tools.self.xyz/` (Scope Generator + “Set Verification Config”). The hub generates config ids as `sha256(abi.encode(VerificationConfigV2))`.

Hub addresses (from `contract/lib/self/common/src/constants/constants.ts`):

- Celo Mainnet: `0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF`
- Celo Sepolia (testnet): `0x16ECBA51e18a4a7e61fdC417f0d47AFEeDfbed74`

PoseidonT3 library addresses (used by `SelfVerificationRoot`):

- Celo Mainnet: `0xF134707a4C4a3a76b8410fC0294d620A7c341581`
- Celo Sepolia (testnet): `0x0a782f7F9f8Aac6E0bacAF3cD4aA292C3275C6f2`

Deploy (example):

PoseidonT3 is a linked library, so deployment commands must include a `--libraries` flag.

```bash
cd contract
forge build

# Celo Mainnet example
export RPC_URL="https://forno.celo.org"
export PRIVATE_KEY="0x..."
export HUB_ADDRESS="0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF"
export POSEIDON_T3="0xF134707a4C4a3a76b8410fC0294d620A7c341581"
export CHAIN_ID="42220"
export SCOPE_SEED="open-citizen-census"
export CONFIG_ID="0x..."
export NATIONALITIES="ESP,FRA" # CSV list, max 5 entries
export MIN_AGE="18"
export SELF_REGISTER_CONFIG="0" # set to 1 to register config on-chain
export SELF_MIN_AGE="18" # defaults to MIN_AGE when empty
export SELF_OFAC_ENABLED="0"
export SELF_FORBIDDEN_COUNTRIES="" # CSV, e.g. "RUS,IRN"
export VERIFIER="etherscan"
export VERIFIER_URL="https://api.celoscan.io/v2/api?chainid=$CHAIN_ID"
export ETHERSCAN_API_KEY="..."

forge script script/DeployOpenCitizenCensus.s.sol:DeployOpenCitizenCensus \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --verifier $VERIFIER \
  --verifier-url $VERIFIER_URL \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --libraries "lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:$POSEIDON_T3"
```

Constructor args recap (read from env by the deploy script):

1. `identityVerificationHubAddress`
2. `scopeSeed` (ASCII, <=31 chars)
3. `configId` (bytes32) — provided by Self.xyz
4. `targetNationalitiesAlpha3` (string[])
5. `minAge` (uint256)

Optional: use the provided env template for deployments:

```bash
cp .env.deploy.example .env.deploy
# fill values in .env.deploy
make deploy

# Skip verification (if you don't have explorer credentials):
# VERIFY=0 make deploy

# Or run the deploy script directly:
# forge script script/DeployOpenCitizenCensus.s.sol:DeployOpenCitizenCensus \
#   --rpc-url $RPC_URL \
#   --private-key $PRIVATE_KEY \
#   --broadcast \
#   --verify \
#   --verifier $VERIFIER \
#   --verifier-url $VERIFIER_URL \
#   --etherscan-api-key $ETHERSCAN_API_KEY \
#   --libraries "lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:$POSEIDON_T3"
```

Notes on verification:

- Explorer APIs have moved to v2. Use a URL like `https://api.etherscan.io/v2/api?chainid=$CHAIN_ID`.
- For CeloScan, use `https://api.celoscan.io/v2/api?chainid=42220` (mainnet) or
  `https://api-sepolia.celoscan.io/v2/api?chainid=11142220` (testnet).

Notes on config registration:

- The hub generates `configId` as `sha256(abi.encode(VerificationConfigV2))`.
- If `SELF_REGISTER_CONFIG=1`, the deploy script registers the Self verification config on the hub
  using `SELF_MIN_AGE`, `SELF_OFAC_ENABLED`, and `SELF_FORBIDDEN_COUNTRIES`, and uses the returned
  `configId` for deployment.
- If `SELF_REGISTER_CONFIG=0`, you must set `CONFIG_ID` from tools.self.xyz (or another trusted source).

### 1b) Deploy on Celo Sepolia (testnet)

Notes:

- Self on Celo Sepolia only works with **mocked passports/IDs** generated inside the Self app.
- Use the Self test hub at `0x16ECBA51e18a4a7e61fdC417f0d47AFEeDfbed74`.
- The Self Developer Tools can generate test configs and show the expected `configId` on Celo Sepolia.

```bash
cd contract
forge build

# Celo Sepolia (testnet) example
export RPC_URL="https://forno.celo-sepolia.celo-testnet.org"
export PRIVATE_KEY="0x..."
export HUB_ADDRESS="0x16ECBA51e18a4a7e61fdC417f0d47AFEeDfbed74"
export POSEIDON_T3="0x0a782f7F9f8Aac6E0bacAF3cD4aA292C3275C6f2"
export CHAIN_ID="11142220"
export SCOPE_SEED="open-citizen-census-test"
export CONFIG_ID="0x..."
export NATIONALITIES="ESP,FRA" # CSV list, max 5 entries
export MIN_AGE="18"
export SELF_REGISTER_CONFIG="0"
export SELF_MIN_AGE="18"
export SELF_OFAC_ENABLED="0"
export SELF_FORBIDDEN_COUNTRIES=""
export VERIFIER="etherscan"
export VERIFIER_URL="https://api-sepolia.celoscan.io/v2/api?chainid=$CHAIN_ID"
export ETHERSCAN_API_KEY="..."

forge script script/DeployOpenCitizenCensus.s.sol:DeployOpenCitizenCensus \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --verifier $VERIFIER \
  --verifier-url $VERIFIER_URL \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --libraries "lib/poseidon-solidity/contracts/PoseidonT3.sol:PoseidonT3:$POSEIDON_T3"
```

Keep the same `scopeSeed` and `minAge` aligned with the webapp test config below.

### 2) Configure the web app

The web app reads all contract-related data from environment variables (no manual input in the UI).

If you need help deriving the scope or building the verification config, the Self Developer Tools can generate these values.

```bash
cd webapp
cp .env.example .env
```

Edit `webapp/.env`:

```bash
VITE_NETWORK="celo" # or staging_celo (Celo Sepolia)
VITE_ONCHAIN_CENSUS_INDEXER_URL="https://your-indexer.example.org"
VITE_DAVINCI_SEQUENCER_URL="https://sequencer.example.org"
VITE_SELF_APP_NAME="Ask The World - DAVINCI" # optional
VITE_WALLETCONNECT_PROJECT_ID="" # required when no injected wallet is available
```

The census URI is derived automatically as:

```
{ONCHAIN_CENSUS_INDEXER_URL}/{CHAIN_ID}/{CONTRACT_ADDRESS}/graphql
```

The indexer codebase is available at `https://github.com/vocdoni/onchain-census-indexer`.

Test config for Celo Sepolia (testnet):

```bash
VITE_NETWORK="staging_celo"
VITE_ONCHAIN_CENSUS_INDEXER_URL="https://your-indexer.example.org"
VITE_DAVINCI_SEQUENCER_URL="https://sequencer.example.org"
VITE_SELF_APP_NAME="Ask The World - DAVINCI (Test)" # optional
VITE_WALLETCONNECT_PROJECT_ID=""
```

### 3) Run the web app

```bash
cd webapp
npm install
npm run dev
```

Flow:

1. Open `/create` and connect a creator wallet.
2. Configure and create the process.
3. Share the generated `/vote/:processId` link.
4. Voters open the link, choose an option, complete Self.xyz registration if required, and submit the vote.

## Resources

- Self.xyz V2 contracts and verification flow (SelfVerificationRoot, IdentityVerificationHub).
- zk-kit Lean-IMT library (InternalLeanIMT).
- Reference implementation mentioned by the project:
  - `DavinciDao.sol` in `vocdoni/davinci-onchain-census` (see the GitHub link in the request).

## Integration notes

Downstream contracts can use:

- `ICensusValidator.getCensusRoot()` and a Merkle proof against the Lean-IMT.
- `ICensusValidator.getRootBlockNumber(root)` to ensure a root was valid at a given block.

When validating historical roots, ensure the root is within the retained history window (last 100 replacements).
