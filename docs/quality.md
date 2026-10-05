# Engineering quality

Measured on 2026-10-05 at the commit that adds this file (Foundry v1.5.1, solc 0.8.30, halmos 0.3.3,
slither 0.11.6, Node 22). Every number here can be reproduced with the `make` target named next to it.

## At a glance

These are the values the README badges use.

| Badge | Value | Source |
| --- | --- | --- |
| tests | **772 passing** (384 contracts, 213 SDK, 175 services) | `make test-contracts`, `make test-sdk`, `cd services && pnpm test` |
| symbolic proofs | **16 halmos properties proven** | `make halmos` |
| coverage | **96.1% lines** (96.2% statements, 85.7% branches, 96.6% functions) | `make coverage` |
| fuzz | **16 fuzz tests × 10,000 runs, 15 invariants × 10,000 runs**, 0 failures | see [Fuzzing and invariants](#fuzzing-and-invariants) |
| static analysis | slither: 0 open issues (168 results, all triaged below) | `make slither` |
| dependency audit | 0 known advisories in CLPRouter's lockfiles (OSV-Scanner, pnpm audit) | `.github/workflows/dependency-audit.yml` |

Badge data, for shields.io endpoints or static badges:

```json
{
  "tests": 772,
  "contractTests": 379,
  "sdkTests": 213,
  "servicesTests": 175,
  "coverageLines": "96.1%",
  "coverageStatements": "96.2%",
  "coverageBranches": "85.7%",
  "coverageFunctions": "96.6%",
  "fuzzRuns": 10000,
  "invariantRuns": 10000,
  "halmosProofs": 16
}
```

## Tests

| Suite | Tests | Command |
| --- | --- | --- |
| Contracts: unit, fuzz, invariant, security regression (25 suites) | 384 | `forge test --skip 'script/**'` (about 3 min on an M-series laptop) |
| SDK: planner, envelope, ISO 20022, route data | 213 | `cd sdk && pnpm test` |
| SDK package: pack, install into a scratch project, import every entry point, type-check a consumer | 1 check | `cd sdk && pnpm run test:pack` |
| Services: unit (170) and integration on anvil (5) | 175 | `cd services && pnpm test` |
| End to end: three anvil chains, 5 scenarios, 42 transactions | 5 scenarios | `make demo` (about 13 min including the Channel approvals; `make demo-docker` with only Docker) |

## Formal guarantees (halmos)

Symbolic tests live in [`test/halmos/`](../test/halmos). halmos executes the real contract bytecode with symbolic
inputs and asks an SMT solver whether any input can break the assertion, so a passing `check_*` is a proof for
**every** input within the stated bounds, not a sample. They are named `check_*` so `forge test` skips them; run
them with `make halmos` (foundry profile `halmos`, own `out-halmos/` directory). CI runs them in the `halmos` job. All 16 pass; the whole run takes 2 min 20 s including compilation.

Common modelling choices:

- **Signatures**: halmos treats ECDSA recovery as an uninterpreted function, so the proofs cover every signature
  byte string and every signer address recovery could return, including committee members.
- **Symbolic storage**: where noted, the contract's whole storage is symbolic (`svm.enableSymbolicStorage`), so
  the property holds from every state, not only states reachable in a test.
- **Composition**: the vault's release logic is proven against a registry stand-in that approves every decision
  (so it holds even if a quorum signs a bad decision), and quorum enforcement is proven separately against the
  real registry. Same for settlement: the real `RouteSettlement` library runs by DELEGATECALL from a harness with
  the Router's storage layout, against a blacklist stand-in with symbolic answers.

| # | Contract | Property | Proof | Bounds / assumptions | Time |
| --- | --- | --- | --- | --- | --- |
| 1 | ProviderRegistry | Quorum table: disable, blacklist, delist, recovery naming and Router binding need exactly **k + 1**; a committee change max(k + 1, ⌈2n/3⌉); everything else **k**. Every quorum is a strict majority (no two disjoint quorums) and at most n | `check_requiredSignatures_matchesRules` | every committee shape the constructor accepts for n = 3..7, every k, every action id | 11 s |
| 2 | ProviderRegistry | The constructor rejects every committee outside n ≥ 3, k ≥ 2, k > n/2, k + 1 ≤ n | `check_constructor_rejectsWeakCommittees` | n = 0..7, every k | <1 s |
| 3 | ProviderRegistry | `checkApproval` accepts a signature set only if it has at least `required` signatures whose signers are members of the epoch, strictly ascending (pairwise distinct) | `check_checkApproval_needsDistinctMembers` | 4 members; 0 to 3 signatures; any digest, any `required` | 23 s |
| 4 | ProviderRegistry | A decision with fewer signatures than its action's quorum is always rejected and changes nothing, whatever the action, payload, evidence and timing | `check_submit_rejectsBelowQuorum` | 4 members, k = 3; 0 to 3 signatures | 44 s |
| 5 | QuarantineVault | From any vault state, a successful release pays exactly the deposit's amount, **never to a committee member (past, present or scheduled), the registry or the vault**, and marks the deposit released | `check_release_neverPaysProviderAndPaysOnce` | symbolic storage; every beneficiary kind (sender, recipient, recovery, recovery over a challenge); any time | 3 s |
| 6 | QuarantineVault | A released deposit can never be released again | `check_release_releasedDepositIsFinal` | symbolic storage | <1 s |
| 7 | QuarantineVault | Each vault decision is checked against the right quorum: release k, release over a challenge the supermajority, recovery naming and Router binding k + 1 | `check_vaultDecisions_askRightQuorum` | symbolic storage; with 3 and 4, nothing moves below quorum | <1 s |
| 8 | QuarantineVault | A recovery address can never be a committee member, the registry, the vault or zero, even with every signature approved | `check_nameRecovery_rejectsForbiddenBeneficiaries` | 4 members | <1 s |
| 9 | QuarantineVault | Deposits: only the bound Router once bound, never without a case or value; the balance grows by exactly the deposit | `check_deposit_accounting` | symbolic storage, symbolic caller and value | <1 s |
| 10 | ClprRouter (RouteSettlement) | **Escrow conservation**: escrow + fee budget = hop fees + paid to payee + refunded to sender + quarantined, exactly; failed pushes are credited to `owed`; other routes' funds do not move; hop fees ≤ budget; the payee is paid only for DELIVERED, the vault only for QUARANTINED (including a late blacklist turning a delivery into quarantine), the sender otherwise | `check_finish_conservesEscrow` | escrow < 2^128, any budget and hop fees, every terminal status, any blacklist answer, payee that accepts or rejects payment; 2 forwarded hops | 64 s |
| 11 | ClprRouter (RouteSettlement) | **No double settlement**: a route that is not PENDING is never settled or refunded again (reclaim reverts, nothing moves) | `check_reclaim_onlyPending` | every non-pending status, any reclaim time, any held count | <1 s |
| 12 | ClprRouter (RouteSettlement) | **No double refund**: the two-phase reclaim refunds escrow + whole budget to the sender exactly once, never before deadline + grace × edges, never while a receipt is held, and the third call reverts | `check_reclaim_refundsOnce` | timestamps < 2^40 s | <1 s |
| 13 | SettleOrderBook | **Bond accounting, inductive**: from any state with reserved + pendingWithdraw ≤ total (free bond never negative) and an open order's reservation inside its Connector's, every bond and order operation (post, request / cancel / execute withdrawal, default, cancel) keeps it; HBAR moves exactly with `total` + `totalOwed`; a default or cancel pays the user exactly the order's reservation, which is ≤ cover + penalty | `check_bondAccounting_inductive` | symbolic storage, any penalty ≤ 50%, any caller amounts | 7 s |
| 14 | SettleOrderBook | **No double payout**: once an order is not OPEN, both default and cancel revert and nothing moves | `check_noDoublePayout` | symbolic storage, any caller | <1 s |
| 15 | ProviderRegistry | **Hand-over quorum**: once a scheduled committee's notice has passed, `requiredSignatures` is at least max(k + 1, ⌈2n/3⌉) for every action (the vault uses it for its own decisions); before it, the quorum table of proof 1 | `check_requiredSignatures_supermajorityAfterNotice` | every committee shape for n = 3..7, every k, every action id, any take-over time before or after now | 15 s |
| 16 | QuarantineVault | **Recovery window per deposit**: from any vault state, a release to the recovery address (with or without a challenge override) happens only once `RECOVERY_NOTICE + CHALLENGE_WINDOW` have passed since the naming and since the deposit itself | `check_recoveryRelease_waitsForDepositWindow` | symbolic storage, any time | 2 s |

What is **not** proven symbolically, and how it is covered instead:

- Whole-Router flows (protobuf decoding of envelopes and receipts, the CLPR service, multi-hop forwarding) are too
  large for symbolic execution. They are covered by the router invariant suite (escrow conservation across many
  routes, solvency, settles at most once, receipts only from the stored commitment) and by
  `testFuzz_forgedReceiptNeverSettles`, plus the codec fuzzers below.
- That *only* the Router's guarded paths call `RouteSettlement.finish` (every call site checks PENDING, at
  `ClprRouter.sol` send, `_onSendResult` and in `settle` / `reclaim`) is by code inspection and the
  `invariant_settlesAtMostOnce` invariant; proof 11 and 12 cover the library entry points.
- Opening an order (`_open`: signature check, EIP-712 order id, `owedFor` = cover + penalty via `Math.mulDiv`,
  reservation from the bond) timed out under halmos (nonlinear 512-bit arithmetic and hashing). The reservation
  bound (reserved <= cover + penalty, free bond first) is covered by `testFuzz_reserveNeverExceedsBond`,
  `invariant_bondAccounting` and `invariant_payouts`; proof 13 starts from any state where an order's reservation
  is at most its cover + penalty and shows every later operation keeps the accounting.
- Registry decisions with a pending committee take-over are covered by unit tests and
  `invariant_decisionsOnlyWithQuorum`; proof 15 shows the quorum rule itself for every action.
- That Routers carry nothing over a Channel the registry does not approve is shown on the real Router by
  `invariant_onlyApprovedChannelsCarryMessages` and the `RouterTrustBoundary` tests, not symbolically.

## Fuzzing and invariants

Run locally on 2026-10-05 with a fixed seed (`FOUNDRY_FUZZ_SEED=0x2a`), all passing:

| Kind | Tests | Runs | Calls |
| --- | --- | --- | --- |
| Fuzz (`testFuzz_*`) | 16 | 10,000 each | 160,000 |
| Invariants: registry and vault (`RegistryVaultInvariants`) | 5 | 10,000 × depth 64 | 640,000 each |
| Invariants: router (`RouterInvariants`, origin Router against a Service stand-in) | 7 | 10,000 × depth 60 | 600,000 each |
| Invariants: settle on Hedera (`SettleInvariants`, fail on revert) | 3 | 10,000 × depth 60 | 600,000 each |

```sh
FOUNDRY_PROFILE=deep FOUNDRY_FUZZ_SEED=0x2a forge test --skip 'script/**' --match-test '^(testFuzz|invariant)'
```

The `deep` profile (`foundry.toml`) runs fuzz tests at 10,000 runs and invariants at 10,000 × 64; the router and
settle suites pin `runs = 64, depth = 60` for the default run in inline `forge-config` comments and carry matching
`deep.` lines (10,000 × 60). The whole deep run takes about 17 minutes on an M-series laptop, the router suite alone
about 8. CI runs every fuzz test at 10,000 runs and the invariants at 512 × 64 (`forge-fuzz` job, seed = run
number).

## Coverage

`make coverage` (CI: `coverage` job, which drops the ClprRouter size restriction in its throw-away checkout so the
Router's source maps are reported). Tests whose assertions depend on exact gas are excluded under instrumentation.

| File | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| src/ClprRouter.sol | 97.72% (257/263) | 97.55% (318/326) | 91.55% (65/71) | 100.00% (25/25) |
| src/ClprRouterDeployer.sol | 97.14% (34/35) | 98.36% (60/61) | 100.00% (5/5) | 100.00% (5/5) |
| src/ProviderRegistry.sol | 93.88% (230/245) | 95.96% (356/371) | 98.28% (57/58) | 80.56% (29/36) |
| src/QuarantineVault.sol | 100.00% (91/91) | 97.14% (136/140) | 88.24% (30/34) | 100.00% (10/10) |
| src/libraries/Caip.sol | 100.00% (28/28) | 100.00% (32/32) | 100.00% (0/0) | 100.00% (8/8) |
| src/libraries/RouteCodec.sol | 93.70% (223/238) | 93.79% (302/322) | 67.54% (77/114) | 100.00% (29/29) |
| src/libraries/RouteLogic.sol | 97.99% (244/249) | 96.64% (374/387) | 86.36% (57/66) | 100.00% (29/29) |
| src/libraries/RouteOrigin.sol | 64.29% (27/42) | 68.00% (34/50) | 44.44% (4/9) | 100.00% (2/2) |
| src/libraries/RouteReceipts.sol | 100.00% (16/16) | 96.00% (24/25) | 80.00% (4/5) | 100.00% (1/1) |
| src/libraries/RouteSettlement.sol | 98.61% (71/72) | 99.00% (99/100) | 100.00% (23/23) | 100.00% (6/6) |
| src/settle/SettleDelivery.sol | 100.00% (21/21) | 100.00% (27/27) | 85.71% (6/7) | 100.00% (2/2) |
| src/settle/SettleDeposit.sol | 100.00% (35/35) | 100.00% (56/56) | 93.33% (14/15) | 100.00% (3/3) |
| src/settle/SettleOrderBook.sol | 99.65% (286/287) | 98.74% (393/398) | 93.90% (77/82) | 100.00% (38/38) |
| src/settle/SettleTypes.sol | 84.85% (28/33) | 85.71% (30/35) | 100.00% (2/2) | 100.00% (11/11) |
| **Total** | **96.13% (1591/1655)** | **96.18% (2241/2330)** | **85.74% (421/491)** | **96.59% (198/205)** |

Notes: `RouteOrigin` is the origin-side send path that runs inside `ClprRouter.send` by DELEGATECALL; under
`--ir-minimum` part of its lines are attributed to the Router. `RouteCodec` branches are the protobuf decoder's
malformed-input paths, exercised by the codec fuzzers (decode-or-malformed on arbitrary and mutated bytes) rather
than by line-targeted tests. `ProviderRegistry` functions below 100% are view helpers (key builders) used off-chain.

## Gas

[`.gas-snapshot`](../.gas-snapshot) holds the gas of every unit test (348 entries; fuzz and invariant runs are
excluded because their gas depends on the inputs). CI fails when it drifts (`forge snapshot --check` in the
`forge` job). After an intended change: `make snapshot` and commit the file. Per-transaction gas of the end-to-end
scenarios is in the nightly e2e summary and in [technical reference](technical-reference.md).

Approved-Channel checks, as measured by `test_gasProfile_threeHopEscrowRoute` (one A → B → C route with escrow):
`send` +33,085 gas (1,924,390; both directions of both edges are checked), each inbound message +3,000 to +64,000
(the Channel's verifier is read from the Service and its label from the registry; largest for a receipt at an
intermediate hop: 1,111,417), settlement at the origin +18,371 (1,210,868); the whole route 10,420,341 gas, +1.2 %.

## Contract sizes

`forge build --sizes` (CI fails above the EIP-170 limit, 24,576 B). Libraries with public functions are deployed
separately and called by DELEGATECALL, so they do not count against the Router.

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
| --- | ---: | ---: | ---: |
| ClprRouter (optimizer runs 200) | 23,175 | 25,489 | 1,401 |
| ClprRouterDeployer | 4,234 | 4,979 | 20,342 |
| ProviderRegistry | 15,171 | 17,539 | 9,405 |
| QuarantineVault | 7,607 | 7,923 | 16,969 |
| RouteCodec (library) | 10,553 | 10,583 | 14,023 |
| RouteLogic (library) | 17,169 | 17,201 | 7,407 |
| RouteOrigin (library) | 7,045 | 7,077 | 17,531 |
| RouteReceipts (library) | 5,891 | 5,923 | 18,685 |
| RouteSettlement (library) | 8,410 | 8,442 | 16,166 |
| SettleOrderBook | 16,175 | 17,354 | 8,401 |
| SettleDeposit | 4,315 | 4,868 | 20,261 |
| SettleDelivery | 2,075 | 2,303 | 22,501 |

## Static analysis

### Slither

`make slither` (CI: `slither` job, results in code scanning) with [`.github/slither.config.json`](../.github/slither.config.json)
(`lib/`, `test/`, `script/` filtered). 168 results; none needs a code change. Triage:

| Detector | Count | Where | Triage |
| --- | ---: | --- | --- |
| arbitrary-send-eth (High) | 3 | `RouteSettlement.finish` → vault deposit; `SettleDelivery.deliver`; `SettleOrderBook._transferOut` | By design. The vault is an immutable of the Router, with code pinned by the deployer; `deliver` pays the recipient the caller names with the caller's own `msg.value`; `_transferOut` pays `msg.sender` its own withdrawal or owed balance. Proofs 10, 13 show the amounts are exactly the accounted ones. |
| reentrancy-no-eth (Medium) | 4 | `ClprRouter.onClprMessage`, `ClprRouter.requeue`, `SettleOrderBook.openByPayment` / `closeByPayment` | All four are `nonReentrant` (transient lock); `requeue` only reads the CLPR Service's Channel state before writing. The external calls are to the immutable CLPR service and to a payment prover that only the admin can add, behind `SOURCE_NOTICE`. |
| incorrect-equality (Medium) | 2 | `registeredAt == 0`, `emissionsUg == 0` | Sentinel checks on stored values, not on balances. |
| uninitialized-local (Medium) | 14 | accumulators and loop sentinels (`paid`, `last`, `ok`, …) | Zero is the intended initial value. |
| unused-return (Medium) | 6 | `ECDSA.tryRecover` third value; `vault.deposit` id; `channelApproval` tier in `RouteLogic.approved` / `inboundChannel` | The error enum is checked; the recovery's third value, the deposit id and (for an approval check) the tier are not needed. |
| write-after-write (Medium) | 1 | `ClprRouter._inDelivery` | A flag set around `_advance` and cleared after; both writes are needed. |
| calls-loop, reentrancy-benign, reentrancy-events (Low) | 29 | settlement pushes, vault deposit, registry reads (including Channel approvals per edge, at most 8), `requeue` | Pushes are gas-bounded (`PAY_GAS`, `PUSH_GAS`) with failures credited to `owed`; entry points hold the reentrancy lock. |
| timestamp (Low) | 26 | deadlines, notices, lapses, Channel labels, the hand-over quorum, per-deposit recovery time | Time windows are minutes to days; validator influence on `block.timestamp` is seconds. |
| missing-zero-check, shadowing-local (Low) | 7 | constructor and setter parameters | Zero values are rejected where they matter (`InvalidParameters`, `BadParams`, `ZeroSigner`); the remaining ones are admin addresses that may be zero by design (renounced). |
| Informational, optimization | 70 | naming (`DEPLOYMENT_ID`-style immutables, the deployer's pins, the vault's `REGISTRY` getter), assembly, low-level calls, cyclomatic complexity | Style; the assembly blocks are the bounded no-return-data pushes. |

### Aderyn

`npx @cyfrin/aderyn@0.6.8 . --src src` (88 detectors, 20 files, 3,385 nSLOC): 4 high-labelled and 17 low-labelled
detector groups. None needs a code change:

| Detector | Instances | Triage |
| --- | ---: | --- |
| H-1 `abi.encodePacked` hash collision | 5 | `Caip` registry keys: a fixed tag, then at most one variable-length field, except `routerKey(ledgerId, router)`, which separates its two variable-length fields with `:`. Keys only name subjects of committee decisions (disable a Router deployment); changing the derivation would change every deployed key, so it stays as is and is noted here for reviewers. |
| H-2 ETH transferred without address checks | 1 | `ClprRouter.withdraw` pays `msg.sender` its own `owed` balance. |
| H-3 state change after external call | 11 | Calls are to immutables (CLPR service, registry views) or a prover added by the admin behind a notice; every entry point holds the transient reentrancy lock; the vault marks a deposit released before paying (proof 5). |
| H-4 unsafe integer casts | 3 | `RouteCodec`: the varint reader bounds values to 64 bits before the cast; `bytes16(w)` truncates a word the decoder has length-checked to 16 bytes. Fuzzed (decode-or-malformed, encode-decode identity). |
| Low (17 groups) | 171 | Style and gas notes: literals instead of constants (95), public functions not used internally (20), PUSH0 (20; every target ledger is post-Shanghai, `evm_version = osaka`), floating `^0.8.28` pragmas (12, compiled with the pinned 0.8.30), and single-digit items mirrored in the slither table. |

## Dependency audit

`.github/workflows/dependency-audit.yml`, weekly and on lockfile changes:

- **Blocking**: `pnpm audit --prod --audit-level high` for `sdk` and `services`, and OSV-Scanner on CLPRouter's own
  lockfiles (`sdk/pnpm-lock.yaml`, `services/pnpm-lock.yaml`, `script/deploy/package-lock.json`): 0 advisories.
- **Report only**: OSV-Scanner on the pinned upstream CLPR submodule (`lib/clpr-smart-contracts`), whose
  JavaScript tooling CLPRouter never installs or ships; results go to code scanning under their own category.

The 2026-10-03 failure came from scanning the submodule's lockfile as if it were ours, plus real advisories in the
testnet relay tooling (`script/deploy`: the old `@hashgraph/sdk` name pinned outdated gRPC and protobuf packages)
and in a dev-only load-test dependency of the services (`uuid` via `autocannon`). The relay tooling now uses the
maintained `@hiero-ledger/sdk` with npm overrides, and the services pin `uuid` ≥ 11.1.1 through a pnpm override.
