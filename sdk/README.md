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
  payload: uetrHashOfPacs008, // under ISO 20022: a hash or ciphertext only (see "ISO 20022 module")
  payloadProtection: "hash",
  feeUnit: { nativeUsd: 0.3, decimals: 7 },
  registryVersion, // ProviderRegistry.version() on the origin ledger; required when a filter is on
  // trustFloor: "light-client", // opt-in on-chain floor; the default is 0 (see "Trust floor")
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

`PlanSuccess` also carries `pareto`, `fallback`, `plannedAt` (the time certifications were judged at, not a registry
version), `energyCapKgPerTx` and `warnings`.

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
- `filter_registry_versions` pins each active filter to `registryVersion`: `ProviderRegistry.version()` on the origin
  ledger, a counter of registry decisions (read it with `ViemOnChainReader`, `RegistryState.version`). It is
  required when any filter is on, and mirrors what the origin Router stamps at `send`; every hop checks the next
  ledger against the registry as of that version.
- `energy_cap` is in µgCO2e per transaction (the registry's unit); `energyCapKgPerTx` is converted and rounded up.
- Routing mode: Routers accept loose routing only for routes that carry no value, i.e. no asset and no fee budget
  (every hop fee zero), because receipts of loose routes cannot be checked against the stored hop-list commitment.
  The builder defaults to loose only for such routes and to strict otherwise; asking for loose with fees or assets
  is refused.
- `trust_floor` defaults to 0 (`attested`); see below.
- `receipt_path` is empty (reverse hops) unless you pass `receiptPath: "reverse"`.

### Trust floor: decentralised by default

The planner ranks and filters routes by verifier trust tier from the graph (`constraints.trustFloor` in
`plan`, the `reliable` mode's success model, and `route.effectiveTrustTier` in every quote). That is off-chain and
needs nobody's permission.

On-chain, every Router can also enforce `constraints.trust_floor`: for a floor above 0 it requires the provider's
`TRUST_TIER` label on each next edge (Channel direction) at or above the floor, and fails the hop with
`TRUST_FLOOR` when the edge is unlabelled or labelled lower. **The SDK's default on-chain floor is 0**
(`DEFAULT_ONCHAIN_TRUST_FLOOR = "attested"`), at which Routers skip the check and never read provider labels, so a
default route does not depend on the provider. A sender opts in explicitly with
`buildEnvelope({ ..., trustFloor: "light-client" })`, and should do so only when every edge of the route is
labelled; the builder still refuses a floor above the route's effective tier.

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
  - The registry stores emissions in µgCO2e per transaction; `version()` is its decision counter, and
    `trustTier(edgeKey)` gives the provider's TRUST_TIER label per Channel direction.

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

## ISO 20022 module

`@clprouter/sdk/iso20022` (`src/iso20022/`) implements the ISO 20022 filter's payload rules (phase 3).

```ts
import { buildIsoEnvelope, openIsoPayload, receiptToPacs002, paymentReference, assertNoClearPersonalData } from "@clprouter/sdk/iso20022";

const { envelope } = buildIsoEnvelope(
  { plan: isoPlan, originApp, destinationApp, sender, recipient, feeUnit, registryVersion },
  { message: pacs008, recipientPublicKey: destinationBankX25519Key }, // or delivery: "off-chain"
);
assertNoClearPersonalData(envelope);                       // before Router.send
const { message, travelRule } = openIsoPayload(envelope, bankSecretKey); // at the destination institution
```

**Messages.** Models and XML for the CBPR+ versions: pacs.008.001.08, pacs.009.001.08, pacs.002.001.10,
camt.056.001.08, pacs.004.001.09 and camt.029.001.09 (one transaction per message). `toXml` validates and writes
elements in XSD order; `fromXml` detects the message from the namespace and is strict: it rejects DOCTYPE/ENTITY
declarations, unknown or repeated elements, and anything that fails validation. XML goes through `fast-xml-parser`.
Validation covers required elements, lengths, FIN-X references, ISO 3166 countries, BIC (ISO 9362), LEI (ISO 17442
check digits), IBAN (mod 97), active ISO 4217 currencies, amounts (positive, ≤ 14 digits, fraction digits ≤ the
currency's minor units), ISODateTime with an offset, UUIDv4 UETRs, structured postal addresses only (`TwnNm` and
`Ctry` required, no `AdrLine`), BICFI for instructing and instructed agents, and the travel-rule minimum for the
debtor (name plus a structured address or an identification, and an account).

**UETR.** `generateUetr`, `isUetr`, `uetrToRouteId` and `routeIdToUetr`. For a pacs.008 or pacs.009 the payment's
UETR is the envelope `route_id`. Follow-ups (camt.056, pacs.004, camt.029) are new routes. They get a fresh UETR as
their route id and carry the payment's UETR as `original_uetr`, because Routers never accept a route id twice.

**Envelope binding.** The payload is a `ClprIsoPayload` protobuf header. In clear it holds the version, the message
definition, the UETR (and original UETR), the amount and currency, and two salted keccak256 commitments: one to the
XML and one to the canonical travel-rule JSON (originator, beneficiary, accounts and agents). Two delivery modes:

- `encrypted` (default): the XML, the salt and the travel-rule data are sealed to the destination institution's
  X25519 key. The scheme is X25519 → HKDF-SHA256 (salt = ephemeral key ‖ recipient key) → XChaCha20-Poly1305, with a
  fresh ephemeral key per message. Header fields 1–10 are the AEAD's associated data, so changing the UETR, amount,
  currency, commitments or key id breaks decryption. XChaCha was chosen over RFC 9180 HPKE because its 192-bit nonce
  can be random with no counter state. The KDF still binds both public keys, as HPKE's DHKEM does. The primitives
  come from `@noble/ciphers`, `@noble/curves` and `@noble/hashes`.
- `off-chain`: the header carries hashes only. The endpoints deliver `{ xml, salt, travelRule }` off-chain, and
  `verifyOffChainDelivery` checks it against the on-chain commitments.

The random salt makes the commitments hiding, so an observer who knows the UETR and amount cannot confirm a guessed
name. `openIsoPayload` checks the key id, decrypts, verifies both commitments, re-validates the XML, and checks that
the message's UETR, amount and currency match the clear header and the envelope's `route_id`.

**Receipts ↔ pacs.002.** `encodeRouteReceipt` and `decodeRouteReceipt` handle `ClprRouteReceipt` byte for byte
with the Solidity codec. Receipts no longer carry the hop list: the origin stores a hop-list commitment at send, and
a receipt from hop k carries `route_edge` (field 10, the edge digest of hop k) and `route_rest` (field 11, the
commitment to the hops after k, zero at the destination), plus `route_prefix` (field 9, hops before k) only when it
did not travel the reverse route. `edgeDigest`, `hopsCommitment` and `receiptCommitment` mirror `RouteLogic`, so an
off-chain watcher can verify a receipt the way the origin Router does. A DELIVERED receipt with a non-zero
`route_rest` is refused (it did not come from the destination).
`hopAcceptedStatus` gives ACSP for each `RouteForwarded` hop. `receiptToPacs002` maps receipts as follows:

| Receipt | pacs.002 |
| --- | --- |
| `DELIVERED` | ACCC |
| `EXPIRED` | RJCT AB05 |
| `QUARANTINED` | RJCT RR04, with `AddtlInf` `CASE/<case id>` and `CONTACT/<provider contact>` |
| `FAILED` | RJCT with `REJECT_REASON_CODES[reason]`: AB07 for disables, AB09 for an application error, AB10 for next-hop or send failures, AGNT for a filter or trust-floor failure, AM04 for the fee budget, FF02 for a bad route, NARR otherwise |

`pacs002Outcome` reads a pacs.002 back into a Router outcome.

**Cancellation and return.**

- `cancellationRequest` builds a camt.056.
- `resolveCancellation` builds a camt.029: `CNCL`/`ACCR`, or `RJCR` with a reason.
- `returnPayment` builds a pacs.004. The return chain is reversed, and the reason is `FOCR` when it answers a camt.056.
- `quarantineReturn` builds a pacs.004 with RR04 and the case id, for a vault release to the sender.

Before settlement no pacs.004 is needed: the origin Router refunds the escrow on the failure receipt.

**No personal data in the clear.** `findClearPersonalData(envelope)` and `assertNoClearPersonalData` check every
field outside the ciphertext:

- ledger ids must be CAIP-2;
- `sender` and `recipient` must be CAIP-10, in an address format that fits their namespace;
- binary fields must have the expected size and must not decode to text;
- an `iso20022` payload must be a strict `ClprIsoPayload`: no unknown or repeated fields, no readable "ciphertext";
- a receipt's contact must be a URL, an e-mail address or a CAIP-10 account.

Each violation names the field and what leaked: free text, an account identifier (IBAN), ISO XML, plaintext or an
unknown field. CAIP-10 addresses are checked for format only, which is how the spec allows them in clear.
