# Sponsored zkPassport Registration for Open Citizen Census

## Summary

Integrate zkPassport proof verification in the census contract with sponsored registration support:

- A relayer/sponsor can send the transaction (`msg.sender`).
- The proof must be cryptographically bound through `customData` (request/session binding).
- Registration only succeeds if all policy checks pass: scope, bound data, minimum age, and nationality.
- One-person uniqueness is enforced on-chain by `uniqueIdentifier` (primary identity key).
- Backend can verify final registration state on-chain after tx submission.

## Public API and Interface Changes

### Constructor parameters

Add constructor configuration for:

1. `address verifier`
2. `string scopeDomain`
3. `string scope`
4. `string targetNationality`
5. `string[] nationalityAliases`
6. `uint256 minAge`
7. `bytes32 requiredCustomData`

### Registration entrypoint

Use sponsored registration method:

```solidity
registerVoter(
    address voter,
    ProofVerificationParams calldata proofVerificationParams,
    bool isIDCard
) external
```

- `msg.sender` is sponsor/relayer.
- `voter` is the address that will be inserted in the census.

Add a convenience read method for backend/frontend checks:

```solidity
function isUniqueIdentifierRegistered(bytes32 uniqueIdentifier) external view returns (bool) {
    return uniqueIdentifierUsed[uniqueIdentifier];
}
```

### Storage changes

1. Keep `mapping(address => uint88) weightOf` for address registration status.
2. Use `mapping(bytes32 => bool) public uniqueIdentifierUsed` for one-person uniqueness (source of truth).
3. Keep Lean-IMT tree and root history (`getCensusRoot`, `getRootBlockNumber`).

### Event and error changes

Event:

```solidity
event Registered(
    address indexed voter,
    address indexed sponsor,
    bytes32 indexed uniqueIdentifier,
    uint256 leaf,
    uint256 newRoot
);
```

Errors:

- `AlreadyRegisteredAddress`
- `IdentifierAlreadyUsed`
- `InvalidScope`
- `InvalidBoundChain`
- `InvalidBoundCustomData`
- `NotAdult`
- `WrongNationality`

## Verification and Registration Flow

In `registerVoter(...)`, execute checks in this order:

1. Validate `voter != address(0)`.
2. Revert if `weightOf[voter] != 0` (secondary address-level dedup).
3. Call zkPassport verifier: `verify(proofVerificationParams, isIDCard)`.
4. Scope validation:
   - `helper.verifyScopes(verificationOutput.publicInputs, scopeDomain, scope)` must pass.
5. Bound data validation via `helper.getBoundData(verificationOutput.publicInputs)`:
   - `destinationChainID == bytes32(block.chainid)`
   - `customData == requiredCustomData`
6. Age validation:
   - `verificationOutput.disclosedData.minimumAge >= minAge`
7. Nationality validation:
   - Hash of disclosed nationality must be in allowed set (target + aliases).
8. Uniqueness validation:
   - `!uniqueIdentifierUsed[verificationOutput.uniqueIdentifier]`
   - Mark it as used.
9. Census registration:
   - Compute leaf: `uint256(uint160(voter))`
   - Insert leaf and rotate root
   - Set `weightOf[voter] = 1`
   - Emit `WeightChanged`
   - Emit `Registered(voter, msg.sender, uniqueIdentifier, leaf, newRoot)`

## Backend Post-Tx Verification Compatibility

To support backend verification after sending a sponsored tx:

1. Backend verifies proof off-chain and extracts `uniqueIdentifier`.
2. Before sending tx, backend checks `isUniqueIdentifierRegistered(uniqueIdentifier)` (primary) and rejects if already true.
3. Backend sends `registerVoter(...)`.
4. After tx is mined, backend must verify:
   - Receipt status is success.
   - `Registered` event contains expected `voter` and `uniqueIdentifier`.
   - `isUniqueIdentifierRegistered(uniqueIdentifier) == true`.

## `isIDCard` Meaning

`isIDCard` selects which zk proof circuit variant is validated:

- `false`: passport proof circuit
- `true`: ID card proof circuit

This is required when supporting both document types because circuit/public input formats differ.
If the product supports only passports, the implementation can hardcode `isIDCard = false` and remove it from the external API.

## Files to Add

Under this folder:

- `foundry.toml`
- `remappings.txt`
- `src/interfaces/IZKPassportVerifier.sol`
- `src/interfaces/IZKPassportHelper.sol`
- `src/types/ZKPassportTypes.sol`
- `test/OpenCitizenCensus.t.sol`

## Test Cases

Required tests:

1. Successful sponsor registration with valid proof bound to `voter`.
2. Revert when `customData` does not match required value.
3. Revert on invalid scope.
4. Revert on wrong chain ID.
5. `isUniqueIdentifierRegistered(uniqueIdentifier)` returns `false` before successful registration and `true` after.
6. Revert when disclosed age is below `minAge`.
7. Revert on disallowed nationality.
8. Success with configured nationality alias.
9. Revert when same `voter` registers twice.
10. Revert when same `uniqueIdentifier` is reused with a different `voter` address (e.g. different password-derived wallet).
11. Root rotation and historical root validity behavior.
12. Event assertions include both `voter` and `sponsor`.

## Acceptance Criteria

1. Contract compiles with Foundry in this `contract` folder.
2. All test cases above pass.
3. Sponsored transactions cannot alter the registered identity.
4. One-person and one-address constraints are enforced on-chain.

## Assumptions

1. Open sponsorship model (no sponsor allowlist).
2. Binding is enforced by `customData`; `senderAddress` is not used for voter binding.
3. Strict checks remain enabled (scope + chain + customData).
4. Canonical person key is `uniqueIdentifier`, and on-chain `uniqueIdentifierUsed` is authoritative for one-person uniqueness.
5. Nationality policy is exact hash match with configured aliases.
6. Replay protection at backend nonce layer is intentionally not required; duplicates are blocked by on-chain registration invariants.
