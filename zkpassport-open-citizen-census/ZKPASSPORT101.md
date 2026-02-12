# ZKPASSPORT101

## 1) zkPassport on-chain flow in plain words

1. Your app creates a zkPassport proof request (with the SDK), defining what the user must prove (for example, age >= 18), what can be disclosed, and how to bind context (`compressed-evm` mode).
2. The user opens/scans the request in the zkPassport app and generates a proof.
3. SDK callbacks return the result and the proof payload.
4. Your frontend converts the proof into Solidity verifier parameters.
5. The frontend sends a transaction to your contract (for example `registerVoter(...)`).
6. Your contract calls zkPassport's verifier contract (`verify(...)`) to validate the proof and obtain verification output.
7. Your contract applies app-specific checks using the helper contract, such as:
   - scope validation (`verifyScopes`)
   - bound-data validation (`getBoundData`) for chain/contract/sender binding
   - disclosed-data checks (age, nationality, etc.)
8. If all checks pass, your contract registers the user (for example by setting weight and inserting into your census tree).

## 2) SDK interaction summary

Typical SDK lifecycle:

1. Build request with `request(...)` and constraints.
2. Set callbacks (`onProofGenerated`, `onResult`) to receive proof/result.
3. Convert to contract-call input using `getSolidityVerifierParameters(...)`.
4. Send transaction from wallet client to your contract method.

## References

- zkPassport on-chain integration overview: [https://docs.zkpassport.id/getting-started/onchain](https://docs.zkpassport.id/getting-started/onchain)
- zkPassport on-chain integration steps: [https://docs.zkpassport.id/getting-started/onchain#integration-steps](https://docs.zkpassport.id/getting-started/onchain#integration-steps)
- Self.xyz IdentityVerificationHub verification docs (comparison): [https://docs.self.xyz/technical-docs/verification-in-the-identityverificationhub](https://docs.self.xyz/technical-docs/verification-in-the-identityverificationhub)
- zkPassport docs repository (raw content): [https://github.com/zkpassport/zkpassport-docs](https://github.com/zkpassport/zkpassport-docs)
- zkPassport EVM contracts/interfaces repository: [https://github.com/zkpassport/zkpassport-packages/tree/main/packages/evm-contracts](https://github.com/zkpassport/zkpassport-packages/tree/main/packages/evm-contracts)
