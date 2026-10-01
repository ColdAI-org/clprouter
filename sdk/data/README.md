# Measured route data

The CLPRouter route graph built from our verifier results on the `pr/*` branches of `clpr-smart-contracts`
(chain pages in `docs/chains/*.md`, chain indexes in `docs/chains/README.md`, verifier READMEs under
`src/verifiers/`).

| File | What it is |
| --- | --- |
| `chains.json` | One record per chain page (86): CAIP-2 id, verifier family, trust tier (verbatim text plus the SDK tier and why), status (live-verified, family-covered, in progress, blocked, with reason), typical bundle gas and calldata (per transaction when a bundle takes several), rotation gas and calldata, catch-up figures, multi-transaction needs, finality time and bundle cadence where stated, and the Hiero → chain section. Every number carries `source` as `branch:file#Lline` and the quoted text. Missing figures are `null` with a `reason`. |
| `edges.json` | A `RouteGraphData` snapshot the SDK loads directly: `new StaticJsonSource({ file: "data/edges.json" })`. Hedera plus every chain that has a CAIP-2 id and a bundle figure. Chain → Hiero edges are `active` for live-verified and family-covered chains and `projected` for chains in progress (or with a named blocker, such as Chainflip with no CLPR pallet or Cardano mainnet). Every Hiero → chain edge is `projected`: that direction is blocked until a Hiero state-proof source exists. |

Rebuild both from the branches (needs the branches locally):

```sh
node scripts/build-route-data.mjs [path/to/clpr-smart-contracts]
```

The default path is `$CLPR_CONTRACTS_REPO`, or `../../clpr-smart-contracts` from `sdk/`. The output is
deterministic for the same branch heads; the branch SHAs are recorded in both files.

## How to read the figures

- **Bundle gas** is the total gas for one bundle on Hiero, summed over all its transactions (accumulators, cache
  transactions). Ranges are taken at their upper bound. KB is read as 1,000 B.
- **`bundle.basis`**: `live-mainnet`, `live-testnet` (testnet, regtest or local network), `live-partial` (only part
  of a bundle was measured, e.g. the L1 half of an OP Stack proof), `family-proxy` (same verifier code, measured on
  another chain), `synthetic` or `estimate`. In `edges.json` only the first three count as `measured`.
- **Trust tier** maps the verbatim text onto the SDK's four tiers. Anything that reads Ethereum through the sync
  committee (L2s, Ethereum twins) is `committee`; chains whose message content is decided by k-of-n operators or
  attestors (Canton, Hyperliquid, Mixin, XRPL outbox, a single Clique key) are `attested`.
- **Hedera gas price** comes from the measured Ethereum bundle on Hedera testnet
  (`test/e2e/fixtures/sepolia-live/hiero-gas-hedera-testnet.json`: 1,645,052 gas charged 1.58 HBAR).

## What is not measured

Everything listed in an edge's or ledger's `synthetic` array is a placeholder so the planner can run: Connector
margins and balances, Channel history, maximum payload, off-chain energy, proof-generation and verification time,
finality and cadence where the sources do not state them, ledger token prices and enqueue/execution gas, and all
Hiero → chain figures. Ledgers that also appear in `src/data/sample-graph.json` keep that file's placeholder
economics and provisional certifications; the others use uniform placeholders.
