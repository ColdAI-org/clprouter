# CLPRouter planner SDK

TypeScript route planner for CLPRouter (phase 1 of the build plan in `clprouter-spec.md`). It runs on the
sender's side. It reads the route graph, picks a route for a **mode**, applies compliance **filters** and
constraints, quotes the route, and builds the `ClprRouteEnvelope` the origin Router sends.

The planner adds no trust. Every hop's Router re-checks the constraints on-chain, so a bad quote can make a route
fail, but it cannot redirect funds.

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # emits dist/
```

## Quick start

```ts
import { buildEnvelope, encodeEnvelope, plan, sampleGraph } from "@clprouter/sdk";

const result = plan(sampleGraph(), {
  origin: "stellar:pubnet",
  destination: "hedera:mainnet",
  mode: "fastest",
  filters: { iso20022: true, mica: true },
  constraints: { maxHops: 3, deadlineS: 600, trustFloor: "light-client" },
});

if (!result.ok) throw new Error(`${result.reason}: ${result.details.join("; ")}`);
console.log(result.route.ledgers, result.route.totals, result.route.effectiveTrustTier);

const envelope = buildEnvelope({
  plan: result,
  originApp: "0x…",
  destinationApp: "0x…",
  sender: "stellar:pubnet:G…",
  recipient: "hedera:mainnet:0x…",
  payload: uetrHashOfPacs008, // under ISO 20022: a hash or ciphertext only
  payloadProtection: "hash",
  feeUnit: { nativeUsd: 0.3, decimals: 7 },
});
const bytes = encodeEnvelope(envelope); // proto3, for Router.send
```

## Route graph

Nodes are ledgers, named by CAIP-2 id (`Ledger`). Edges are Channel directions (`Edge`). Each edge carries:

| Field | Meaning |
| --- | --- |
| `verifierFamily`, `trustTier` | `attested` < `committee` < `light-client` < `validity-proof` |
| `finalized` | The verifier checks finalized state (used by `finalizedOnly`) |
| `timing` | p90 seconds: source finality, bundle cadence, proof generation, verification |
| `bundle` | `verifyBundle` gas and calldata, messages per bundle, optional measured native cost |
| `connectors` | Margin (USD), balance (USD), success rate |
| `status`, `history`, `disabled` | `active`, `paused`, `closed` or `projected`; delivery history; provider disable |
| `maxPayloadBytes` | Checked against payload plus the envelope overhead |
| `offChain` | Proof and relay energy (kWh per bundle) and the grid intensity (kgCO2e/kWh) |

Ledgers carry gas price, native USD price, enqueue and execution gas, average transaction gas (to weight
emissions by gas used), certifications (`ISO20022`, `MICA`, `ENERGY` with the kgCO2e-per-transaction figure
and its source), the operated Router (identity, jurisdiction, CASP status), the Router version and a `disabled`
flag. Every number has a `source` or is listed in the object's `synthetic` array.

## Planner

`plan(graph, request)`:

1. **Pre-filter.** It drops every ledger that fails a filter or is disabled, excluded, in an excluded
   jurisdiction, or running a disabled Router version. The origin and the destination are checked too. If either
   one fails, the answer is `no-compliant-route` (with filters on) or `no-route`.
2. **Eligible edges.** An edge must be `active` (`projected` too with `allowProjected`), not disabled, at or
   above the trust floor, finalized if `finalizedOnly` is set, large enough for the payload, and have a Connector
   whose balance covers delivery.
3. **Search.** Yen's k-shortest simple paths run once per objective: cost, p90 time, −log success and kgCO2e.
   Each run keeps the first `k` paths (default 8) that meet the path constraints: max hops (default 3), deadline
   and max fee. Yen lists paths in weight order, so the first valid path is exactly optimal for its objective.
   No route visits a ledger twice.
4. **Pareto set.** The planner keeps the non-dominated candidates over (cost, time, failure probability, kgCO2e).
5. **Mode picks.**

| Mode | Picks | Ties |
| --- | --- | --- |
| `cheapest` | Lowest total USD: Connector margin + enqueue gas + bundle share + execution gas | time |
| `fastest` | Lowest p90 time | cost |
| `reliable` | Highest success probability, plus a disjoint `fallback` route (node-disjoint if one exists, else edge-disjoint) | cost |
| `greenest` | Least kgCO2e | cost |
| `balanced` (default) | Lowest min-max-normalised weighted score from the Pareto set (`balancedWeights`, default cost 0.3, time 0.3, reliability 0.2, carbon 0.2) | key |

**Hop success probability.** The planner multiplies five factors: the Laplace-smoothed Channel history, a
penalty for pauses, a trust-tier factor (proof-verified tiers preferred), the Connector's success rate, and a
penalty when the Connector is thinly funded. In `reliable` mode the planner picks the Connector with the best
track record. In every other mode it picks the lowest margin.

**Greenest.** Per hop, emissions are the transactions needed times the emissions per transaction, plus off-chain
energy. The transactions needed are the enqueue on the sending ledger plus this message's share of the bundle and
its execution on the receiving ledger. Both are gas-weighted against the network's average transaction. The
off-chain part is kWh per bundle ÷ messages × grid intensity. Each figure is resolved in this order: an ENERGY
certification, then the MiCA disclosure, then the **highest certified figure on the graph**. A network on that last
fallback is listed in `emissions.uncertifiedLedgers` and gets a warning. Under `greenest` + `MICA`, the figure must
come from the MiCA disclosure.

**Filters** are hard rules on every ledger the route touches:

| Filter | Ledger must have |
| --- | --- |
| `iso20022` | A valid ISO 20022 certification (provisional counts) and an identified operated Router |
| `mica` | A valid MiCA certification and an operated Router run by an authorised CASP |
| `energy` / `{ capKgPerTx }` | A valid ENERGY certification with a figure, at or below the cap |

A certification is valid if it is not revoked and has not expired at `request.now`. With no filters, the
planner never reads certifications.

## Quotes

`RouteQuote` gives:

- **Per hop:** cost broken down into margin, enqueue, bundle share and execution; p90 time; success probability;
  kgCO2e on-chain and off-chain, with the emissions figures used; the Connector chosen; trust tier.
- **Totals:** cost, time, success (the product of the hops) and kgCO2e.
- **Effective trust tier:** the weakest hop.
- **Emissions sources:** per ledger, with the data source and date.
- **Synthetic figures:** every placeholder the quote relies on.

`PlanSuccess` also carries `pareto`, `fallback`, `plannedAt`, `filterRegistryVersions` and `warnings`.

## Envelope

`buildEnvelope` fills `ClprRouteEnvelope` as defined in `proto/clprouter/v1/route_envelope.proto`:

- **IDs and ends:** `route_id`, `origin`, `destination`, `sender`, `recipient`.
- **Route:** `hops[]`, where `hops[i]` is the i-th ledger and the Channel, Connector and fee for leaving it.
- **Position and choice:** `hop_index`, `mode`, `constraints`.
- **Payload:** `payload_type`, `payload`.
- **Rest:** `receipt_path`, `origin_signature`, `filter_registry_versions`, `router_version`.

`encodeEnvelope` and `decodeEnvelope` are a proto3 codec that follows the Solidity `RouteCodec` wire rules.

Rules the builder enforces:

- The sender is on the origin and the recipient on the destination (CAIP-10).
- Under ISO 20022:
  - `route_id` is a UUIDv4 and serves as the UETR (`envelopeUetr`).
  - `payload_type` is `iso20022`.
  - The payload is a 32-byte hash or ciphertext, never plaintext.
- Under MiCA:
  - No plaintext.
  - Assets must be EMTs or ARTs, so a USDT transfer is refused.
- Fees: each hop's USD quote becomes origin-native smallest units, rounded up. The fee budget is the larger of
  `maxFeeUsd` and the summed hop fees.
- `filter_registry_versions` pins each active filter to the planning time. The `ProviderRegistry` is versioned by
  effective time (`certificationAt(key, asOf)`).
- Routing mode: strict for assets, loose for data.
- `receipt_path` is empty (reverse hops) unless you pass `receiptPath: "reverse"`.

`signEnvelope` and `recoverEnvelopeSigner` implement the optional origin signature: EIP-191 over the
keccak256 of the encoded envelope at hop 0 with the full budget. The signature stays valid as `advanceEnvelope`
moves `hop_index` and spends the budget.

## Graph sources

- `StaticJsonSource`: a JSON object, a JSON string or `{ file }`.
- `OnChainGraphSource(base, reader)`: overlays live state on a base snapshot. The live state is Channel status,
  Connector balances (native × USD) and slash counts, certifications, and disabled ledgers, edges and Router
  versions.
- `OnChainReader` is the interface. Implement it over RPC, an indexer, or a mock.
- `ViemOnChainReader` implements it for EVM ledgers:
  - `IClprService.getChannel` (status from the static head) and `getConnector`, plus the connector contract's
    balance.
  - `ProviderRegistry.certificationLog` and `isDisabled`, keyed with `registryKeys`, which mirror `Caip.sol`.
  - The registry stores emissions in gCO2e per transaction.

## Sample graph

`sampleGraph()` (`src/data/sample-graph.json`) holds 11 ledgers and their chain → Hiero Channels. The bundle gas
and calldata are **measured**: each edge's `bundle.source` cites the verifier README on its branch.

| Edge | Bundle |
| --- | --- |
| Ethereum → Hiero | 1,645,052 gas, 19,140 B, **1.58 HBAR** on Hedera testnet. Hedera's gas price is derived from this. |
| BSC | 1,953,408 gas |
| Avalanche | 1.74M gas |
| Cronos | 7.84M gas |
| Plasma | 3,320,812 gas |
| Canton | 66,260 gas for 3 messages |
| Stellar | 2.21M gas, testnet |
| Bitcoin | 192,050 gas for 3 messages |
| Solana | 429,023 gas |

Everything else is **synthetic** and listed in each object's `synthetic` array: prices, timings, Connectors,
history, emissions figures (not yet imported from the MiCA white papers), operated Routers and off-chain energy.

XRPL → Hiero is `paused`. Hiero → chain edges are `projected` because they are blocked today, so chain → chain
routes need `allowProjected: true`.
