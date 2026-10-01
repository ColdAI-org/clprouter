# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Contract versions are also named by `ClprRouter.VERSION`; a new value is a new on-chain deployment.

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/clprouter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/clprouter/releases/tag/v0.1.0
