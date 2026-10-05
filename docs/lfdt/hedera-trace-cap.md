# Hedera's contract trace-size cap and large-calldata CLPR verifiers

A technical note for CLPR maintainers and verifier authors. It explains why a CLPR transaction on Hedera can fail
with `INSUFFICIENT_GAS` although it has enough gas, shows the evidence from Hedera testnet, gives a reproduction, and
estimates what the cap means for any CLPR verifier that takes a large input in one call.

## Summary

- A Hedera consensus node limits the serialized size of the contract trace it records for each transaction:
  `contracts.maxSerializedTraceDataBytes`, default **262,144 bytes**. The trace includes every call frame's input
  and output (precompile calls included) and every storage slot read or written.
- A transaction whose trace exceeds the cap is executed in full, then **failed with `INSUFFICIENT_GAS` and rolled
  back**. Gas used equals the full execution gas, whatever the gas limit. Neither `eth_estimateGas` (mirror-node EVM)
  nor an anvil fork applies the cap, so both report success.
- In CLPR, a verifier's input is recorded at least three times (the Service call, the delegatecall into its logic
  module, the verifier call), so the effective budget for one verifier input is well under 87 KB, less again for any
  precompile work per input byte.
- We hit it opening a CLPR Channel on Hedera testnet with the CLPR repo's `EthMainnetVerifier`: the 512-key
  sync-committee config (67,364 B of call data) produces about 302 KB of raw trace. We worked around it with a
  staged-input adapter and propose the same shape upstream for configuration and rotation.

## Where the cap is enforced

In [hiero-consensus-node](https://github.com/hiero-ledger/hiero-consensus-node) (checked at tag `v0.77.2`, the
version the CLPRouter deployment notes record for Hedera testnet at the time):

| Piece | Location |
| --- | --- |
| The setting, default `262144`, a network property | [`ContractsConfig.java`](https://github.com/hiero-ledger/hiero-consensus-node/blob/v0.77.2/hedera-node/hedera-config/src/main/java/com/hedera/node/config/data/ContractsConfig.java) (`maxSerializedTraceDataBytes`) |
| The running estimate of serialized trace data per transaction | [`TraceDataSizeLimiter.java`](https://github.com/hiero-ledger/hiero-consensus-node/blob/v0.77.2/hedera-node/hedera-app/src/main/java/com/hedera/node/app/workflows/handle/record/TraceDataSizeLimiter.java) |
| The failure: `if (hasExceededTraceDataSizeLimit(...)) throw new HandleException(INSUFFICIENT_GAS, rollbackHandler)`; the same check also counts the bytecode sidecar of contract creations | [`ConversionUtils.throwIfUnsuccessfulCall`](https://github.com/hiero-ledger/hiero-consensus-node/blob/v0.77.2/hedera-node/hedera-smart-contract-service-impl/src/main/java/com/hedera/node/app/service/contract/impl/utils/ConversionUtils.java#L801-L826) |

The trace in question is what the node writes as the contract sidecars (`ContractActions`, `ContractStateChanges`,
and bytecode for creations), which the mirror node serves as `/contracts/results/{tx}/actions` and
`state_changes`.

## Evidence on Hedera testnet

The same `completeChannel` call to the CLPR Service (`0xa6db474e3047c3d43b10a4ff7abad547d89982b9`) with the
`EthMainnetVerifier` bootstrap config, five times. Figures from the Hedera testnet mirror node, re-checked on
5 October 2026:

| Transaction | Gas limit | Gas used | Call data | Result | Mirror-node actions |
| --- | ---: | ---: | ---: | --- | --- |
| [`0x6f0285ff…`](https://hashscan.io/testnet/transaction/0x6f0285ff22c877035165e025a01350fc7077fffe8bbb2a0f9d7fbebaed99781e) | 5,611,286 | 4,062,470 | 67,364 B | `INSUFFICIENT_GAS` | none |
| [`0x4b95f023…`](https://hashscan.io/testnet/transaction/0x4b95f023fca443c71c9ed892be2dcd2aaf4ee247f819a7b91ff74c11b86d9643) | 12,949,122 | 4,062,470 | 67,364 B | `INSUFFICIENT_GAS` | none |
| [`0xed92841b…`](https://hashscan.io/testnet/transaction/0xed92841b6bae53ef5da7c25d9f0412a1d397decbe6a2709f6d07292c46efec90) | 6,000,000 | 4,062,470 | 67,364 B | `INSUFFICIENT_GAS` | none |
| [`0xa289c0b9…`](https://hashscan.io/testnet/transaction/0xa289c0b9ce2665fea2bceab8ad87c2a8ca21031b2d4a243a5f5c610e3379d0c7) | 6,000,000 | 4,062,470 | 67,364 B | `INSUFFICIENT_GAS` | none |
| [`0x7dc546cd…`](https://hashscan.io/testnet/transaction/0x7dc546cdba0c66c0c0a5bb18014c60786071c69045489a4a2e8256826542cdf3) | 15,000,000 | 4,062,470 | 67,364 B | `INSUFFICIENT_GAS` | none |

The signature of the cap: identical gas used at every limit, up to Hedera's 15M maximum, and no recorded actions or
state changes. About 9.62 HBAR was charged per attempt (48.1 HBAR for the five).

### The trace, frame by frame

Replaying the first transaction's call data from its sender on an anvil fork of Hedera testnet at the block before it
(steps below) succeeds with the same 4,062,470 gas. Its call trace:

| Frame | Count | Input + output |
| --- | ---: | ---: |
| `CALL` ClprService | 1 | 67,364 B |
| `DELEGATECALL` into the Service's logic module | 1 | 67,364 B |
| `STATICCALL` `EthMainnetVerifier.verifyConfig` | 1 | 68,260 B (67,012 in, 1,248 out) |
| `STATICCALL` ecrecover (`0x01`) | 1 | 160 B |
| `STATICCALL` `BLS12_G1ADD` (`0x0b`), on-curve checks | 257 | 98,688 B |
| **Total** | **261 actions, 37 storage slots** | **301,836 B raw** |

`script/deploy/trace-size.mjs` adds a per-action and per-slot allowance for the protobuf framing and estimates
**~331,036 B, 126.3 % of the cap**. The raw frame data alone is 115 % of it.

### The workaround, measured the same way

[`StagedEthConfigVerifier`](../../script/deploy/StagedEthConfigVerifier.sol) stages the committee in 16 chunks of 32
keys (`stageChunk`, about 4 KB each, under Hedera's 6 KB non-jumbo transaction size) with the same on-curve check,
records each chunk's Merkle subtree root, and opens the Channel with the 16 roots. `verifyConfig` returns exactly
what `EthMainnetVerifier.verifyConfig` returns for the full config (parity test:
[`test/unit/StagedEthConfigVerifier.t.sol`](../../test/unit/StagedEthConfigVerifier.t.sol)); `verifyBundle` forwards
to the unchanged `EthMainnetVerifier`. Each live transaction replayed on a fork and estimated with `trace-size.mjs`:

| Live transaction | Gas | Actions | Raw | Estimate | Share of cap |
| --- | ---: | ---: | ---: | ---: | ---: |
| `stageChunk` [`0xdf341d48…`](https://hashscan.io/testnet/transaction/0xdf341d4864af1506c95e52dde2aeb9659b9c06fc61e716b0d8be3cd0cb102ccd) | 171,716 | 18 | 10,724 B | ~12,564 B | 4.8 % |
| `completeChannel` (16 roots) [`0x28556511…`](https://hashscan.io/testnet/transaction/0x285565114acef4b37592e9ac115460bbfcabd547936e44fd515ed9919132a3d9) | 788,546 | 5 | 5,484 B | ~11,900 B | 4.5 % |
| `submitBundle`, one routed message, 14,829 B proof [`0x1249ca90…`](https://hashscan.io/testnet/transaction/0x1249ca9040fb4c1f02e99ee656823393b223bf9f2bcba9d2a6cdb36344e1989b) | 2,755,892 | 76 | 104,440 B | ~120,248 B | 45.9 % |

(The fork replay of the `submitBundle` used 2,757,092 gas, 1,200 more than on Hedera; the trace figures are from the
replay.) The staged path cost 16 × ~0.142 HBAR plus 0.65 HBAR for `completeChannel`, against 9.62 HBAR per failed
single-transaction attempt.

## Reproduction

### 1. Read the failure from the mirror node

```sh
TX=0x6f0285ff22c877035165e025a01350fc7077fffe8bbb2a0f9d7fbebaed99781e
M=https://testnet.mirrornode.hedera.com/api/v1
curl -s $M/contracts/results/$TX | jq '{result, gas_limit, gas_used, block_number,
  calldata_bytes: ((.function_parameters | length) - 2) / 2}'
curl -s $M/contracts/results/$TX/actions          # {"actions": [] ...}
```

### 2. Replay it on a fork and measure the trace

Needs Foundry and Node 22. Any Hedera testnet JSON-RPC relay works as the fork source.

```sh
M=https://testnet.mirrornode.hedera.com/api/v1
TX=0x6f0285ff22c877035165e025a01350fc7077fffe8bbb2a0f9d7fbebaed99781e
R=$(curl -s $M/contracts/results/$TX)
BLOCK=$(( $(echo "$R" | jq .block_number) - 1 ))
TO=$(echo "$R" | jq -r .to)
INPUT=$(echo "$R" | jq -r .function_parameters)
FROM=$(curl -s $M/accounts/0.0.$(( $(echo "$R" | jq -r .from) )) | jq -r .evm_address)

anvil --fork-url https://testnet.hashio.io/api --fork-block-number $BLOCK \
      --chain-id 296 --hardfork osaka --port 18600 &
RPC=http://127.0.0.1:18600
cast rpc --rpc-url $RPC anvil_impersonateAccount $FROM
cast rpc --rpc-url $RPC anvil_setBalance $FROM 0x56BC75E2D63100000
FORK_TX=$(cast send --rpc-url $RPC --unlocked --from $FROM $TO $INPUT --gas-limit 15000000 --json \
          | jq -r .transactionHash)

node script/deploy/trace-size.mjs $RPC $FORK_TX
# ... actions 261 raw 301836 B, storage slots 37 → ~331036 B (126.3 % of 262144); exit code 1
```

The same steps with any transaction hash from the table above reproduce the workaround's figures.
`trace-size.mjs` exits with code 1 above 90 % of the cap, so it can gate a rehearsal or a CI run;
`script/settle-e2e/run.sh` runs it on every transaction of its Hedera stand-in chain.

### 3. Run the adapter's parity tests

```sh
forge test --match-path test/unit/StagedEthConfigVerifier.t.sol   # 8 tests
```

## What it means for CLPR verifiers on Hedera

Rule of thumb from the frame structure above, for one verifier input of `N` bytes passed through the Service:

```
trace ≈ 3·N  (Service call, delegatecall, verifier call)
      + Σ precompile input + output
      + ~96 B per call frame + ~112 B per storage slot
      ≤ 262,144 B
```

- **Hard ceiling on input size.** With no precompile work, `N` can be at most about 87 KB, before storage and
  framing. Anything near it fails on Hedera even though it passes on every EVM tool.
- **Per-item precompile work counts twice.** Each 128-byte G1 key that gets an on-curve check costs about
  3 × 128 B of input recording plus 384 B of `BLS12_G1ADD` input and output plus ~96 B of framing, about 860 B. That
  puts the ceiling at roughly 300 keys per transaction for this pattern, below a 512-member sync committee.
- **Paths that carry a full validator set or committee in one call are affected:** configuration (`completeChannel`
  → `verifyConfig`) and any bundle that carries the next set (a rotation). On Hedera, a Channel over
  `EthMainnetVerifier` today can be opened through staging but cannot follow a sync-committee rotation, so it stops
  verifying at the end of the period it was opened in (about 27 hours for a Sepolia period).
- **Bundles add up per message.** A bundle's trace grows with every message it carries, because the message bytes
  are recorded in several frames. Settle on Hedera measured about 12 KB of trace per DEPOSIT message and caps
  bundles to Hedera at 12 messages ([settle-on-hedera.md](../settle-on-hedera.md#hedera-specifics)).
- **Pre-flight tools give false confidence.** `eth_estimateGas` and forks succeed; only a trace-size estimate or a
  real Hedera submission shows the problem.

## Suggestions

For CLPR (details in [the staged-committee proposal](../proposals/clpr-staged-eth-committee.md)):

1. Let verifiers accept large trusted inputs in staged chunks (stage, check, record a commitment; then reference the
   commitments), for configuration and for rotation, with byte-for-byte parity tests against the one-call path.
2. Add a trace-size check (for example `trace-size.mjs` or an equivalent) to the CLPR e2e runs that target Hiero,
   and document a per-transaction trace budget for verifier authors next to the gas budget.

For Hiero (questions, not requests we can decide): whether precompile frames need to be recorded at full size in the
trace, and whether the cap's failure could carry a distinct status rather than `INSUFFICIENT_GAS`, which points
operators at gas.
