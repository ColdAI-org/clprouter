# Threat model

This document covers CLPRouter phase 1: `ClprRouter`, `ProviderRegistry`, `QuarantineVault`, the libraries they
link (`RouteCodec`, `RouteLogic`, `Caip`), the planner SDK (`sdk/`) and the optional services (`services/`). The
CLPR layer under it (ClprService, verifiers, Connectors, endpoints) is out of scope except where CLPRouter depends on
its behaviour. Everything here refers to the code at the commit this file was last changed in.

Severity labels in this document: **High** (loss or theft of funds, or forged delivery on a strict route),
**Medium** (funds held or refunded wrongly, forged status, or a broken safety property under stated conditions),
**Low** (liveness, cost or information exposure with a workaround).

## 1. Assets

| Asset | Where it lives | What protects it |
| --- | --- | --- |
| Escrow and fee budget of a route | `ClprRouter` on the origin ledger, `routes[routeId]` | Settled once, only on an authenticated receipt or a two-phase `reclaim` after the deadline plus `RECLAIM_GRACE` per edge of the way back |
| Quarantined funds | `QuarantineVault` on the ledger that held them | Deposits only from the bound Router; committee decision per release, bound to this vault; fixed beneficiaries; k + 1 to name a recovery address, notice, challenge window and supermajority override |
| Unpushed payments | `ClprRouter.owed[account]` | Only the account itself can `withdraw` |
| Integrity of a routed message (payload, origin, sender, recipient) | Envelope on every hop | Each Channel's CLPR verifier, plus each Router's previous-hop authentication |
| Integrity of a receipt | Receipt envelope on the way back | Same as above, plus the origin's hop-list commitment check (strict routes) |
| Registry state (certifications, trust-tier labels, disables, blacklist, committee, contact) | `ProviderRegistry` on every ledger | k, k + 1 or supermajority committee signatures; decisions form a hash chain bound to the deployment id; notice and lapse periods |
| Committee signing keys | Members' HSMs (off-chain) | Key ceremony and custody (`docs/provider-committee-runbook.md`) |
| Forward-trigger key (services) | Environment of the services process | Test keys only; the trigger refuses non-local RPC URLs |
| Off-chain personal data under the ISO 20022 and MiCA filters | Never on-chain in clear; ciphertext or hashes in the payload | SDK encryption to the destination institution's key; `assertNoClearPersonalData` |

## 2. Actors

| Actor | Trusted for | Can do | Cannot do |
| --- | --- | --- | --- |
| Sender (origin application or account) | Its own funds and choice of route | Pick any route, Routers, mode, filters and constraints; `reclaim` | Make another ledger's Router accept an envelope not addressed to it |
| Recipient / destination application | Its own logic | Accept or revert a delivery (revert gives `FAILED`) | Change the route |
| Router (honest, any version) | Executing the published code | Forward, deliver, stop, send receipts | Anything outside its code; it has no admin key |
| Router (non-canonical deployment) | Nothing | Nothing on CLPRouter routes: every hop, receipt path and loose tail must name each ledger's canonical Router | Be named in a route (`NonCanonicalRouter`) |
| CLPR verifier of a Channel | The integrity of messages over that Channel, at its trust tier | Accept a forged bundle if broken or below its claimed tier | Affect other Channels |
| Connector operator | Paying execution of messages | Refuse to pay (the hop's `sendMessage` fails or is NACKed) | Change message content |
| Endpoint / relayer | Liveness of bundles | Delay or withhold bundles | Forge bundles that the verifier accepts |
| Pumper (anyone calling `forward` / `flush`) | Nothing | Complete a pending hop at a time of its choosing; on a loose route after a NACK, choose the new tail (canonical Routers only) | Complete a hop with a different envelope; fail a hop by under-funding gas (`MIN_SEND_GAS`) |
| Decision relayer (anyone calling `ProviderRegistry.submit`) | Nothing | Choose when a signed decision lands on each ledger | Change a decision; skip a nonce; apply a decision that does not extend the ledger's head |
| Provider committee (k of n) | Certifications, trust-tier labels, disables, blacklist, vault releases, its own membership | See section 4 | Change Router code, fees, Channels, Connectors or verifiers; send funds to its members |
| Regulated operator (operated Router, ISO 20022 / MiCA hops) | Identity and screening at its hop | Reject a forward after screening | Redirect a route (same Router code) |
| Services operator (indexer, status API, quote service, trigger) | Nothing on-chain | Serve wrong quotes or status | Change on-chain state other than completing pending hops |

## 3. Trust boundaries

```mermaid
flowchart LR
    subgraph OffChain["Off-chain"]
        SDK["Planner SDK<br/>(sender side)"]
        SVC["Services<br/>(optional, re-checkable)"]
        COM["Provider committee<br/>k of n, HSM keys"]
        PUMP["Pumpers<br/>(anyone)"]
    end
    subgraph LedgerA["Origin ledger"]
        RA["ClprRouter A<br/>holds escrow"]
        PA["ProviderRegistry A"]
        VA["QuarantineVault A"]
        SA["ClprService A"]
    end
    subgraph LedgerB["Intermediate ledger"]
        RB["ClprRouter B"]
        PB["ProviderRegistry B"]
        SB["ClprService B"]
    end
    SDK -- "route, envelope (untrusted input)" --> RA
    SVC -. "quotes, status (re-checkable)" .-> SDK
    COM -- "signed decisions, relayed by anyone" --> PA
    COM -- "same decisions" --> PB
    PUMP -- "forward / flush" --> RB
    RA -- sendMessage --> SA
    SA == "CLPR Channel: verifier trust tier" ==> SB
    SB -- "onClprMessage" --> RB
    RA -- reads --> PA
    RA -- "deposit on QUARANTINED" --> VA
    VA -- "checkApproval" --> PA
```

Each thick edge is a CLPR Channel and carries exactly the trust of its verifier. Every arrow into a Router is
untrusted input that the Router re-checks: the SDK's route, the CLPR-delivered envelope, a pumper's call and a
relayed registry decision.

## 4. Trust assumptions per tier

### 4.1 Verifier tiers (data path)

The envelope's `trust_floor` and `ProviderRegistry.trustTier` use one scale: 0 attested, 1 committee, 2 light
client, 3 validity proof.

| Tier | A forged message needs | What CLPRouter adds |
| --- | --- | --- |
| 0 attested | The attestor key(s) of that Channel | Nothing; a route is as strong as its weakest hop |
| 1 committee | A threshold of that Channel's committee | Same |
| 2 light client | The source chain's consensus (e.g. the sync committee signs the header) | Same |
| 3 validity proof | A sound proof system and correct circuit | Same |

- **The on-chain floor is off by default.** The SDK sets `trust_floor = 0`, at which Routers never read
  trust-tier labels. A route then depends on no provider decision for trust, and the planner's floor is advisory
  (shown as `effectiveTrustTier` in every quote). A sender who sets a floor above 0 depends on the committee's
  labels, and an unlabelled edge fails closed.
- **Hiero → chain edges have no verifier yet** (section 7.2). No tier can be claimed for them, and no route can leave
  Hiero on a live network today.

### 4.2 Router tier

- Every Router of a deployment sits at its ledger's canonical CREATE2 address (`ClprRouterDeployer`), and every
  Router a route, receipt path or loose tail names must be canonical. So every envelope on the wire was built by this
  code. Non-EVM ledgers fail closed until a registry-certified Router hook exists.
- A hop accepts an envelope only from the Router named for the previous hop, over the named Channel, whose CLPR peer
  is the named ledger (`ClprRouter._validateInbound`).
- The origin, sender and payload the destination sees are as good as every verifier on the route.
- Routers are immutable. A buggy version is switched off by a `DISABLE` of `TARGET_ROUTER_VERSION`, and a new version
  is deployed beside it (`docs/deployment.md`).

### 4.3 Provider committee tier

| Action | Signatures | Takes effect | Bound |
| --- | --- | --- | --- |
| `CERTIFY`, `UNCERTIFY`, `TRUST_TIER` | k | After `CERT_NOTICE` (raise) or `REMOVAL_NOTICE` (lower, remove) | Pinned versions protect routes in flight (certifications only) |
| `DISABLE` | k + 1 | Immediately | Lapses after `DISABLE_LAPSE` unless renewed |
| `ENABLE` | k | After `REENABLE_NOTICE` | — |
| `BLACKLIST` | k + 1 | Immediately | Lapses after `BLACKLIST_LAPSE` unless renewed |
| `DELIST` | k + 1 | Immediately | — |
| `CONTACT` | k | Immediately | — |
| `COMMITTEE` | Supermajority, max(k + 1, ⌈2n/3⌉) | Scheduled; the new committee takes over with its first decision after `COMMITTEE_NOTICE` | n ≥ 3, 2 ≤ k, k > n/2, k + 1 ≤ n; after the notice the outgoing committee needs a supermajority for everything |
| Vault `bindRouter` | k + 1 | Immediately, once | Afterwards only that Router can deposit |
| Vault `nameRecovery` | k + 1 | Releasable after `RECOVERY_NOTICE + CHALLENGE_WINDOW` | The deposit's sender or recipient may challenge; a challenge is never cleared |
| Vault `release` | k (supermajority over a challenge) | Immediately (recovery: after the window; over a challenge: one more `CHALLENGE_WINDOW`) | Only to the deposit's sender, recipient or recovery address; never a provider account |

Registry decisions are EIP-712 digests over a domain whose salt is the deployment id, and each one commits to the
registry head it extends (`prevHead`), so the applied decisions form a hash chain (`headAt`). Vault decisions use their
own domain with the chain id and the vault address, so they act on one vault only.

Naming a vault recovery address needs k+1 committee signatures and waits `RECOVERY_NOTICE` + `CHALLENGE_WINDOW`.
During that time the deposit's original sender or recipient can challenge, and a challenged deposit is paid out only
by a supermajority override after a further `CHALLENGE_WINDOW`. So k+1 compromised keys can redirect an unchallenged
deposit, and a supermajority can redirect any deposit. Separately, a supermajority can install any committee after
`COMMITTEE_NOTICE`, and k compromised keys can fork a ledger that hasn't yet received the next decision. Such a fork
is visible as differing `headAt` values but cannot be undone on-chain.

Recommended values (spec and tests): k ≥ 3, `CERT_NOTICE` 7 days, `REMOVAL_NOTICE` 72 hours, `REENABLE_NOTICE`
7 days, `DISABLE_LAPSE` 7 days, `BLACKLIST_LAPSE` 30 days, `COMMITTEE_NOTICE` 7 days, `RECOVERY_NOTICE` 3 days,
`CHALLENGE_WINDOW` 7 days. The constructors enforce floors (`MIN_*`), so no notice or window can be zero.

### 4.4 Off-chain components

The SDK, the quote service and the status API add no trust. A wrong quote can make a route fail or cost more; it
cannot redirect funds, because every hop re-checks on-chain. The status API reports the block numbers and registry
versions each answer is built from, so a client can re-check it against an RPC node.

## 5. Attack surfaces

| # | Surface | Entry point | Main checks |
| --- | --- | --- | --- |
| S1 | Route submission | `ClprRouter.send` | Structure, deadline, fees vs budget and `max_fee`, safety of every edge, ledger and Router, filters at the current registry version, blacklist (sender, recipient, payee), loose routes carry no value |
| S2 | Inbound envelope | `onClprMessage` (only the Service) | Version, structure, addressed to this Router, previous Router and Channel, Channel peer ledger, replay, deadline |
| S3 | Inbound CLPR Response | `onClprResponse` (only the Service) | Known outbound message; NACK marks the hop for completion |
| S4 | Pending hop completion | `forward(envelope, newTail)`, `flush(...)` | Exact envelope hash; all checks re-run; `MIN_SEND_GAS`; tail only on loose routes |
| S5 | Receipt at the origin | `_settle` via `onClprMessage` | First-hop Router and Channel, hop-list commitment (strict), exact reverse path (strict, no explicit receipt path) |
| S6 | Refund without receipt | `reclaim` (two calls) | Status `PENDING`, no receipt held; request after `deadline + RECLAIM_GRACE × edges`, refund `RECLAIM_GRACE` later |
| S7 | Pull payments | `withdraw` | Caller's own balance |
| S8 | Committee decisions | `ProviderRegistry.submit` | Action, evidence hash, nonce = version + 1, digest extends the current head, `effectiveAt` within `MAX_NOTICE`, epoch (or the scheduled committee after its notice), sorted distinct member signatures, threshold |
| S9 | Vault | `bindRouter`, `deposit`, `nameRecovery`, `challengeRecovery`, `release` | Bound Router; case id; vault-bound committee approval, `effectiveAt` and `validUntil`; beneficiary rules; window; per-deposit challenges; one release per deposit |
| S10 | Application callbacks | `onRouteMessage`, `onRouteNotice`, `onRouteReceipt` | Fixed gas stipend `APP_GAS`; notices and receipt callbacks are best effort |
| S11 | Envelope bytes | `RouteCodec.decodeEnvelope` / `decodeReceipt` | Strict proto3 decoding; fuzzed (`testFuzz_decode_neverPanics`) |
| S12 | Services HTTP API | `GET /routes/:id`, `/accounts/:caip10/notices`, `/registry`, `/stream`, `/pending`, `POST /quote` | Read-only on-chain; unauthenticated; bind to localhost by default |
| S13 | Forward trigger | `services/src/trigger.ts` | Key from env only; refuses non-local RPC; simulates before sending |
| S14 | Supply chain | CI, npm dependencies, Docker base image, git submodule | SHA-pinned actions, lockfiles, `pnpm audit`, OSV-Scanner, CodeQL, SBOM and provenance on releases |

## 6. Threats and mitigations

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | Replay of an envelope on the same Router | Route ids are derived by the origin Router (ledger, Router, sender, nonce); hop state and replay are keyed by (origin ledger, origin Router, id); a repeat reverts `RouteReplayed` | None known (audit H-01, M-01 fixed) |
| T2 | Loop or unbounded route | No ledger twice; at most `max_hops` (default 3, cap 8); receipts never trigger receipts | None known |
| T3 | Envelope injected by a non-Router | Only the Service may call `onClprMessage`; previous Router, Channel and peer ledger must match the envelope | Bounded by the Channel's verifier (4.1) |
| T4 | Forged receipt to release escrow | Canonical Routers only; strict routes: commitment to the hop list and the exact reverse path, first hop authenticated; `receipt_path` receipts must travel exactly the stored path; DELIVERED only from the destination | Bounded by the verifiers on the way back (4.1) |
| T5 | Fee exhaustion or overcharge | Fees checked against the budget and `max_fee` at send and at every hop; payouts only for hops before the reporting one and never above the budget | None known |
| T6 | Griefing a hop by under-funding gas | `MIN_SEND_GAS`: a permissionless `forward` below it reverts with `InsufficientGas`; inside delivery the hop stays pending; out-of-gas inside `sendMessage` is not treated as a verdict | `MIN_SEND_GAS` must be set per ledger from measurement (R9) |
| T7 | Funds stranded when the way back is cut | Receipts are never dropped (outbox, held receipts); two-phase `reclaim` refunds escrow and budget | Late-receipt ordering (R4) |
| T8 | Reentrancy | `ReentrancyGuardTransient` on every external entry; state written before `sendMessage`, app calls and vault deposits; pushes capped at 30,000 gas with fallback to `owed` | None known |
| T9 | Exploiter moves funds through CLPRouter | Blacklist (k + 1) checked at the origin, at every hop and again at settlement; funds go to the vault | Covers only CLPRouter; fresh addresses evade it |
| T10 | Compromised verifier or ledger | `DISABLE` of the edge or ledger (k + 1, immediate); messages already over a disabled inbound edge are not forwarded | Messages delivered before the disable stand |
| T11 | Malicious Router deployment | Only canonical Routers (`ClprRouterDeployer`, owner-only, pinned init code) are accepted on any hop; previous-hop authentication; `DISABLE` of `TARGET_ROUTER` or `TARGET_ROUTER_VERSION` | The deployer owner could take a not-yet-deployed ledger's canonical address with a Router wired to a fake Service |
| T12 | Certification change on routes in flight | Routes pin the registry version; a registry behind the pin fails closed | Disables and blacklist entries are deliberately not pinned |
| T13 | Registry state diverges between ledgers | Strict nonce order; each decision extends the head (hash chain); `headAt` comparable across ledgers (SDK `checkRegistryHeads`) | Relaying lag (R7); a k-key fork of a lagging ledger (R8) |
| T14 | Committee key compromise | k / k + 1 / supermajority thresholds; scheduled committee changes; epochs; notices; lapse; vault beneficiary rules and challenges; all actions public | R2, R3, R8 |
| T15 | Personal data on-chain | Under ISO 20022 / MiCA the SDK encrypts to the destination institution (X25519, XChaCha20-Poly1305) and checks every clear field | Routes without those filters carry payloads in plaintext on every ledger they cross |
| T16 | Wrong quote or status from services | Every answer carries block numbers and registry versions; every hop re-checks | None on-chain |
| T17 | Trigger key misuse | Test key from env; refuses to sign against non-local RPC; no key in config, image or logs | Production pumping needs its own key handling (R1) |
| T18 | Malicious dependency or CI action | Lockfiles, SHA-pinned actions, Dependabot, audits, SBOM and provenance attestations | Upstream compromise before pinning |

## 7. Residual risks

### R1. Two-transaction forwarding (Medium, liveness and value)

The reference Solidity `ClprService` guards `submitBundle` and `sendMessage` with one transient reentrancy lock. A
Router cannot call `sendMessage` while it is being delivered a message, so every intermediate hop and every receipt
takes a second transaction (`forward` or `flush`) by anyone.

```mermaid
sequenceDiagram
    autonumber
    participant E as Endpoint
    participant S as ClprService (hop ledger)
    participant R as ClprRouter (hop ledger)
    participant P as Pumper (anyone)
    E->>S: submitBundle (bundle with the envelope)
    S->>R: onClprMessage (lock held)
    R->>R: authenticate, replay, safety, filters, fee
    R->>S: sendMessage (next Channel)
    S-->>R: revert ReentrancyGuardReentrantCall
    R->>R: hopState = FORWARD_PENDING, pendingHash = keccak256(envelope)
    R-->>S: response ACCEPTED (event ForwardPending with the envelope)
    Note over E,P: transaction 1 ends, the hop waits for anyone
    P->>R: forward(envelope, [])
    R->>R: hash matches, all checks again, gasleft >= MIN_SEND_GAS
    R->>S: sendMessage (lock free)
    S-->>R: messageId
    R->>R: hopState = FORWARDED (event RouteForwarded)
```

- **Liveness.** A hop moves only when someone pumps it. Nobody is paid for pumping: hop fees go to the `fee_payee` of
  each hop at settlement, not to the caller. If nobody pumps before the deadline, the next hop stops the route with
  `EXPIRED` and the origin refunds; if the receipt is also stuck, the sender reclaims after the deadline plus
  `RECLAIM_GRACE`. Funds are not lost, but the route fails.
- **Timing.** A pumper chooses when the hop goes out, within the deadline. It cannot change the envelope (hash
  check) or fail the hop by sending too little gas (`MIN_SEND_GAS`, `InsufficientGas`).
- **Cost.** 1.46M to 1.65M gas per pumped step on the reference Service (README gas table, anvil), paid by the pumper.
- **Mitigations in place.** `services/` indexes `ForwardPending` and `OutboxQueued` and serves calldata at
  `GET /pending`; its trigger can submit them on local networks. Routers send directly in the delivery transaction on
  any Service that allows it (`test_forwardsInsideDelivery_andDeductsFee`).
- **What closes it.** A CLPR Service that lets an application call `sendMessage` during dispatch (ADR Appendix A), or a
  funded pumper network per ledger. Until then, integrators and operators must run or contract a pumper.

### R2. Committee keys can redirect quarantined funds or replace the committee (Medium)

Naming a vault recovery address needs k+1 committee signatures and waits `RECOVERY_NOTICE` + `CHALLENGE_WINDOW`.
During that time the deposit's original sender or recipient can challenge, and a challenged deposit is paid out only
by a supermajority override after a further `CHALLENGE_WINDOW`. So k+1 compromised keys can redirect an unchallenged
deposit, and a supermajority can redirect any deposit. Separately, a supermajority can install any committee after
`COMMITTEE_NOTICE`, and k compromised keys can fork a ledger that hasn't yet received the next decision. Such a fork
is visible as differing `headAt` values but cannot be undone on-chain.

A recovery address may be any address that has never been a committee member (past, present or scheduled), the
registry or the vault. Mitigations: namings, challenges and committee schedules are public events (`RecoveryNamed`,
`RecoveryChallenged`, `CommitteeScheduled`) that the services index; the runbook requires published evidence and
legal sign-off before any naming and relays every decision to every ledger at once; integrators compare `headAt`
across ledgers before trusting a pinned version.

### R3. A blacklisted party can delay recovery (Medium, design)

Only a deposit's own sender or recipient can challenge paying that deposit to a recovery address, and a challenge
holds until a supermajority overrides it after one more `CHALLENGE_WINDOW`. When the sender is the exploiter, it can
challenge every naming, so victims who are neither party are paid only by a supermajority. Nobody else can join a
case or block another deposit (audit RV-09 is fixed). This needs the legal review the spec already calls for
(runbook section 9).

### R4. Late receipt after reclaim (Medium, value routes)

`reclaim` is two-phase. The request opens at `deadline + RECLAIM_GRACE × edges of the longest way back` and the
refund another `RECLAIM_GRACE` later; any authentic receipt in between settles the route instead, and reclaim is
blocked while a receipt for the route is held at the origin. A `DELIVERED` receipt that still arrives after the
refund is recorded (`routes(id).late`, `LateReceipt`) but moves no funds: the escrow is already back with the sender
while the destination application acted, and the parties settle off-chain. Set `RECLAIM_GRACE` above the worst-case
receipt latency per edge, including pumping, and keep pumpers running.

### R5. Loose routes after a NACK: anyone chooses the new tail (Low, data routes)

When a loose route's forward is rejected, anyone may call `forward(envelope, newTail)`. The tail must start at this
Router, end at the destination ledger, name only canonical Routers, satisfy the structure rules and pass the checks
of each following hop, but the caller picks the path. It cannot insert a Router that alters the payload or forges the
status receipt; it can choose a slower or more expensive path, or Channels whose verifiers are weaker than the
sender expected (above the route's trust floor, if one is set). Loose routes carry no value
(`ValueRoutesMustBeStrict`).

The envelope's optional `origin_signature` is not checked on-chain and is not passed to the destination application
(`onRouteMessage` does not include it). Applications that need end-to-end signatures must sign inside the payload.

### R6. Hiero proof-source gap (High for live use; not deployable)

Every CLPR verifier in this programme runs chain → Hiero. The Hiero → chain direction has no proof source: block node
v0.38.0 (the version Solo deploys) ships no `ProofService.getStateProof` (HIP-1081) plugin, so no verifier on another
ledger can check Hiero state. The e2e runs use the CLPR repo's `E2EVerifier`, which decodes bundles and checks no
proof, on every leg (`script/e2e/run.sh`, `script/e2e-hiero/run.sh`).

Consequences: a route can reach Hiero but cannot leave it on a live network. Any deployment that wires an
`E2EVerifier` (or any non-verifying stub) on a live Channel would let anyone forge envelopes and receipts over it,
including `DELIVERED` receipts that release escrow. The deployment guide forbids it, and the planner marks
Hiero → chain edges `projected`. This closes when a block node serves state proofs for EVM storage slots and the CLPR
`HieroVerifier` is deployed for those Channels; the Router needs no change.

### R7. Registry lag between ledgers (Low)

A decision applies on a ledger only when someone relays it there. Until then that ledger's Router does not see a
new disable or blacklist entry, and a filtered route pinned to a newer version fails closed there. Mitigation: the
runbook relays every decision to every ledger at once and checks `version()` everywhere.

### R8. k keys can fork a lagging ledger (Low)

Decisions form a hash chain: each one commits to the head it extends, so a ledger can only take the decision that
extends its own head, and two different decisions for one nonce can never both apply on one ledger. A ledger that
has not yet received decision N can still be given a different decision N signed by k keys (a k-threshold action).
Such a fork is visible as differing `headAt` values but cannot be undone on-chain; the forked ledger accepts no
later decision of the others. Mitigation: relay every decision to every ledger at once,
and compare `headAt` (SDK `checkRegistryHeads`, services) before trusting a pinned version.

### R9. Gas parameters are per-ledger constants (Low)

`MIN_SEND_GAS` and `APP_GAS` are immutable. If a ledger's gas schedule changes so that `sendMessage` costs more than
`MIN_SEND_GAS`, hops still cannot be failed by under-funding inside a permissionless `forward` (an out-of-gas inside
the call is detected), but deliveries may defer more often. A new Router deployment is the only fix.

### R10. Vault decisions are bound to one vault (fixed)

Vault decisions are signed over a digest whose domain carries the deployment id, the chain id and the vault's
address (audit RV-04), so a release or naming acts on one vault only. Case ids may still repeat across ledgers;
each vault keeps its own deposits.

### R11. Contract size margin (Low, engineering)

`ClprRouter` is 22,417 B against the EIP-170 limit of 24,576 B (2,159 B margin), built with `optimizer_runs = 200`;
settlement, send construction and receipt reporting live in external libraries. CI fails a build over the limit.

### R12. No confidentiality without filters (Low, by design)

CLPR gives integrity, not confidentiality. A payload without the ISO 20022 or MiCA filter is plaintext on every ledger
the route crosses, not only the two ends.

## 8. Out of scope

- The CLPR Service, verifiers, Connectors and endpoints (`lib/clpr-smart-contracts`), beyond the reentrancy-lock
  behaviour in R1.
- Legal compliance of operators; the filters supply controls, not a licence.
- Per-hop escrow and asset routing (phase 4).
