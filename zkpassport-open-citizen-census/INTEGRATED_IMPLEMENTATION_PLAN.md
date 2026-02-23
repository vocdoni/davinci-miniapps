# zkPassport Open Citizen Census Integrated Plan

## Goal

Deliver a contract-first zkPassport census stack where contract, backend, and webapp are compatible by design, with chain parameterization enabled from day one:

1. Current target chain: Sepolia (`11155111`)
2. Future target chains: Base Mainnet (`8453`) and Ethereum Mainnet (`1`)

## Delivery Order

1. Implement and test contract package first.
2. Freeze contract interfaces and event semantics.
3. Run compatibility review and test-vector alignment across all three plans.
4. Implement backend against frozen contract interfaces.
5. Implement webapp against frozen backend and process metadata contracts.

## Cross-Plan Compatibility Contract

### Contract -> Backend

1. Backend consumes:
   - `registerVoter(address voter, ProofVerificationParams proofVerificationParams, bool isIDCard)`
   - `isUniqueIdentifierRegistered(bytes32 uniqueIdentifier)`
   - `Registered(voter, sponsor, uniqueIdentifier, leaf, newRoot)` event
2. Contract enforces:
   - chain-bound proof via `destinationChainID == bytes32(block.chainid)`
   - `requiredCustomData` equality
   - uniqueness by `uniqueIdentifier`
3. Backend must map revert/failure cases to API errors consistently.

### Backend -> Webapp

1. Webapp sends:
   - `voterAddress`
   - `proofVerificationParams`
   - `isIDCard`
   - `signature`
   - `signedPayload`
2. `signedPayload` must include:
   - `voterAddress`
   - `proofHash`
   - `chainId`
   - `censusAddress`
   - `requiredCustomData`
   - `issuedAt`
   - `expiresAt`
3. Backend responds with:
   - `txHash`
   - `chainId`
   - `censusAddress`

### Webapp -> Contract Metadata Binding

1. Process metadata must include:
   - `meta.network.key`
   - `meta.network.chainId`
   - `meta.zkPassportConfig.scopeDomain`
   - `meta.zkPassportConfig.scope`
   - `meta.zkPassportConfig.requiredCustomData`
   - `meta.zkPassportConfig.censusAddress`
   - `meta.zkPassportConfig.censusURI`
   - `meta.zkPassportConfig.backendRegisterUrl`
2. Webapp chain checks are driven by metadata chain profile, not hardcoded constants.

## Chain Parameterization Strategy

### Shared chain profile model

All layers must use the same chain-profile keys and chain IDs:

1. `sepolia` -> `11155111`
2. `base` -> `8453`
3. `mainnet` -> `1`

### Runtime behavior

1. Contract:
   - same code on all chains
   - validates with `block.chainid`
2. Backend:
   - resolves profile by `signedPayload.chainId`
   - rejects unsupported chains
3. Webapp:
   - loads configured chain profiles
   - selects target chain in create flow
   - enforces process chain in vote/register flow

### `requiredCustomData` standard

All layers use the same formula:

1. `keccak256(abi.encode("davinci-zkpassport-v1", chainId, scopeDomain, scope))`

## Compatibility Review Gate (Before Backend/Webapp Buildout)

Produce and approve the following artifacts:

1. Interface matrix (contract ABI + backend API + webapp metadata schema)
2. Canonical payload and proof-hash specification
3. Positive/negative vectors for:
   - Passport flow
   - ID card flow
   - wrong chain
   - wrong customData
   - reused uniqueIdentifier
   - invalid signature
4. Error mapping table:
   - contract failures -> backend error codes -> webapp UX states

## Acceptance Criteria

1. Contract tests pass for both document types and chain-bound checks.
2. Backend accepts valid requests on enabled chain profiles and rejects unsupported chains.
3. Webapp can create/register/vote on Sepolia profile.
4. Base/Mainnet activation requires only adding profiles/deployments, not changing protocol contracts.
5. All three individual plan files remain consistent with this integrated plan.

## References

1. zkPassport on-chain overview: [https://docs.zkpassport.id/getting-started/onchain](https://docs.zkpassport.id/getting-started/onchain)
2. zkPassport integration steps: [https://docs.zkpassport.id/getting-started/onchain#integration-steps](https://docs.zkpassport.id/getting-started/onchain#integration-steps)
3. zkPassport docs repository: [https://github.com/zkpassport/zkpassport-docs](https://github.com/zkpassport/zkpassport-docs)
4. zkPassport EVM contracts/interfaces: [https://github.com/zkpassport/zkpassport-packages/tree/main/packages/evm-contracts](https://github.com/zkpassport/zkpassport-packages/tree/main/packages/evm-contracts)
5. onchain-census-indexer repository: [https://github.com/vocdoni/onchain-census-indexer](https://github.com/vocdoni/onchain-census-indexer)
6. DaVinci contracts repository: [https://github.com/vocdoni/davinci-contracts](https://github.com/vocdoni/davinci-contracts)
