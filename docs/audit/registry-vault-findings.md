# Security review: ProviderRegistry and QuarantineVault

Scope: `src/ProviderRegistry.sol`, `src/QuarantineVault.sol`, and how `src/ClprRouter.sol` /
`src/libraries/RouteLogic.sol` read and call them. Commit reviewed: `271188d`.
Tests: `test/security/registry/` (run with `forge test --match-path 'test/security/registry/*'`).

Every finding has a demonstrating test named `test_RVxx_*`. Each one passes while the issue is present.
Once a finding is fixed, change its test to expect the revert, or delete it. Properties that were
checked and hold are pinned by `test_ok_*`, the fuzz tests and the invariants.

| ID | Severity | Title |
|----|----------|-------|
| RV-01 | High | k signatures rotate the committee immediately, which bypasses every k+1 rule and every bound on what compromised keys can do |
| RV-02 | High | Nonce equivocation: two decisions with the same nonce split ledgers, and leaked keys can win the race against a rotation |
| RV-03 | Medium | A decision that applies on one ledger can revert on another, and that ledger then halts for good |
| RV-04 | Medium | The digest binds no deployment, so registry and vault decisions replay across registries and vaults |
| RV-05 | Low | DELIST (k, immediate) undoes a BLACKLIST that needed k+1 |
| RV-06 | Low | A far-future CERTIFY delays every later UNCERTIFY of that key, and an extreme `effectiveAt` bricks it |
| RV-07 | Info | Notice periods, lapses and vault windows are not validated |
| RV-08 | Medium | Naming the same recovery address again wipes a challenge |
| RV-09 | Medium | Anyone joins a case for 1 wei and can then veto every recovery, so some deposits lock forever |
| RV-10 | Info | The vault ignores `effectiveAt`, and the vault holds native value only |

---

## RV-01 (High): k signatures rotate the committee immediately

**Location:** `ProviderRegistry.requiredSignatures`, `_committee`, `_setCommittee` (L282-285, L501-527).

**Issue:** A COMMITTEE decision needs only `k` signatures. It takes effect in the same transaction with no
notice, and it can install any committee that has `k >= 1, n >= k+1`, including 2 members with k = 1.
After that, the new keys sign everything else.

**Impact:** The design gives disables and blacklisting k+1 and gives the vault a notice period and a
challenge window, so that k compromised keys have a bounded effect. These bounds do not hold. With k keys
an attacker can:
1. rotate to keys they control (and so lock the honest members out for good);
2. blacklist any account or disable any ledger, edge, Router or version (k+1 = 2 attacker keys);
3. name a fresh EOA, which is not a "provider account", as recovery for every case, and drain every vault
   after `RECOVERY_NOTICE + CHALLENGE_WINDOW` wherever no party challenges in time (RV-08 removes even that);
4. relay all of this to every ledger, because decisions are ledger-independent.

The blast radius of k keys is therefore the whole system on every ledger, for good.

**Tests:** `test_RV01_kSignaturesCaptureCommittee_thenBlacklistWithoutKPlusOne`,
`test_RV01_kSignaturesCaptureCommittee_thenDrainVaultViaFreshRecoveryAddress`.

**Fix:**
- Require the strongest quorum for COMMITTEE, for example `max(k+1, ceil(2n/3))`.
- Apply a rotation after a notice period (≥ `CERT_NOTICE`) during which the outgoing committee can cancel
  it with k+1.
- Bound how far one rotation can move: replace at most `n - k` members per decision, keep `k ≥ ceil(n/2)`,
  and set a minimum `n`.
- Optionally, let a vault recovery address only be a party of a deposit in the case, or require the
  named address to sign an opt-in.

## RV-02 (High): Nonce equivocation and the rotation race

**Location:** `submit` (L250-252) and the contract NatSpec (L26-34): "a malformed or expired decision is
replaced by the committee signing a new decision with the same nonce".

**Issue:** The only ordering check is `nonce == version + 1`. The digest does not commit to the previous
decision, so any number of different decisions can be valid for the same nonce. The design itself depends
on re-signing a nonce. Anyone may relay, so the first relayed decision wins on each ledger.

**Impact:**
- `version` no longer names one registry state across ledgers. Routes pin `filter_registry_versions`, and
  `certificationAt(key, v)` then gives different answers on different hops, which is the property the
  versioning exists to provide. The test shows `certificationAt(hedera/ISO, 1)` true on A and false on B,
  with both at version 1.
- Rotation race: the committee rotates away from leaked keys. Until someone relays that rotation to each
  ledger, the leaked keys, still the current epoch there, can sign a competing COMMITTEE decision with the
  same nonce and land it first. That ledger is then captured, and the real rotation reverts there for good
  with `OutOfOrder`. Liveness and safety on lagging ledgers depend on who wins a relay race.

**Tests:** `test_RV02_nonceEquivocation_sameVersionDifferentStateAcrossLedgers`,
`test_RV02_removedKeysRaceRotationOnLaggingLedger`.

**Fix:**
- Hash-chain the decisions: add `prevDigest` to `Decision` and the digest, store `lastDigest`, and require
  `d.prevDigest == lastDigest`. Version N then names exactly one history.
- Never re-sign a nonce once any ledger may have applied it. For a decision that cannot apply on some
  ledger, make it apply as a recorded no-op instead (see RV-03).
- Give ordered decisions a long `validUntil`, or drop expiry from ordered decisions.
- Treat cross-ledger relay of COMMITTEE decisions as an operational duty, with a keeper relaying them
  everywhere in the same block window.

## RV-03 (Medium): Ledger-dependent reverts halt a ledger's sequence

**Location:** `_certify` (L400-408). `effectiveFrom` depends on `block.timestamp` at relay and on the
local log tail.

**Issue:** `InvalidExpiry` is evaluated against `max(effectiveAt, now + notice)`, clamped to the last log
entry. A CERTIFY that is valid when relayed promptly reverts when relayed later on another ledger, even
inside `validUntil`. The NatSpec promises that handlers whose effect depends on local state apply as no-ops,
but this one reverts. The nonce can then never be consumed on that ledger, so every later decision fails
there with `OutOfOrder`, including urgent k+1 disables. The only way out is re-signing the nonce, which is
RV-02. An unbounded `effectiveAt` close to `type(uint64).max` does the same thing permanently for one key:
every later CERTIFY of it reverts.

**Tests:** `test_RV03_certifyRevertsWhenRelayedLate_ledgerHaltsForever`,
`test_RV03_effectiveAtNearMaxBricksCertKey`.

**Fix:** Validate everything that does not depend on time or local state at submit, then let the
time-dependent part degrade:
- clamp `expiry` instead of reverting, or apply an expired certification as a no-op with an event;
- require `effectiveAt <= now + MAX_EFFECTIVE_DELAY`, and check
  `expiry - effectiveAt <= MAX_CERT_DURATION` against the signed values only;
- emit a `DecisionSkipped` event so that the version still advances on every ledger.

## RV-04 (Medium): No deployment binding, so cross-registry and cross-vault replay works

**Location:** `decisionDigest` (L273-279): `DOMAIN` is a constant, with no chain id, no contract address
and no registry-family id. `QuarantineVault._consume` uses the same digest.

**Issue / impact:**
- Registry: every registry that shares a committee key set accepts the same decision at the same nonce,
  for example staging and production, a redeploy, or a second provider family run by the same signers.
  Cross-*ledger* relay is intended. Cross-*deployment-family* relay is not.
- Vault, which is worse: vault decisions are not ordered and are not tied to a ledger. `depositId` is a
  per-vault counter. So a `VAULT_RELEASE(depositId, caseId, kind)` signed for ledger A also pays out
  deposit #id on every other ledger whose deposit has the same case, and that is common, since one
  blacklist case diverts routes on many ledgers. A `VAULT_NAME_RECOVERY(caseId, to)` replays to every
  vault. On another chain the same 20-byte `to` can belong to someone else (a counterfactual Safe or a
  CREATE2 contract that is not deployed there). In the test, B's 7 ether follows decisions that were
  signed only for A.

**Tests:** `test_RV04_decisionReplaysOntoUnrelatedRegistryWithSameCommittee`,
`test_RV04_recoveryNamingAndReleaseReplayOntoAnotherLedgersVault`,
`test_RV04_releaseToSenderReplaysOntoSameIdOtherLedger`.

**Fix:**
- Registry: add an immutable `REGISTRY_ID`, set in the constructor and identical across one family's
  ledgers, to the digest.
- Vault: add `block.chainid` (or the CAIP-2 ledger id) and `address(this)` to the vault payload or the
  digest, for example `VAULT_RELEASE(ledgerId, vault, depositId, caseId, kind)`, and check both in `_consume`.

## RV-05 (Low): DELIST with k undoes a BLACKLIST that needed k+1

**Location:** `requiredSignatures` (L282-285), `_delist` (L475-482).

**Issue:** Blacklisting needs k+1. Delisting the same case needs k and takes effect immediately, and the
Router re-checks the blacklist at settlement (`ClprRouter._finish` L667-674). So k members, or k
compromised keys, can lift a freeze in the same block and let a pending payout of a listed account go
through. With RV-01 fixed, this is the next weakest point.

**Test:** `test_RV05_kMembersImmediatelyUndoKPlusOneBlacklist`.

**Fix:** Require k+1 for DELIST, or keep k but apply it after a short notice (for example
`REMOVAL_NOTICE`) so that a k+1 renewal can override it.

## RV-06 (Low): A far-future CERTIFY blocks timely removal

**Location:** `_certify` (L401-404), the clamp to the last entry's `effectiveFrom`.

**Issue:** A CERTIFY with `effectiveAt = now + 300 days` pushes every later UNCERTIFY of that key to
day 300. Meanwhile the current certification stays live. `REMOVAL_NOTICE` is meant to bound how long
a bad certification survives, and it no longer does. Combined with RV-03 (no upper bound on `effectiveAt`),
a key can be frozen for good.

**Test:** `test_RV06_farFutureCertifyBlocksTimelyRemoval`, plus `test_RV03_effectiveAtNearMaxBricksCertKey`.

**Fix:** Bound `effectiveAt`. When an UNCERTIFY arrives, cancel pending future entries instead of queueing
behind them: append the UNCERTIFY at `now + REMOVAL_NOTICE` and mark later-effective entries as superseded,
so the log stays append-only.

## RV-07 (Info): Unvalidated parameters

**Location:** `ProviderRegistry` constructor (L224-232), `QuarantineVault` constructor (L90-94).

**Issue:** Every notice, lapse and window can be 0. `DISABLE_LAPSE = 0` makes every disable lapse in the
block it applies, so it is a silent no-op. `RECOVERY_NOTICE = CHALLENGE_WINDOW = 0` makes recovery
immediate and unchallengeable.

**Test:** `test_RV07_zeroNoticesAccepted`.

**Fix:** Enforce minimums, for example `REMOVAL_NOTICE ≤ CERT_NOTICE`, `DISABLE_LAPSE ≥ 1 day`,
`CHALLENGE_WINDOW ≥ 3 days`, and assert them in the deploy script.

## RV-08 (Medium): Naming the same address again wipes a challenge

**Location:** `QuarantineVault.nameRecovery` (L129-131) overwrites `recoveries[caseId]`, including
`challenged = false`.

**Issue:** The NatSpec says a challenge "blocks that recovery address". Instead, one more
`VAULT_NAME_RECOVERY` with the same `to` and a new nonce clears the challenge. After a second notice
plus window, the challenged address is paid. The challenge is a delay, not a block.

**Test:** `test_RV08_renamingSameAddressClearsChallenge`.

**Fix:** Keep `mapping(bytes32 caseId => mapping(address => bool)) challengedTo` and reject naming an
address that was challenged for the case. Alternatively, make a challenge escalate, for example by
requiring k+1 and a longer window for a challenged address.

## RV-09 (Medium): Anyone can veto recoveries for 1 wei, and some deposits lock forever

**Location:** `deposit` (L102-120) is permissionless and accepts any `caseId`. `challengeRecovery`
(L138-146) lets any party of *any* deposit in the case block the case-wide recovery.

**Issue / impact:**
- Anyone can deposit 1 wei under a victim case, naming themselves as sender, and then challenge every
  recovery named for that case. With RV-08 fixed, that is a permanent veto. The blacklisted party
  itself, as the sender of its own diverted route, can also always veto, so the recovery path cannot be
  used in the main exploit case it exists for.
- The Router deposits `sender = o.sender` and `recipient = payee`. For a route with fees only, `payee` is
  zero. If the sender is an app contract that cannot take native value, it would be paid through the
  Router's `owed` fallback, but the vault has no such fallback. Then SENDER reverts (`TransferFailed`),
  RECIPIENT reverts (`ForbiddenBeneficiary`), and RECOVERY can be vetoed by anyone, so the funds are locked
  forever.

**Tests:** `test_RV09_oneWeiDepositGrantsChallengeRightOverWholeCase`,
`test_RV09_noReceiveSenderAndNoRecipient_onlyRecovery_whichIsVetoable`.

**Fix:**
- Accept deposits only from registered Routers. The Router is fixed per ledger, so the vault can take
  an allow-list or a factory check.
- Scope challenges to the deposits of the challenger: store recovery per `(caseId, depositId)`, or have
  release check that no party of *this* deposit challenged.
- Add a pull-payment fallback (`owed[to]` plus `withdraw()`) so that a sender that rejects value is still
  releasable.

## RV-10 (Info): `effectiveAt` is ignored; the vault holds native value only

`QuarantineVault._consume` does not check `d.effectiveAt`, so a release signed "for day 30" can be
relayed on day 0 (`test_RV10_vaultIgnoresEffectiveAt`). Either enforce `block.timestamp >= d.effectiveAt`
or document that the field is unused for vault actions. The vault holds only native value. There is no
ERC-20 path, so ERC-20 reentrancy and accounting are not in scope today. If token support is added,
use per-token accounting and `nonReentrant`. `isProviderAccount` covers only committee signing keys and
not the provider's other addresses, such as fee payees or relayers. That limits the guarantee "never to
a provider account".

---

## Checked and holding

| Property | Evidence |
|----------|----------|
| High-s malleated signatures, compact (64-byte) signatures and v ∉ {27,28} are rejected (OZ `tryRecover`), and the replay key is the digest, not the signature | `test_ok_highSMalleatedSignatureRejected`, `test_ok_compactAndBadVRejected` |
| Duplicate and unsorted signers are rejected, and outsiders are rejected | `test_ok_duplicateAndUnsortedSignersRejected`, `testFuzz_quorumNeedsEnoughDistinctMembers` |
| Removed members and old-epoch decisions are rejected after rotation (in the registry and the vault), and former members stay provider accounts | `test_ok_removedMemberCannotSignAfterRotation`, `test_ok_vaultReleaseNeedsKFromCurrentEpoch` |
| Disable and blacklist need k+1 (absent RV-01) | `test/unit/ProviderRegistry.t.sol`, fuzz |
| Strict nonce order, no double apply, `validUntil` enforced | `testFuzz_nonceOrderingAndExpiry` |
| The registry never accepts vault actions, and the vault never accepts registry actions | `test_ok_vaultActionsNeverAcceptedByRegistry`, `test_ok_recoveryWaits…` |
| Trust-tier raise waits `CERT_NOTICE`, lower or removal waits `REMOVAL_NOTICE`, and an out-of-range tier is rejected | `test_ok_trustTierRaiseWaitsCertNotice_lowerWaitsRemovalNotice` |
| ENERGY is stored in µgCO2e and other labels zero their emissions; a pinned version below an entry ignores it, and above the registry it fails closed | `test_ok_energyStoredInMicrograms_otherLabelsZeroed` |
| Certification history is append-only, versions in the log strictly increase and `effectiveFrom` never decreases | invariant `versionCountsAppliedDecisions` (log checks in the handler) |
| Vault: no release without the matching case, no double release (including through reentrancy), never to the vault, the registry or any provider account, and recovery only after notice plus window and only if not challenged | `test_ok_*` in `VaultFindings.t.sol`, invariant `releasesFollowRules` |
| Vault balance equals the sum of unreleased deposits | invariant `vaultBalanceConservation` |
| Registry version equals the number of applied decisions and is monotonic; decisions apply only with quorum | invariants `versionCountsAppliedDecisions`, `decisionsOnlyWithQuorum` |
| The committee always keeps k ≥ 1 and k+1 ≤ n | invariant `committeeShape` |
| Timestamp skew: notices are days long, so validator skew of seconds has no effect; the lapse boundary is `>=` (a lapsed entry is inactive at `lapseAt`) | review |
| Relaying by anyone: the relayer cannot change anything that is signed, and front-running the same decision only makes the second relay revert with no harm (but see RV-02 for different decisions) | review |
