# Sponsored Registration Backend Plan

## Summary

Build a Node.js + TypeScript backend that receives:

- `voterAddress` (derived in frontend from `uniqueIdentifier + password`)
- zkPassport proof payload
- signature made by the voter wallet over the proof bundle

The backend must:

1. Verify proof.
2. Verify signature ownership.
3. Check on-chain uniqueness by `uniqueIdentifier` (primary), not only by address.
4. Send sponsored `registerVoter(...)` tx.
5. Return `txHash` directly to frontend (frontend tracks tx lifecycle).

Hard reject rules:

- If proof does not verify: reject request, do not send tx.
- If signature does not match voter address: reject request, do not send tx.

## API

### POST `/v1/register`

Single endpoint (no nonce endpoint).

Request body:

1. `voterAddress: string`
2. `proofVerificationParams: object`
3. `isIDCard: boolean`
4. `signature: string`
5. `signedPayload: object`

`signedPayload` fields:

1. `voterAddress`
2. `proofHash`
3. `chainId`
4. `censusAddress`
5. `issuedAt`
6. `expiresAt`

Success response:

1. `txHash`
2. `chainId`
3. `censusAddress`

Error response:

1. `code`
2. `message`

Error codes:

1. `INVALID_PROOF`
2. `INVALID_SIGNATURE`
3. `EXPIRED_SIGNATURE`
4. `UNSUPPORTED_CHAIN`
5. `ALREADY_REGISTERED_UNIQUE_IDENTIFIER`
6. `TX_SUBMISSION_FAILED`
7. `INVALID_REQUEST`

## Verification and Submission Flow

For each `POST /v1/register` request:

1. Validate request schema and checksum addresses.
2. Validate `chainId` and `censusAddress` against backend config.
3. Validate signature timestamp window (`issuedAt` / `expiresAt`).
4. Recompute `proofHash` from canonical proof bundle and compare with signed payload.
5. Recover signer from signature (EIP-712 typed data) and require `recovered == voterAddress`.
6. Verify proof off-chain using zkPassport verifier call and helper checks.
7. Extract `uniqueIdentifier` from proof verification output.
8. Check on-chain:
   - `isUniqueIdentifierRegistered(uniqueIdentifier) == false` (primary gate).
9. Send sponsored tx:
   - `registerVoter(voterAddress, proofVerificationParams, isIDCard)`.
10. Return `txHash` immediately.
11. Optionally run background post-mine audit log:
   - receipt success
   - `Registered` event includes expected voter + uniqueIdentifier
   - `isUniqueIdentifierRegistered(uniqueIdentifier) == true`

## Contract Dependencies

Backend requires these read methods on census contract:

1. `isUniqueIdentifierRegistered(bytes32 uniqueIdentifier) -> bool`

And `Registered` event including:

1. `voter`
2. `sponsor`
3. `uniqueIdentifier`

## Replay / Duplicate Handling (No Nonce Endpoint)

Because nonce endpoint is intentionally removed:

1. Backend uses short signature expiry (`expiresAt`) to limit replay window.
2. Backend keeps in-memory dedupe cache for in-flight `(proofHash, voterAddress)` to avoid duplicate submissions while first tx is pending.
3. Final anti-duplication remains on-chain via:
   - `uniqueIdentifierUsed` invariant (primary).

## Security

1. Password and private key never leave frontend device.
2. Backend never stores full proof payload in logs; log only hashes and identifiers.
3. Sponsor private key from environment variable (MVP), loaded at startup.

## Project Structure

1. `src/server.ts`
2. `src/routes/register.ts`
3. `src/services/proofVerifier.ts`
4. `src/services/signatureVerifier.ts`
5. `src/services/sponsorTx.ts`
6. `src/services/censusReadModel.ts`
7. `src/services/dedupeCache.ts`
8. `src/types/*.ts`
9. `.env.example`

## Tests

1. Valid proof + valid signature + unique UID => returns txHash.
2. Invalid proof => `INVALID_PROOF`, no tx.
3. Invalid signature => `INVALID_SIGNATURE`, no tx.
4. Signature expired => `EXPIRED_SIGNATURE`, no tx.
5. Already registered uniqueIdentifier => `ALREADY_REGISTERED_UNIQUE_IDENTIFIER`, no tx.
6. Duplicate in-flight submission => rejected by dedupe cache.
7. Tx RPC failure => `TX_SUBMISSION_FAILED`.

## Assumptions

1. Frontend derives wallet deterministically from `uniqueIdentifier + password`.
2. Backend validates ownership of `voterAddress` via signature, not derivation formula internals.
3. Single chain deployment per backend instance.
4. Frontend tracks the returned tx hash and handles UX for confirmations/failures.
