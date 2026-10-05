# CLPRouter: briefing for the LFDT CLPR maintainers

ColdAI, October 2026. Two pages, then a 10-minute demo script. Every figure links to a test, a file in this
repository, or a testnet transaction.

**Live demo:** <https://clprouter-demo.doyoka-platform.workers.dev>. The route planner runs the SDK in the browser,
and the testnet pages read Sepolia and Hedera testnet directly.

## 1. What CLPRouter is

CLPRouter is an **application on CLPR**. It uses `sendMessage` and application delivery like any other CLPR
application and needs **no change to the CLPR protocol, Service, verifiers or Connectors**. The CLPR reference
contracts are pinned as a submodule (`lib/clpr-smart-contracts` at `5f02d85`, branch `pr/eth-live-proofs`, which
carries `EthMainnetVerifier`), and the project rule is that the submodule stays unmodified.

It does two things on top of CLPR's pairwise Channels:

- **Multi-hop routing.** A message, optionally with an escrowed payment, is forwarded Router to Router across
  Channels (for example Ethereum → Hiero → an L2). Each hop is verified by its own Channel's verifier and re-checks
  the sender's rules on-chain (deadline, fees, disables, compliance filters at a pinned registry version, blacklist).
  A receipt travels back and the origin settles or refunds the escrow. With Hiero as a hub, 100 ledgers need 100
  Channels instead of 4,950. Routers are immutable, admin-less and deployed at canonical CREATE2 addresses.
- **Settle on Hedera.** A user pays on chain Y and is paid on chain X by a bonded Connector; both payments are proven
  to an order book on Hedera, and a missed deadline pays the user from the bond. It needs CLPR proofs only
  **chain → Hedera**, so it works with today's verifier directions.

## 2. What we built and verified

| | |
| --- | --- |
| Contracts | Router, registry, vault, deployer, 5 libraries; Settle order book, deposit and delivery contracts ([`src/`](../../src)) |
| Off-chain | Planner SDK with measured route data for 86 chains ([`sdk/`](../../sdk)); indexer, status API, quote service, forward trigger, reference Settle Connector ([`services/`](../../services)) |
| Tests | 359 Foundry tests in 22 suites (unit, fuzz, invariant, security regressions, three-ledger integration), 212 SDK tests, 172 services tests; CI, CodeQL and nightly e2e green on `main` |
| Local e2e | Five routes over three anvil chains; a round trip through a local Hiero (Solo) network; Settle on three anvil chains with Hedera trace-size checks |
| Reviews | Two internal security reviews, all High/Medium/Low items fixed with regression tests; re-review in progress; **no external audit** |
| Sepolia + Hedera testnet | Canonical deployment at identical addresses on both; a Channel verified on Hedera by `EthMainnetVerifier`; route Sepolia → Hedera **delivered** ([send](https://sepolia.etherscan.io/tx/0x8a08f19922f6a265f2900b218db01510c4dc21e50ed80b68ae8756faddff0d6c), [delivery](https://hashscan.io/testnet/transaction/0x1249ca9040fb4c1f02e99ee656823393b223bf9f2bcba9d2a6cdb36344e1989b)); Settle contracts deployed on a second, rotated Channel and a Connector bonded ([order book](https://hashscan.io/testnet/contract/0x28c14e4BAd929e27902149674CCe79b34E5b8B1f), [record](../../deployments/README.md)); the Sepolia source opens 2026-10-06 07:22 UTC |

**The engineering finding.** Opening the Hedera half of the Channel with `EthMainnetVerifier`'s 512-key config failed
five times with `INSUFFICIENT_GAS`, always at 4,062,470 gas used, at gas limits from 5.6M to 15M. The cause is
Hedera's per-transaction contract trace cap (`contracts.maxSerializedTraceDataBytes`, 262,144 B): the 67 KB config is
recorded in three call frames, plus 257 `BLS12_G1ADD` precompile calls, about 302 KB raw. `eth_estimateGas` and anvil
forks do not apply the cap. A staged adapter (16 chunks of 32 keys, then the Channel opened with 16 chunk roots,
same trust anchor as `EthMainnetVerifier`, parity-tested) opened it at 4.5 % of the cap. Full note with reproduction:
[hedera-trace-cap.md](hedera-trace-cap.md).

## 3. Three upstream contributions we propose

**(a) Staged sync-committee configuration and rotation for the ETH verifier on Hedera.** Today a Hedera Channel over
`EthMainnetVerifier` can be opened only through an adapter, and it cannot follow a sync-committee rotation (the
rotation bundle carries the next 512 keys through the same frames), so it stops at the end of its period (about
27 hours on Sepolia). We propose a staging entry point on the verifier (`stageChunk`: on-curve check, record the
chunk's `ClprCommitteeMerkle` subtree root), a `verifyConfig` shape that names staged chunk roots, and a two-step
rotation that references a staged record instead of carrying the keys. We bring the adapter, its parity tests, the
trace-size tool, and live testnet evidence. Proposal: [clpr-staged-eth-committee.md](../proposals/clpr-staged-eth-committee.md).

**(b) A receive-only (one-way) Channel mode, or queue-depth handling for chain → Hedera-only applications.** The
reference Service counts a Channel's outbound messages until the peer acknowledges them
(`nextMessageId - ackedMessageId - 1`) and stops sending at `maxQueueDepth`, and per Connector at
`connectorQueueQuotaPct` of it. Acknowledgements need proofs in the opposite direction. Settle on Hedera only ever
needs chain → Hedera, but until a Hedera → chain verifier exists a chain-side Settle contract can send only that many
messages over its Channel (500 with our testnet throttles: depth 1,000, quota 50 %). Options we would like to discuss:
a Channel flag that marks one direction receive-only and exempts it from the unacknowledged-depth limit, or an
acknowledgement path that does not require the reverse proof. We can contribute the change, tests and the Settle
e2e as a consumer.

**(c) CLPRouter and Settle on Hedera as an LFDT lab or reference application.** A worked example of building on CLPR
without protocol changes: multi-hop routing, receipts and refunds, a compliance-filter registry with a narrow,
contract-enforced provider role, and a bonded settlement pattern. It already exercises the reference Service in
three-ledger tests, in a Solo round trip and on public testnets, so it can double as an integration test bed for
CLPR releases (for example a nightly job against CLPR `main`). Licence: MIT (CLPR stays Apache-2.0); DCO sign-off is
already required. We would follow whatever lab process and licence LFDT prefers.

## 4. Questions for the CLPR maintainers

1. Is staged verifier input (a) a direction you would accept in the CLPR repo, and should it be generic (any verifier
   with large trusted inputs) or specific to `EthMainnetVerifier`?
2. Is a receive-only Channel direction (b) consistent with CLPR's design, or is there a preferred way to bound
   unacknowledged messages for one-way applications?
3. What is the expected Hiero state-proof source for Hiero → chain verification (block-node `getStateProof` for EVM
   storage slots), and is there a timeline or a test endpoint we could build against?
4. Will the reference Solidity Service ever allow `sendMessage` during application delivery? Today each intermediate
   hop takes a second, permissionless transaction because one reentrancy lock covers both.
5. Would you like a trace-size check in CLPR's Hiero e2e runs, and a documented per-transaction trace budget for
   verifier authors?
6. What is the process for an LFDT lab or sample application (c), and who should sponsor it?

## 5. Demo script (10 minutes)

**Before the meeting:** `forge build`; run `script/settle-e2e/run.sh` once and keep its output; start the trace
reproduction's anvil fork ([steps](hedera-trace-cap.md#2-replay-it-on-a-fork-and-measure-the-trace)) and keep
`FORK_TX` ready; open the tabs below.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–1:00 | [README](../../README.md), "What works today" table | An application on CLPR, no protocol change. Pairwise Channels become a network. |
| 1:00–2:30 | Same addresses on both chains: registry on [Etherscan](https://sepolia.etherscan.io/address/0x6D8a65a9E85C423ACe3E0C4074508a9AcD63958c) and [HashScan](https://hashscan.io/testnet/contract/0.0.10806966); Routers at their canonical addresses ([Sepolia](https://sepolia.etherscan.io/address/0x3Ec8a28f6AD20FE1070819f56B29be120700A653), [Hedera](https://hashscan.io/testnet/contract/0.0.10806974)) | Canonical CREATE2: every hop refuses non-canonical Routers. Immutable, no admin key. Provider powers diagram. |
| 2:30–4:30 | Failed `completeChannel` at [5.6M](https://hashscan.io/testnet/transaction/0x6f0285ff22c877035165e025a01350fc7077fffe8bbb2a0f9d7fbebaed99781e) and [15M](https://hashscan.io/testnet/transaction/0x7dc546cdba0c66c0c0a5bb18014c60786071c69045489a4a2e8256826542cdf3) gas limits; run `node script/deploy/trace-size.mjs $RPC $FORK_TX` | Same 4,062,470 gas used at every limit; the fork replay shows 301,836 B raw trace, 126 % of the cap. Not gas. |
| 4:30–6:00 | A [`stageChunk`](https://hashscan.io/testnet/transaction/0xdf341d4864af1506c95e52dde2aeb9659b9c06fc61e716b0d8be3cd0cb102ccd), then [`completeChannel`](https://hashscan.io/testnet/transaction/0x285565114acef4b37592e9ac115460bbfcabd547936e44fd515ed9919132a3d9); `forge test --match-path test/unit/StagedEthConfigVerifier.t.sol` | Same trust anchor as `EthMainnetVerifier`, bundles still verified by it. Proposal (a). |
| 6:00–7:30 | [`send` on Sepolia](https://sepolia.etherscan.io/tx/0x8a08f19922f6a265f2900b218db01510c4dc21e50ed80b68ae8756faddff0d6c) → [`submitBundle` on Hedera](https://hashscan.io/testnet/transaction/0x1249ca9040fb4c1f02e99ee656823393b223bf9f2bcba9d2a6cdb36344e1989b) (logs: destination app, Router, Service) → [receipt `flush`](https://hashscan.io/testnet/transaction/0xc843d6d4f6199b934fdf221a9192a69df015d1ada9d5c6b847dde61c37d4a7bb) | Delivered on Hedera at 46 % of the trace cap. The receipt waits for a Hiero proof source (question 3). |
| 7:30–9:00 | [Order book](https://hashscan.io/testnet/contract/0x28c14e4BAd929e27902149674CCe79b34E5b8B1f), [bond](https://hashscan.io/testnet/transaction/0xbd0e8d3d4d4ecd304b1fdf0ee233b75876a77238e401cc4aad7f92bc15f03334), the [demo's testnet page](https://clprouter-demo.doyoka-platform.workers.dev); the saved `settle-e2e` output (four scenarios, trace estimates) | Chain → Hedera only; why a receive-only Channel matters. Proposal (b). |
| 9:00–10:00 | This page, sections 3 and 4 | Proposals (a)–(c) and the six questions. |

Honest limits to state if asked: testnet only; internal reviews only; the Sepolia side of the testnet Channel uses a
test-only stub verifier (no Hiero proof source yet), so the route's origin stays pending until `reclaim`; no real
Settle order has run yet (the first live orders are scheduled for the 2026-10-06 07:22–13:53 UTC window).
