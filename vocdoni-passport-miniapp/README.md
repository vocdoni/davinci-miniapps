# vocdoni-passport-miniapp

Voting webapp that uses **Vocdoni Passport** (zkPassport) for voter registration on **Ethereum Sepolia**, replacing the Self.xyz/Celo integration in `selfxyz-davinci-miniapp`.

Registration flow:
1. Voter opens the voting page and clicks "Submit vote".
2. The webapp generates a `ProofRequestPayload` and renders it as a QR code served by the passport backend.
3. Voter scans with the Vocdoni Passport mobile app → app generates a zkPassport outer proof.
4. Backend (`vocdoni-passport-prover`) aggregates the proof, verifies it on-chain via `ZKPassportCensus`, and pays gas.
5. Voter is added to the census; the webapp detects readiness via the census indexer and auto-submits their vote.

## Environment variables

| Variable | Description |
|---|---|
| `VITE_NETWORK` | `sepolia` |
| `VITE_CHAIN_ID` | `11155111` |
| `VITE_PASSPORT_BACKEND_URL` | URL of the `vocdoni-passport-prover` server |
| `VITE_ONCHAIN_CENSUS_INDEXER_URL` | Census indexer base URL |
| `VITE_DAVINCI_SEQUENCER_URL` | Davinci sequencer URL |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID |

## Related

- `vocdoni-passport-prover` — backend server that aggregates zkPassport proofs and submits census registration txs
- `davinci-contracts/src/ZKPassportCensus.sol` — on-chain census contract with Barretenberg proof verification
- `selfxyz-davinci-miniapp` — original app using Self.xyz on Celo (kept as-is)
