# Audit-readiness pack

What an external audit of CLPRouter `0.1.0` covers, the properties the code must keep, what is already known, and
how well the tests reach the code. Auditors' own working files live in `docs/audit/` and `test/security/`.

## 1. Scope

### 1.1 In scope

| File | Lines | Runtime size | Role |
| --- | --- | --- | --- |
| `src/ClprRouter.sol` | 819 | 24,477 B | Send, hop processing, delivery, receipts, settlement, pumping |
| `src/ProviderRegistry.sol` | 532 | 12,300 B | Committee decisions: certify, trust tier, disable, blacklist, committee, contact |
| `src/QuarantineVault.sol` | 195 | 5,593 B | Diverted funds, recovery naming, challenges, releases |
| `src/libraries/RouteCodec.sol` | 453 | 9,837 B | Protobuf codec for `ClprRouteEnvelope` and `ClprRouteReceipt` (external library) |
| `src/libraries/RouteLogic.sol` | 362 | 13,062 B | Structure, safety, filters, trust floor, splice, receipts, commitments (external library) |
| `src/libraries/RouteTypes.sol` | 132 | — | Types and constants |
| `src/libraries/Caip.sol` | 62 | — | CAIP-10 ids and registry keys |
| `src/interfaces/*.sol` | 115 | — | `IClprRouteApplication`, `IClprRouteSender`, `IProviderRegistry`, `IQuarantineVault` |
| `proto/clprouter/v1/route_envelope.proto` | — | — | Wire format the codec implements |

Compiler: solc 0.8.30, `via_ir = true`, `evm_version = "osaka"`, optimizer 2,000 runs (200 for `ClprRouter.sol`),
`bytecode_hash = "none"`, no CBOR metadata (`foundry.toml`).

### 1.2 Secondary scope (off-chain, cannot move funds)

| Path | Why it matters |
| --- | --- |
| `sdk/src/envelope.ts`, `sdk/src/proto.ts` | Must produce the same bytes as `RouteCodec` (cross-checked by `test/unit/RouteCodecVectors.t.sol` and `sdk/test/vectors.test.ts`) |
| `sdk/src/iso20022/` | Encryption, commitments and personal-data checks under the ISO 20022 filter |
| `services/src/trigger.ts`, `services/src/config.ts` | Key handling and the local-RPC restriction |

### 1.3 Out of scope

- `lib/clpr-smart-contracts` (the CLPR reference contracts, unchanged; their own audits apply). CLPRouter relies on
  one behaviour of the reference `ClprService`: `sendMessage` reverts with `ReentrancyGuardReentrantCall()` during
  `submitBundle` delivery.
- `test/`, `script/`, `registry-data/` tooling.

## 2. Invariants

Each invariant lists the example-based tests in `test/unit/` that exercise it. The auditors' stateful invariant
suites in `test/security/` (`RouterInvariants.t.sol`: escrow conservation, Router solvency, settle at most once,
receipts only from the stored commitment; `RegistryVaultInvariants.t.sol`: version counts decisions, quorum, vault
balance conservation, release rules, committee shape) cover RT-2, RT-3, RT-4, RT-15, PR-1, PR-3, PR-7, QV-3 and QV-4
as fuzzed properties.

### 2.1 ClprRouter

| # | Invariant | Tests |
| --- | --- | --- |
| RT-1 | A route id is accepted at most once per Router, as origin or as hop (`DuplicateRouteId`, `RouteReplayed`) | `test_replay_reverts`, `test_send_revertsOnDuplicateRouteId` |
| RT-2 | An origin route settles at most once; status moves `PENDING` → one terminal status and never back | `test_reclaim_onlyAfterDeadlinePlusGrace_thenLateReceiptIgnored`, forged-receipt tests |
| RT-3 | Value conservation at settlement: fees paid + payee + refund + vault deposit = escrow + fee budget (pushes that fail go to `owed`) | `test_delivers_A_B_C_andSettlesEscrowAndFees`, `test_receiptFromIntermediateHop_rebuildsPrefixAndPaysItsFee` |
| RT-4 | The Router's balance covers escrow and budget of every `PENDING` route plus all `owed` | `invariant_routerSolvent` (`test/security/`) |
| RT-5 | Fees paid ≤ fee budget, and only to hops before the reporting hop | `test_feeBudgetExhausted_failureReceipt`, `test_send_revertsWhenFeesExceedBudget`, `test_send_revertsWhenFeesExceedMaxFee` |
| RT-6 | Loose routes carry no value (`msg.value == 0`, no fee budget in the envelope) | `test_send_looseRoutesCarryNoValue`, `test_looseEnvelopeWithFeeBudget_reverts`, `test_send_valueRoutesMustBeStrict` |
| RT-7 | No ledger twice; at most `min(max_hops, 8)` edges | `test_send_revertsOnLoop`, `test_loopInEnvelope_reverts`, `test_send_revertsOnTooManyHops`, `test_tooManyHopsInEnvelope_reverts` |
| RT-8 | A hop processes an envelope only if addressed to it, from the named previous Router over the named Channel whose peer is the named ledger, at its own `VERSION` | `test_wrongSenderRouter_reverts`, `test_wrongInboundChannel_reverts`, `test_previousLedgerMislabelled_reverts`, `test_notAddressedToThisRouter_reverts`, `test_wrongRouterVersion_reverts`, `test_inbound_onlyService` |
| RT-9 | A pending or rejected hop completes only with the exact recorded envelope, and every check runs again | `test_forward_rejectsUnknownEnvelope`, `test_pumpedHop_recheckedAfterDeadline`, `test_flush_rejectsUnknownEntry` |
| RT-10 | A permissionless `forward` with too little gas changes nothing; inside delivery the hop stays pending | `test_forward_belowMinSendGas_revertsAndKeepsHopPending`, `test_forward_outOfGasInsideSend_revertsAndKeepsHopPending`, `test_delivery_outOfGasInsideSend_defers` |
| RT-11 | Nothing is forwarded over, or out of a message that arrived over, a disabled edge, ledger, Router deployment or version | `test_disabled*` (10 tests), `test_messageOverDisabledInboundEdge_isNotForwarded` |
| RT-12 | With a blacklisted sender, recipient or payee, no value leaves the origin except into the vault; a listing added before settlement still catches a `DELIVERED` route | `test_blacklisted*`, `test_blacklistAddedBeforeReceipt_lateCatchAtOrigin` |
| RT-13 | Filters are checked at the pinned registry version; a registry behind the pin fails closed; unfiltered routes never read certifications | `test_filter*` (7 tests) |
| RT-14 | A trust floor above 0 fails closed on an unlabelled or lower-labelled edge; floor 0 never reads labels | `test_trustFloor_*` (10 tests) |
| RT-15 | Strict-route receipts are accepted only from the first-hop Router over the first Channel, with the stored hop-list commitment, along the exact reverse path; `DELIVERED` only from the destination | `test_forgedReceipt_*` (4 tests) |
| RT-16 | Receipts never trigger receipts | `test_receiptOverDisabledEdge_isDropped`, `test_receiptInTransit_isForwardedTowardsOrigin` |
| RT-17 | `onClprMessage` reverts only for malformed, misaddressed, unauthenticated or replayed envelopes; every other outcome returns normally | `test_malformedEnvelope_reverts`, `test_destinationAppReverts_failureReceiptRefundsEscrow` |
| RT-18 | The destination never delivers after the deadline | `test_deadlinePassesBeforeDestination_expiryReceipt` |

### 2.2 ProviderRegistry

| # | Invariant | Tests |
| --- | --- | --- |
| PR-1 | `version` increases by exactly 1 per applied decision, and only with `nonce == version + 1` | `test_submit_outOfOrderNonce`, `test_reenable_whenNotDisabled_isNoOpButAdvancesVersion` |
| PR-2 | A decision digest applies at most once | `test_submit_replayRejected` |
| PR-3 | A decision applies only with the required number of distinct, sorted, current-epoch member signatures (k + 1 for `DISABLE`, `BLACKLIST`) | `test_submit_insufficientSigners`, `test_disableAndBlacklist_needKPlusOne`, `test_submit_duplicateSignerRejected`, `test_submit_nonMemberSigner`, `test_submit_badSignature` |
| PR-4 | `certificationAt(key, v)` depends only on entries appended at versions ≤ v, and is false while `version < v` | `test_versionPinning_oldVersionStaysReadable`, `test_filter_registryBehindPinnedVersion_failsClosed` |
| PR-5 | Certifications take effect after the notice and expire within 366 days | `test_certify_takesEffectAfterNotice`, `test_certify_expires`, `test_certify_rejectsExpiryBeyondOneYearOrBeforeEffect` |
| PR-6 | Disables and listings take effect at once and lapse unless renewed; re-enables wait for the notice | `test_disable_immediate_lapses_renewable`, `test_blacklist_lapsesAfterThirtyDays`, `test_reenable_afterNotice` |
| PR-7 | Committee: `k ≥ 1`, `k + 1 ≤ n`, sorted members; a change bumps the epoch and invalidates the old epoch's signatures | `test_constructor_rejectsBadCommittee`, `test_committeeChange_signedByCurrentCommittee_bumpsEpoch` |
| PR-8 | `isProviderAccount` is monotone: once a member, always a provider account | `test_recovery_neverToProviderAccounts` |
| PR-9 | Vault actions are never accepted by `submit` | `test_submit_vaultActionsAreNotAcceptedHere`, `test_vaultNameRecoveryStillNotAcceptedHere` |
| PR-10 | The same signed decision produces the same state on every ledger | `test_sameDecisionAppliesOnEveryLedger` |

### 2.3 QuarantineVault

| # | Invariant | Tests |
| --- | --- | --- |
| QV-1 | Every deposit has a case id and value | `test_deposit_requiresCaseAndFunds` |
| QV-2 | A deposit is released at most once, in full | `test_release_onlyOnce` |
| QV-3 | The beneficiary is the deposit's sender, its recipient, or the case's unchallenged recovery address after `releasableAt`; never zero, the vault, the registry or a provider account | `test_release_toOriginalSender`, `test_release_toOriginalRecipient_falsePositive`, `test_recovery_*` (5 tests), `test_release_neverToProviderEvenIfOriginalParty` |
| QV-4 | The vault balance equals the sum of unreleased deposits (absent forced ether) | `invariant_vaultBalanceConservation` (`test/security/`) |

### 2.4 Codec

| # | Invariant | Tests |
| --- | --- | --- |
| CD-1 | `decode(encode(e)) == e` for envelopes and receipts | `testFuzz_envelope_roundTrip`, `test_envelope_roundTrip`, `test_receipt_roundTrip` |
| CD-2 | Decoding never panics; malformed input reverts with a codec error | `testFuzz_decode_neverPanics`, `test_decode_rejects*` (5 tests) |
| CD-3 | Solidity and SDK produce identical bytes | `test_vectors_matchCommittedFixture`, `test_vectors_roundTripInSolidity`, `sdk/test/vectors.test.ts` |

## 3. Known issues

From the [threat model](threat-model.md), section 7. Findings of the review already under way are in `docs/audit/`
(`router-findings.md`: H-01, H-02, M-01 to M-05, L-01 to L-03; `registry-vault-findings.md`: RV-01 to RV-10) and are
tracked there; the last column names the related finding where the two overlap or share an outcome.

| Id | Severity | Summary | Related audit finding |
| --- | --- | --- | --- |
| R1 | Medium | Each intermediate hop and receipt needs a second, unpaid, permissionless transaction on the reference CLPR Service | M-02 |
| R2 | Medium | k committee signatures can name a fresh recovery address and release a deposit to it if no party challenges in time | RV-01, RV-08 |
| R3 | Medium | A blacklisted sender can block recovery to a third-party victim by challenging every naming | RV-09 |
| R4 | Medium | A `DELIVERED` receipt arriving after `reclaim` is ignored: the sender is refunded although the destination acted | H-01 |
| R5 | Medium | After a NACK on a loose route, any caller picks the new tail's Routers; `origin_signature` is neither checked on-chain nor passed to the application | M-03 |
| R6 | High (live use) | No Hiero state-proof source: Hiero → chain legs run with a non-verifying stub in e2e; not deployable live | — |
| R7 | Low | A decision lands on each ledger only when relayed | RV-03 |
| R8 | Low | Re-signing a nonce with different content would fork registry state (procedural control) | RV-02 |
| R9 | Low | `MIN_SEND_GAS` and `APP_GAS` are immutable per deployment | — |
| R10 | Low | Vault decisions carry no ledger id; a release can be relayed to another vault with the same deposit id and case | RV-04 |
| R11 | Low | `ClprRouter` has 99 B of EIP-170 margin | — |
| R12 | Low | Payloads without the ISO 20022 / MiCA filters are plaintext on every ledger crossed | — |

Also known, not security issues:

- The README "Open issues" says the trust floor is enforced only by the planner. The Router now enforces a floor above
  0 against `TRUST_TIER` labels (`_checkNext`, `RouteLogic.edgeTrusted`); the default floor is 0.
- Three Router tests assert exact gas behaviour and fail under `forge coverage` instrumentation (section 4).
- The ISO 20022 screening hook named in the spec is not implemented in phase 1.

## 4. Test coverage

### 4.1 Counts

Measured on commit `271188d` (1 October 2026):

| Suite | Command | Tests |
| --- | --- | --- |
| Foundry (unit and in-process three-ledger integration) | `forge test` | 179 in 7 suites (2 fuzz tests, 256 runs each by default) |
| SDK | `cd sdk && pnpm test` | 207 in 12 files |
| Services (unit) | `cd services && pnpm run test:unit` | 43 in 6 files |
| Services (integration, one anvil) | `cd services && pnpm run test:integration` | 1 file; needs `anvil` and `forge build` |
| End-to-end | `script/e2e/run.sh` | 5 routes over three anvil chains (nightly in CI) |
| End-to-end through Hiero | `script/e2e-hiero/run.sh` | 1 round trip A → H → B → H → A on Solo (manual) |

### 4.2 Line and branch coverage

`forge coverage --ir-minimum`, excluding the three gas-calibrated tests (`belowMinSendGas`, `outOfGasInsideSend`,
`definiteServiceRevert`), with the `ClprRouter.sol` compilation restriction removed so coverage can map its source
(the CI `coverage` job does the same). Same commit:

| File | Lines | Statements | Branches | Functions |
| --- | --- | --- | --- | --- |
| `src/ClprRouter.sol` | 96.05% (316/329) | 95.24% (400/420) | 87.63% (85/97) | 96.00% (24/25) |
| `src/ProviderRegistry.sol` | 91.57% (163/178) | 94.07% (254/270) | 93.62% (44/47) | 75.00% (21/28) |
| `src/QuarantineVault.sol` | 100.00% (59/59) | 96.59% (85/88) | 85.00% (17/20) | 100.00% (7/7) |
| `src/libraries/Caip.sol` | 100.00% (28/28) | 100.00% (32/32) | — (0/0) | 100.00% (8/8) |
| `src/libraries/RouteCodec.sol` | 95.16% (236/248) | 94.79% (309/326) | 94.35% (117/124) | 100.00% (32/32) |
| `src/libraries/RouteLogic.sol` | 98.88% (177/179) | 97.96% (288/294) | 90.48% (38/42) | 100.00% (17/17) |
| **`src/` total** | **95.89% (979/1021)** | **95.66% (1368/1430)** | **91.21% (301/330)** | **93.16% (109/117)** |

The ProviderRegistry functions not reached are mostly the public key helpers (`edgeKey`, `ledgerKey`, `routerKey`,
`routerVersionKey`, `accountKey`, `certKey`) and views used only off-chain.

Reproduce:

```sh
sed -i.bak -e '/^additional_compiler_profiles/d' -e '/^compilation_restrictions/d' foundry.toml
forge coverage --ir-minimum --no-match-test 'belowMinSendGas|outOfGasInsideSend|definiteServiceRevert' --report summary
mv foundry.toml.bak foundry.toml
```

### 4.3 CI

`.github/workflows/ci.yml` runs on every push and pull request: `forge fmt --check`, `forge build --sizes` (fails
over EIP-170), `forge test`, a fuzz profile (all tests, `FOUNDRY_FUZZ_RUNS=10000`), an invariant profile
(`invariant_*` tests, 512 runs × depth 64), coverage, slither (non-blocking, SARIF to code
scanning), SDK and services typecheck, lint and tests, and the services integration test. The three-anvil e2e runs
nightly (`nightly-e2e.yml`). Dependencies are audited weekly (`dependency-audit.yml`), TypeScript is scanned by CodeQL
(`codeql.yml`).

## 5. Gaps an audit should know about

1. **Invariant coverage is new.** The stateful suites in `test/security/` arrived with the review; PR-4 (version
   pinning) and RT-12 (blacklist reaches every exit) have no invariant handler yet. The coverage figures in section 4
   predate those suites.
2. **No differential fuzzing** of the SDK codec against `RouteCodec` beyond the committed vectors.
3. **The reentrancy-lock dependency** (R1) is tested against the reference Service and a mock that allows sends during
   delivery; no other CLPR Service implementation exists to test against.
4. **No live-network run.** All e2e runs use `E2EVerifier` (R6).
5. **Slither findings** are reported but not yet triaged into a baseline file.

## 6. Build and reproduce

```sh
git clone <repo> && cd clprouter && git checkout v0.1.0
git submodule update --init --recursive
forge build --sizes --skip 'test/**' --skip 'script/**'
forge test
(cd sdk && pnpm install --frozen-lockfile && pnpm test)
(cd services && pnpm install --frozen-lockfile && pnpm run test:unit)
```

Release artefacts (`clprouter-contracts-<version>.tar.gz`) contain the ABIs, the full artefacts, `build-info/`, the
sizes table, the proto schema and the exact CLPR submodule commit, with a SLSA provenance attestation
(`gh attestation verify`).
