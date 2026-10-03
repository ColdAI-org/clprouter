# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Contract versions are also named by `ClprRouter.VERSION`; a new value is a new on-chain deployment.

## [Unreleased]

### Added

- **Settle on Hedera** (`src/settle/`): `SettleOrderBook` on Hedera holds Connector bonds (HBAR or HTS tokens),
  opens orders from proven deposits, closes them on proven deliveries and pays the user cover + penalty from the
  bond on a missed deadline; `SettleDeposit` and `SettleDelivery` prove payments chain → Hedera over CLPR;
  `ISettlePaymentProver` for chains without a CLPR Service. Unit, fuzz, invariant and three-ledger tests
  (`test/settle/`), the anvil end-to-end run `script/settle-e2e/run.sh` with Hedera trace-size checks, the reference
  Connector service (`services/connector`), `docs/settle-on-hedera.md` and threat-model section 8.

## [0.2.0-pre] - 2026-10-01

Fixes every finding of the two internal audits (`docs/audit/router-findings.md`,
`docs/audit/registry-vault-findings.md`); each finding has a regression test. Not for real funds: an independent
re-audit is in progress.

### Breaking changes

- **Routers are deployed only through `ClprRouterDeployer`** at each ledger's canonical CREATE2 address. The
  `ClprRouter` constructor takes no arguments (it reads `IClprRouterDeployer.Params`), and every Router a route,
  receipt path or loose tail names must be canonical (`NonCanonicalRouter`). Non-EVM ledgers fail closed.
- **Route ids are derived by the origin Router** from (ledger, Router, sender, nonce). `SendRequest.routeId` is
  removed and `send` returns the id; `nonces(sender)` predicts it. Receipt ids use their own tag. Hop state and
  replay are keyed by (origin ledger, origin Router, id), so `hopState(key)` takes that key, not the route id.
- **`iso_uetr`** (envelope field 16, `SendRequest.isoUetr`) carries the ISO 20022 UETR; it is no longer the route id.
- **Canonical envelope encoding only.** `RouteCodec` (and the SDK's `decodeEnvelope`) reject over-long varints,
  explicit defaults, repeated singular fields, unknown fields and wrong wire types; `encode(decode(b)) == b`.
- **Events and types live in `IClprRouter`.** `RouteForwarded` carries `key` and `data`; `ReceiptUndeliverable` is
  replaced by `ReceiptRequeued`; new `ReclaimRequested` and `LateReceipt`. `routes(id)` returns `held`, `late`,
  `reclaimAt` and `pathHash` as well.
- **Receipts are never dropped.** Unsendable or rejected receipt messages wait in the outbox for `flush`; receipts
  over a disabled edge, ledger or Router are held and completed by `forward` once the disable lapses.
- **Two-phase `reclaim`:** a request after `deadline + RECLAIM_GRACE` per edge of the way back, the refund
  `RECLAIM_GRACE` later; a receipt in between settles the route, a later one is recorded as `late`.
- **Routes with a `receipt_path` carry no value**, and their receipts must travel exactly that path.
- **Payments** use a bounded call that copies no return data (failures credit `owed`); destination responses are
  hashed up to `MAX_RESPONSE` bytes; the blacklist also screens the destination application.
- **`ProviderRegistry` constructor** is `(deploymentId, members, k, contact, uint64[6] notices)` with enforced
  minimum notices, including the new `COMMITTEE_NOTICE`.
- **Decision digests changed.** EIP-712 domain (name, version `"2"`, salt = deployment id); every decision commits
  to the head it extends (`prevHead`), so decisions form a hash chain (`headAt`, `head()`). `validUntil` is no
  longer enforced for ordered registry decisions; `effectiveAt` is capped at `MAX_NOTICE`. Earlier signatures and
  drafts are invalid (the 43 `registry-data/` drafts are regenerated).
- **Thresholds.** Committee changes need a supermajority (max(k + 1, ⌈2n/3⌉)), are scheduled and take effect after
  `COMMITTEE_NOTICE` when the new committee signs its first decision; committees keep n ≥ 3, 2 ≤ k, k > n/2,
  k + 1 ≤ n. `DELIST` needs k + 1.
- **`QuarantineVault`:** decisions are signed over the vault's own digest (deployment, chain id, vault address);
  `bindRouter` (k + 1, once) limits deposits to the ledger's Router; naming a recovery address needs k + 1;
  challenges are per deposit and address, only by that deposit's sender or recipient, and survive renaming; a
  challenged recovery is paid only by a supermajority `RECOVERY_OVER_CHALLENGE` release after a further
  `CHALLENGE_WINDOW`; `effectiveAt` is honoured; the constructor enforces minimum windows.
- **SDK** (`@clprouter/sdk`): `buildEnvelope` takes no route id (`deriveRouteId`, `deriveReceiptId`, `inboundKey`
  mirror the Router); `isoUetr` / `envelopeUetr`; `uetrToRouteId` / `routeIdToUetr` become `uetrToBytes` /
  `bytesToUetr16`; `makeReceipt` takes a route id; `canonicalRouterAddress`; bare EIP-155 ids are normalised to
  CAIP-2.
- **Services:** regenerated ABIs; hop state is followed by inbound key; the registry fold tracks the head hash,
  scheduled committees and per-deposit challenges.
- **Licence:** every source file, the SDK and the services are MIT (the CLPR submodule keeps its own licence).
- **Container image** is built from `services/Dockerfile`; `.github/docker/` is removed.

### Added

- SDK `checkRegistryHeads` (exported from the package entry point) and `RegistryState.headHash`: check that every
  ledger of a route holds the same registry head at the pinned version.
- e2e drivers deploy through `ClprRouterDeployer` and bind each vault to its Router.

## [0.1.0] - 2026-10-01

First release: phase 1 of the CLPRouter build plan, for local networks and testnets.

### Added

- `ClprRouter` (`VERSION = 1`): immutable, no admin key, no pause. `send` with escrow and fee budget; forwarding
  inside CLPR application delivery with a permissionless `forward` / `flush` fallback for Services that guard
  `sendMessage` with their reentrancy lock; delivery to `IClprRouteApplication`; `DELIVERED`, `FAILED`, `EXPIRED` and
  `QUARANTINED` receipts as routed messages back to the origin; settlement of hop fees, escrow and refunds; `reclaim`
  after the deadline plus a grace period; strict and loose routing (loose routes carry no value).
- Route checks at send and at every hop: structure, loops, hop limits, deadline, fee budget and `max_fee`, route
  safety (disabled edges, ledgers, Router deployments and versions), blacklist, ISO 20022 / MiCA / Energy filters at
  a pinned registry version, and an opt-in on-chain trust floor (default 0).
- `MIN_SEND_GAS` guard: an under-funded permissionless `forward` reverts and leaves the hop pending.
- Receipts carry a hop-list commitment instead of the hop list.
- `ProviderRegistry`: append-only, admin-less register of k-of-n committee decisions (certify, uncertify, trust-tier
  labels, disable, enable, blacklist, delist, committee, contact) relayable by anyone on any ledger; decision counter
  `version`; notice and lapse periods; emissions in µgCO2e per transaction.
- `QuarantineVault`: per-ledger vault with fixed release rules (original sender, original recipient, or a recovery
  address after notice and challenge window; never a provider account).
- `ClprRouteEnvelope` / `ClprRouteReceipt` protobuf schema and Solidity codec, with cross-checked test vectors.
- Planner SDK `@clprouter/sdk` 0.1.0: route graph, Yen k-shortest paths, five modes, filters, quotes with emissions,
  envelope builder, on-chain graph source, and the ISO 20022 module (pacs.008/009/002, camt.056/029, pacs.004,
  encryption to the destination institution, personal-data checks).
- Services 0.1.0: event indexer, route status API, quote service and forward trigger (test keys, local networks).
- Certification evidence and draft decisions for the ISO 20022, MiCA and Energy filters (`registry-data/`).
- End-to-end runs over three anvil chains and through a local Hiero (Solo) network.
- Release engineering: CI (forge fmt, build with size limits, tests, fuzz and invariant profiles, coverage, slither,
  SDK and services checks), nightly e2e, dependency audit, CodeQL, and a release workflow that builds the contract
  artefacts, the SDK package and the services image with SBOMs and provenance attestations.
- Documentation: threat model, integrator guide, operator guide, provider-committee runbook, deployment guide,
  audit-readiness pack.

### Known limitations

- Each intermediate hop takes a second, permissionless transaction on the reference CLPR Service.
- No Hiero state-proof source yet: routes cannot leave Hiero on live networks; e2e legs use a non-verifying stub.
- Per-hop escrow and asset routing are phase 4.

[Unreleased]: https://github.com/OWNER/clprouter/compare/v0.2.0-pre...HEAD
[0.2.0-pre]: https://github.com/OWNER/clprouter/compare/v0.1.0...v0.2.0-pre
[0.1.0]: https://github.com/OWNER/clprouter/releases/tag/v0.1.0
