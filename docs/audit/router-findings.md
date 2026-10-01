# CLPRouter Router security review

Scope: `src/ClprRouter.sol`, `src/libraries/{RouteLogic,RouteCodec,RouteTypes,Caip}.sol`,
`proto/clprouter/v1/route_envelope.proto`, and how the Router uses the reference `ClprService`
(`lib/clpr-smart-contracts`, unchanged). The registry and vault are covered in `registry-vault-findings.md`;
they are used here only as the Router sees them.

Method: manual review, Foundry proofs of concept, stateful invariant testing, codec fuzzing, Slither 0.11.6 and
Aderyn 0.6.8. Every finding has a test under `test/security/router/`. Finding tests assert the **secure**
behaviour, so they fail until the finding is fixed. Two design-level tests (`*_DESIGN_*`) run the exploit, assert
today's behaviour, and then report as skipped.

```
forge test --match-path 'test/security/router/*'
```

## Summary

| ID | Severity | Title | Test |
| --- | --- | --- | --- |
| H-01 | High | Receipt-id squatting lets the sender take back an escrow after delivery | `RouterFindingsFlow.t.sol:test_H01_*` |
| H-02 | High | Anyone can forge receipts for strict routes that use `receipt_path` | `RouterFindingsFlow.t.sol:test_H02_*`, `test_H02b_*` |
| M-01 | Medium | Route-id squatting on a downstream ledger censors a route | `RouterFindingsFlow.t.sol:test_M01_*` |
| M-02 | Medium | `forward()` turns a transient `sendMessage` failure into a final outcome; pending receipts are dropped | `RouterFindingsUnit.t.sol:test_M02_*`, `test_M02b_*` |
| M-03 | Medium (design) | Loose-route receipts are unauthenticated; anyone re-routes a rejected loose hop | `RouterFindingsFlow.t.sol:test_M03_DESIGN_*` |
| M-04 | Medium (design) | A sender-chosen intermediate "Router" decides the settlement | `RouterFindingsFlow.t.sol:test_M04_DESIGN_*` |
| M-05 | Medium | Return bombs from payment receivers push receipt settlement past the CLPR gas limit | `RouterFindingsUnit.t.sol:test_M05_*` |
| L-01 | Low | A disable at the origin drops a DELIVERED receipt for good | `RouterFindingsFlow.t.sol:test_L01_*` |
| L-02 | Low | The codec accepts non-canonical encodings and replaces (does not merge) repeated messages | `RouterFindingsUnit.t.sol:test_L02_*`, `test_L02b_*` |
| L-03 | Low | The blacklist never checks the destination application | `RouterFindingsUnit.t.sol:test_L03_*` |
| I-01 … I-06 | Info | See below | — |

H-01, M-02 and M-05 share one amplifier (I-01): a receipt is a fire-and-forget CLPR message. If any Router on its
way rejects or fails it, nothing records that and nothing retries it; the origin can only `reclaim`, which refunds
the sender. Every way of losing a DELIVERED receipt therefore moves the escrow from the payee back to the sender,
and the sender is the party who gains from that.

## High

### H-01 Receipt-id squatting lets the sender take back an escrow after delivery

**Location.** `RouteLogic.buildReceipt` (receipt id), `ClprRouter._buildEnvelope` (caller-chosen `routeId`),
`ClprRouter._validateInbound` (replay check), `ClprRouter.reclaim`.

**Description.** A receipt's route id is `bytes16(keccak256(routeId, "receipt", hopIndex))`, which anyone can
compute once the route id is known. `send` accepts any unused caller-chosen `routeId`, and the replay set is
shared between routes a Router originated and routes it received. The sender calls `send` on its own origin
Router with `routeId = receiptId(id, last)` (a zero-value route is enough). The honest DELIVERED receipt then
reaches the origin, `_validateInbound` reverts with `RouteReplayed`, the CLPR message is consumed with
APPLICATION_ERROR, and nothing retries it (I-01). After `deadline + RECLAIM_GRACE`, `reclaim` refunds the
escrow and the whole fee budget to the sender, although the destination application already acted. The same id
can be squatted on any intermediate ledger of the receipt's way back.

**Impact.** Theft from the payee (and the fee payees) by the sender on every value route, for the cost of one
extra send. A third party can do the same to force refunds instead of payments.

**Proof.** `test_H01_receiptIdSquatting_payeeIsPaidAfterDelivery`: the destination delivers, the route ends
EXPIRED and the payee gets 0.

**Recommended fix.** Keep receipts out of the route-id namespace: key the replay set by
`keccak256(origin ledger, origin Router, routeId)` so a receipt (whose origin is the reporting Router) can never
collide with a route this Router originated, or keep a separate replay set for receipts that `send` cannot
write to. Reject caller-chosen route
ids that collide with any id this Router could receive (simplest: reserve a domain bit for receipt ids and refuse
it in `send`). Also see I-01.

### H-02 Anyone can forge receipts for strict routes that use `receipt_path`

**Location.** `RouteLogic.checkReceipt` (explicit `routePrefix` branch), `ClprRouter._advance` for receipts in
transit, `ClprRouter.send` (`verifyPath = false` when `receiptPath` is set).

**Description.** With `r.routePrefix` set, `checkReceipt` takes the reporter's identity from the receipt
envelope's `origin` field, which whoever builds the envelope chooses freely. It does not compare the path the
receipt travelled with the route's `receipt_path`, and does not bind `origin` to the first hop of the receipt
envelope. Intermediate Routers relay receipts from any CLPR sender, checking only the immediately previous hop.
So any application on any ledger peered with the route's first-hop ledger (B) sends B's Router a receipt
envelope `[attacker, B, origin]` naming the destination (or any hop) as `origin`, with the public `routePrefix`,
`routeEdge` and `routeRest` of the route. B forwards it, it arrives over the first Channel from the first-hop
Router, and the commitment matches.

**Impact.** Any third party can settle such a route as DELIVERED (with a chosen `responseHash`) before it is
delivered, as FAILED / EXPIRED (paying chosen prefix fees and refunding the rest), or as QUARANTINED with a
made-up case id, which moves the sender's unused fee budget into the quarantine vault until a committee release.
Escrow is not at risk only because `send` refuses escrow with a `receipt_path`.

**Proof.** `test_H02_explicitReceiptPath_thirdPartyCannotForgeReceipt` (QUARANTINED, budget in the vault before
the route left A) and `test_H02b_explicitReceiptPath_forgedDeliveredBeforeDelivery`.

**Recommended fix.** Store a commitment to `receipt_path` at send and require, for the prefix branch, that the
receipt envelope's hops equal the stored receipt path, that `r.hopIndex` is the last route hop, and that
`re.origin` equals both `re.hops[0]` and `hops[last]`. Until then, refuse `receipt_path` on routes with a fee
budget, as already done for escrow.

## Medium

### M-01 Route-id squatting on a downstream ledger censors a route

**Location.** `ClprRouter._buildEnvelope` and `_validateInbound` (shared replay set).

**Description.** Route ids are visible (`RouteSent`, the CLPR message, or a known UETR) before the bundle that
carries them is relayed. Anyone on an intermediate or destination ledger sends a route of their own from that
ledger with the same id. The real route is then rejected there as a replay; the origin settles FAILED.

**Impact.** Censorship of any chosen route (and a permanent block on reusing a UETR) for the cost of one send.
Funds are refunded, not lost.

**Proof.** `test_M01_routeIdSquattingDownstream_cannotCensorRoute`.

**Recommended fix.** Key the replay set by `(origin ledger, origin Router, routeId)` and stamp generated ids with
the origin Router; for caller-chosen ids (UETR) keep the UETR as a field but not as the sole key.

### M-02 `forward()` turns a transient `sendMessage` failure into a final outcome; pending receipts are dropped

**Location.** `ClprRouter.forward` → `_advance` → `_trySend` (the `SendResult.FAILED` branch).

**Description.** On the reference ClprService every hop and every receipt in transit completes through the
permissionless `forward()`. When `sendMessage` reverts for any reason other than low gas, a strict route stops
with a final FAILED receipt and a pending receipt is dropped (`ReceiptUndeliverable`, state DONE). Several such
reverts are transient and can be caused by anyone: `ClprQueueFull` and `ClprQueueQuotaExceeded` (fill the queue or
the Connector quota, then call `forward` in the same transaction), a Connector that refuses for a while, or a
paused Channel. `flush()` is not affected: it reverts as a whole and the outbox entry stays.

**Impact.** Strict routes can be failed on demand. A DELIVERED receipt pending on an intermediate Router can be
destroyed, after which the sender reclaims the escrow (same outcome as H-01).

**Proof.** `test_M02_forwardDuringTransientSendFailure_keepsHopPending` and
`test_M02b_pendingReceipt_survivesTransientSendFailure` (`SecMockService.setFailChannel` stands for the
transient revert).

**Recommended fix.** In `forward()` (outside delivery), revert on any `sendMessage` failure so the hop stays
pending, exactly as for low gas; let only the deadline (EXPIRED) or a CLPR NACK end a route. Never drop receipts:
keep them pending until they can be sent.

### M-03 (design) Loose-route receipts are unauthenticated; anyone re-routes a rejected loose hop

**Location.** `RouteLogic.checkReceipt` (`commitment == 0` returns true), `ClprRouter.forward(envelope, newTail)`.

**Description.** A loose route stores no commitment, so the origin accepts any receipt that arrives from its
first-hop Router over the first Channel, and that Router relays receipts from anyone (H-02 mechanics). A third
party can set the status, reason, case id and response hash reported to the sender. Separately, the tail of a
NACKED loose hop is chosen by whoever calls `forward` first, so a front-runner can route it through Routers it
controls (or race a re-route with an empty tail to fail it).

**Impact.** No funds (loose routes carry no value), but `RouteSettled` and `onRouteReceipt` for loose routes cannot
be trusted, and loose re-routing can be hijacked.

**Proof.** `test_M03_DESIGN_looseRoute_thirdPartyForgesStatus` (runs, then skips).

**Recommended fix.** Document loose-route receipts as unauthenticated and mark them in the event / callback;
optionally let only the origin application (or a signer named in the envelope) supply a new tail.

### M-04 (design) A sender-chosen intermediate "Router" decides the settlement

**Location.** `ClprRouter._validateInbound` (`prev.router == CLPR sender`), `RouteLogic.checkRoute`.

**Description.** Nothing ties `hops[i].router` to a canonical Router deployment. A sender names a contract it
controls as hop 1. It forwards the envelope like a real Router (the next Router only checks that the CLPR sender
equals `hops[1].router`, so the destination delivers) and sends a FAILED receipt that matches the stored
commitment. The escrow goes back to the sender. The spec lists "a fake or faulty Router deployment" as a reason
for a committee disable, which is reactive and needs k+1 signatures per deployment.

**Impact.** A sender can defraud the payee on any value route whose intermediate hops it picks. The payee and the
destination application never see the hop list (`onRouteMessage` does not carry it).

**Proof.** `test_M04_DESIGN_fakeIntermediateRouter_refundsSenderAfterDelivery` (runs, then skips).

**Recommended fix.** Let the registry certify Router deployments (or pin one code hash per ledger) and check
every hop's Router against it at send and at each hop; or pass the hops (or their commitment) to the destination
application so it can refuse routes it does not trust.

### M-05 Return bombs from payment receivers push receipt settlement past the CLPR gas limit

**Location.** `ClprRouter._pay` (`(bool ok,) = to.call{value: amount, gas: 30_000}("")`).

**Description.** The low-level call still copies the callee's return data into the Router's memory. Every
receiver of a settlement payment (up to 8 fee payees, the payee, and the sender) is chosen by the sender. Each can
return about 106 KB within its 30,000 gas plus the 2,300 stipend, and memory grows across the payments. Measured on
an 8-edge route: settlement of the DELIVERED receipt costs 3,023,673 gas with 106,000-byte bombs versus 497,358
without. With the CLPR per-message gas limit of 3,000,000 (test fixture), the Router runs out of gas, the receipt
is consumed with APPLICATION_ERROR, and the sender reclaims (I-01). A deployment with a lower per-message limit
needs fewer bomb receivers.

**Proof.** `test_M05_returnBombs_doNotBreakSettlementUnder3MGas`.

**Recommended fix.** Make the payment call in assembly without copying return data
(`call(30000, to, amount, 0, 0, 0, 0)`), and bound the copy of the destination application's response
(`onRouteMessage` can return several hundred KB within `APP_GAS`, estimated; hash it with a bounded
`returndatacopy`).

## Low

### L-01 A disable at the origin drops a DELIVERED receipt for good

**Location.** `ClprRouter._checkHere` / `_stop` for receipts.

**Description.** A receipt arriving over a disabled inbound edge, ledger or Router (or while the Router version is
disabled) is dropped. The disable lapses after 7 days, but the receipt is gone, so a delivered value route can
only be reclaimed by the sender. The spec accepts a refund in this case; holding the receipt would be safer.

**Proof.** `test_L01_disabledInboundAtOrigin_receiptIsHeldNotDropped`.

**Recommended fix.** At the origin, record such a receipt as pending (keyed by its hash) and let anyone settle it
once the disable has lapsed or been lifted; block `reclaim` while one is held.

### L-02 The codec accepts non-canonical encodings and replaces (does not merge) repeated messages

**Location.** `RouteCodec._readVarint`, `decodeEnvelope`, `decodeReceipt`.

**Description.** Over-long varints, explicitly encoded default values, repeated singular fields, known fields with
an unexpected wire type (silently skipped) and field numbers above 2^29−1 all decode. A repeated embedded message
(`constraints`, `origin`, ...) replaces the earlier one, while protobuf merges them, so the SDK and services can
read a different envelope than the chain. No replay or hash confusion was found: replay is keyed by route id and
`forward` / `flush` compare exact bytes.

**Proof.** `test_L02_decodeRejectsOverlongVarint`, `test_L02b_duplicateEmbeddedMessage_mergesLikeProtobuf`.

**Recommended fix.** Reject over-long varints and repeated singular fields, and reject known field numbers with
the wrong wire type; keep skipping unknown field numbers for forward compatibility.

### L-03 The blacklist never checks the destination application

**Location.** `ClprRouter.send`, `_checkHere`.

**Description.** The Router checks the sender, the payee and the free-form `recipient` string. The destination
application, which receives the message, is never checked, and `recipient` need not name it (any spelling that
is not the listed CAIP-10 id passes).

**Proof.** `test_L03_blacklistedDestinationApp_isQuarantined`.

**Recommended fix.** Also check `Caip.account(destination.ledgerId, destination.application)` at the origin and
at the destination; validate `recipient` as a canonical CAIP-10 id.

## Informational

- **I-01 Receipts are fire-and-forget.** `_sendReceipt` and receipt hops in `_advance` do not record `outbound`,
  so a CLPR rejection of a receipt (replay, out of gas, Router disabled) is invisible and never retried. Track
  receipt messages like route messages and let anyone resend a NACKED receipt.
- **I-02 `Caip.routerKey` uses `abi.encodePacked` over two dynamic values** (`ledgerId`, `router`). Not
  exploitable while ledger ids are CAIP-2 (no `:` in the reference), but `abi.encode` removes the ambiguity.
- **I-03 Clock skew and reclaim race.** Each hop checks the deadline on its own clock, and `reclaim` needs only
  `deadline + RECLAIM_GRACE` on the origin's clock. A DELIVERED receipt still waiting for a `forward` / `flush`
  pump when the grace ends is ignored. `RECLAIM_GRACE` must cover the worst receipt latency including pumps.
- **I-04 Events.** `RouteSent` carries neither the envelope nor its hash; `ReceiptIgnored` has no reason; a route
  rejected by `_validateInbound` emits nothing on that ledger (only the CLPR reply shows it). Services must
  combine CLPR events with Router events to follow a route.
- **I-05 `flush()` does not re-check route safety.** A receipt queued before a disable is still sent after it.
- **I-06 Return data of `onRouteMessage` is copied and decoded in full** (see M-05). By estimate (not measured)
  a destination application can return a few hundred KB within `APP_GAS` and add on the order of 1M gas to its
  own delivery; it only harms routes to itself.

## Checked without findings

- **Access control.** `onClprMessage` / `onClprResponse`: `msg.sender == SERVICE`. `send`, `reclaim`,
  `withdraw`, `forward`, `flush`: permissionless by design. All six mutating entry points share one transient
  `nonReentrant` lock, so no callback (application, notice, receipt hook, payment, vault, Connector authorize
  inside `sendMessage`) can re-enter the Router.
- **Double settlement.** `_settle`, `reclaim` and the origin branch of `onClprResponse` all require PENDING and
  `_finish` writes the terminal status before any transfer. Invariant `invariant_settlesAtMostOnce` holds.
- **Escrow conservation and solvency.** `invariant_escrowConservation` (all ETH in the closed system is
  conserved) and `invariant_routerSolvent` (Router balance = escrow + budget of pending routes + `owed`) hold over
  64 × 60 calls including quarantine at send, pull payments and refusing receivers.
- **Receipt authentication on strict routes without `receipt_path`.** Every single-field tampering of an honest
  receipt (edge digest, rest commitment, hop index, a hop's fee or fee payee, reporter, DELIVERED from a non-final
  hop) is ignored: `invariant_receiptsOnlyFromStoredCommitment`, `testFuzz_forgedReceiptNeverSettles`.
- **Reverted paths.** `invariant_noStateChangeOnRevertedPaths`: failed `forward`, `flush`, `reclaim`,
  `withdraw`, non-Service deliveries and envelope replays leave balances, statuses, hop states and `owed`
  unchanged.
- **Under-gassed delivery.** `test_NF01_underGassedDelivery_neverReturnsNormallyWithAppError` sweeps the delivery
  gas limit from 100k to 1.5M: a starved application call never turns into a returned APPLICATION_ERROR (the
  Router's 1/64 is too little to build the receipt, so delivery reverts).
- **Codec.** `decode(encode(x)) == x` and `encode` is a fixpoint for envelopes and receipts; arbitrary, mutated
  and truncated input either decodes to a value with one canonical form or reverts with `MalformedProtobuf`
  (no panics); wrong-length ids, out-of-range enums, varints ≥ 2^64 and 32-bit overflows are rejected
  (`RouteCodecFuzz.t.sol`).
- **Hop index, trust floor, filters, registry pinning.** `_validateInbound` binds `hopIndex` to this Router and
  the previous hop to the CLPR Channel and sender; trust floor and filters are re-checked at every forward with the
  versions pinned at send; a registry behind the pinned version fails closed.
- **Gas griefing of sends.** `MIN_SEND_GAS` and the 1/63 check make an under-funded `forward` revert as a whole.

## Tool results

**Slither 0.11.6** (`slither . --filter-paths "lib/|test/|script/"`): 0 true positives.
`arbitrary-send-eth` and `reentrancy-eth` on `_pay` / `_finish` are false positives (shared `nonReentrant` lock,
`owed` written only after a failed push, recipients fixed at send). `uninitialized-state` on
`ProviderRegistry._certs` is a false positive (mapping of arrays written through a storage pointer in
`_certify`). `reentrancy-no-eth`
(`getChannel` before state writes) is a trusted Service view under the lock. `uninitialized-local` (19),
`unused-return` (3), `write-after-write` (`_inDelivery`, intended) are benign. `return-bomb` (2) is real and
reported as M-05 / I-06.

**Aderyn 0.6.8** (`npx @cyfrin/aderyn . --src src`): H-1 `abi.encodePacked` collision in `Caip` is real only for
`routerKey` and not exploitable (I-02); H-2 (ETH to `msg.sender` in `withdraw`), H-3 (state after the
constructor's view call and after `sendMessage` under the lock) and H-4 (`bytes16(w)`, `uint64(v)` after explicit
bounds) are false positives. Low items are style.

## Test inventory

| File | Tests | Status today |
| --- | --- | --- |
| `test/security/router/RouterFindingsFlow.t.sol` | 7 | 5 fail (H-01, H-02 ×2, M-01, L-01), 2 skipped (M-03, M-04 design) |
| `test/security/router/RouterFindingsUnit.t.sol` | 7 | 6 fail (M-02 ×2, M-05, L-02 ×2, L-03), 1 pass (NF-01) |
| `test/security/router/RouterInvariants.t.sol` | 7 | 6 invariants + 1 fuzz, all pass |
| `test/security/router/RouteCodecFuzz.t.sol` | 7 | all pass |
| `test/security/router/RouterAuditBase.sol` | — | mocks: `SecMockService`, `FakeRouter`, `ReturnBomb`, `ClprMessenger`, harness |
