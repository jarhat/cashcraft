# ChallengeVault (BCH; regtest prototype)

`HodlVault.cash` is unchanged. `ChallengeVault.cash` is a separate covenant
that reuses HodlVault's absolute timelock for refunds. Building the auth
image compiles both with `cashc@0.14.0`. The challenge module is not exposed
by an API and its signer refuses non-regtest nodes. **Do not send real BCH
or CashTokens to these contracts.**

## Game / wallet interface

This version supports exactly two individually funded players and one payout
winner. The game server should use a unique random 32-byte hex `challenge_id`,
each player's authenticated P2PKH CashAddr, a dedicated BCHN referee P2PKH
CashAddr, the agreed integer `stake_sats`, and a fixed `refund_after` Unix
timestamp. Construct `backend.challenge_vault.ChallengeVault` with those
parameters and the explicit chain prefix (`bchreg` for local testing;
`bitcoincash` is the mainnet address encoding). The artifact defaults to
`/app/artifacts/ChallengeVault.json` in Docker.

- `funding()` returns roles `a` and `b`, each with `address`,
  `locking_bytecode` (hex), and `stake_sats`. Persist the terms, contract
  version, and one agreed `Outpoint(txid, vout)` per role before starting
  gameplay. Players must be able to retain that data without the server.
  Fund once per role, with the exact BCH amount and no tokens. Confirm
  both exact UTXOs on the correct chain and recheck after a reorganization.
- `sign_settlement(rpc, winner, stake_a, stake_b, anchor)` is a regtest-only
  helper for a trusted backend, not a client outcome endpoint. It verifies
  the three UTXOs, calls the dedicated wallet's `signrawtransactionwithwallet`
  with `ALL|FORKID`, then checks `testmempoolaccept`, returning hex without
  broadcasting. Pass `winner` as `a` or `b` from an authoritative result;
  the referee must not sign both results. The RPC adapter accepts
  `(method, params, *, wallet=False)`.
- `refund_transaction(role, outpoint, input_sats)` builds an independent
  refund without a referee, wallet signature or other player's outpoint.
  Anyone can submit it, but the BCH always returns to that role's original
  P2PKH script, less 1,000 sats. It uses a timestamp locktime, not block
  height. It cannot confirm until chain median time past exceeds the
  deadline. Duplicate or wrong-amount BCH outputs can only be recovered
  individually if each covers the fixed fee and a 546-sat output. CashTokens
  and deposits too small to cover that amount cannot be recovered here.

## Settlement constraints and trust

The covenant requires both exact stake UTXOs, A then B, and verifies
the other input's challenge-specific P2SH32 script from its own redeem script.
The third input must spend a BCH-only UTXO locked to the referee's P2PKH
script. Its native wallet signature signs the transaction and the winner
output. Settlement pays **both stakes in full to one of the two players**.
The second output returns anchor change to the referee, with exactly
2,000 sats withheld for the miner fee. The service cannot divert any stake
to its own output, but a dishonest referee can choose the wrong participant.
Use the referee key only for reviewed settlement, never for unrelated
transactions or with a weaker sighash: the contract checks the referee
input script, not the signature's hash-type byte.

BCH Script enforces the refund's lower time bound, **not a settlement
expiry**. Once refunds mature, an earlier signed settlement and either
refund compete for the same UTXOs; the first confirmed spend wins. The
helper stops signing one hour before the deadline, as measured against
both wall time and chain median time past. That does not revoke a signature.
An unsigned, unsettled, tied, or abandoned challenge can fall back to
independent refunds; a missing settlement confirms no winner on-chain.
Fixed fees are not a guarantee of timely relay or confirmation.

## Local test

Run from repository root with Docker and Python 3:

```sh
mkdir -p .challenge-check
npm exec --yes --package=cashc@0.14.0 -- cashc backend/contracts/HodlVault.cash -o .challenge-check/HodlVault.json
npm exec --yes --package=cashc@0.14.0 -- cashc backend/contracts/ChallengeVault.cash -o .challenge-check/ChallengeVault.json
node=cashcraft-challenge-regtest-$$
trap 'docker rm -f "$node" >/dev/null 2>&1' EXIT
docker run -d --name "$node" --network none --entrypoint bitcoind \
  uphold/bitcoin-cash-node -regtest -server -listen=0 -dnsseed=0
docker exec "$node" bitcoin-cli -regtest -rpcwait getblockchaininfo
PYTHONPATH=. python3 -B tests/challenge_vault_regtest.py "$node" .challenge-check/ChallengeVault.json
```

The test mines and funds synthetic coins in an isolated regtest container,
uses its local RPC cookie, and checks signed spends with
`testmempoolaccept`. It does not broadcast the settlement or refunds.

## Mainnet deployment gate

Mainnet is intentionally disabled, including on the existing mainnet-only
Compose stack. Before considering activation, independently review the
compiled covenant and transaction builder, verify P2SH32 support and current
fee policy in target wallets/BCHN, and review the settlement-vs-refund
window with players. Use a dedicated isolated BCHN referee wallet (not the
rewards wallet), authenticate game outcomes, persist and serialize signing
decisions and anchor reservations, and account for confirmation/reorg
handling, relay failures and refund recovery. Do not expose deposit addresses
in the game or enable signing until those controls and the expected mainnet
behavior have been verified. No change to the legacy vault address or
existing deposits is required.
