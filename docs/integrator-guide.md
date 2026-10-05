# Integrator guide

For application developers who send routed messages (and optionally an escrowed payment) through CLPRouter, or
receive them. Read the [threat model](threat-model.md) first if your application moves value.

## 1. Concepts in one table

| Term | Meaning |
| --- | --- |
| Ledger id | CAIP-2 id, for example `eip155:296` |
| Account id | CAIP-10 id, for example `eip155:296:0xabc…` (lower-case hex on EVM) |
| Route | `hops[]` from the origin to the destination. `hops[i]` is the i-th ledger, its Router, and the Channel, Connector and fee for leaving it |
| Route id | 16 bytes, unique per route. Under the ISO 20022 filter it is the UETR |
| Mode | What the planner optimised: `cheapest`, `fastest`, `reliable`, `greenest`, `balanced` |
| Filters | `ISO20022`, `MICA`, `ENERGY`: every ledger on the route must hold the certification |
| Strict / loose | Strict routes cannot change. Loose routes may be re-routed after a rejection, and carry no value |
| Fee budget | `msg.value - escrow`, in the origin ledger's native unit. Hop fees are paid from it at settlement; the rest is refunded |
| Escrow | Part of `msg.value` released to `payee` on `DELIVERED`, refunded otherwise |
| Receipt | A routed message back to the origin: `DELIVERED`, `FAILED`, `EXPIRED` or `QUARANTINED` |

## 2. Send a route

### 2.1 Plan and build the envelope (SDK)

```ts
import { ViemOnChainReader, OnChainGraphSource, StaticJsonSource, plan, buildEnvelope } from "@clprouter/sdk";

const graph = await new OnChainGraphSource(new StaticJsonSource({ file: "graph.json" }), reader).load();
const result = plan(graph, {
  origin: "eip155:31001",
  destination: "eip155:31003",
  mode: "cheapest",
  constraints: { maxHops: 3, deadlineS: 3600 },
});
if (!result.ok) throw new Error(`${result.reason}: ${result.details.join("; ")}`);

const envelope = buildEnvelope({
  plan: result,
  originApp: myApp,                     // the address that will call Router.send
  destinationApp: theirApp,
  sender: `eip155:31001:${myApp.toLowerCase()}`,
  recipient: `eip155:31003:${payee.toLowerCase()}`,
  payload,
  payloadProtection: "plaintext",       // no filter: plaintext is allowed, and public on every ledger crossed
  feeUnit: { nativeUsd: 2500, decimals: 18 },
  registryVersion,                      // ProviderRegistry.version() on the origin; required with any filter
});
```

Check the quote before sending: `result.route.totals` (cost, p90 time, success probability, kgCO2e) and
`result.route.effectiveTrustTier` (the weakest hop). The planner adds no trust; every hop re-checks on-chain.

### 2.2 Call `ClprRouter.send`

`send(SendRequest)` takes the route as a struct, not as encoded bytes. The Router stamps `origin`, `sender`, the
registry versions, `router_version` and the fee budget itself. Map the SDK envelope like this (the SDK does not ship
this mapper yet):

```ts
const MODE = { balanced: 0, cheapest: 1, fastest: 2, reliable: 3, greenest: 4 } as const;
const PAYLOAD = { raw: 0, iso20022: 1, asset: 2 } as const;
const FILTER_BIT = { ISO20022: 1, MICA: 2, ENERGY: 4 } as const;
const TIER = { attested: 0, committee: 1, "light-client": 2, "validity-proof": 3 } as const;
const hop = (h) => ({
  ledgerId: h.ledger_id, router: h.router, channelId: h.channel_id || zero32, connectorId: h.connector_id || zero32,
  fee: h.fee, feePayee: h.fee_payee,
});

const req = {
  destination: { ledgerId: envelope.destination.ledger_id, application: envelope.destination.application },
  recipient: envelope.recipient,
  hops: envelope.hops.map(hop),
  mode: MODE[envelope.mode],
  constraints: {
    filters: envelope.constraints.filters.reduce((m, f) => m | FILTER_BIT[f], 0),
    deadline: envelope.constraints.deadline,
    maxFee: envelope.constraints.max_fee,
    remainingFeeBudget: 0n,                 // ignored: the budget is msg.value - escrow
    trustFloor: TIER[envelope.constraints.trust_floor],
    maxHops: envelope.constraints.max_hops,
    loose: envelope.constraints.loose,
    energyCap: envelope.constraints.energy_cap,
  },
  payloadType: PAYLOAD[envelope.payload_type],
  payload: envelope.payload,
  receiptPath: envelope.receipt_path.map(hop),
  originSignature: envelope.origin_signature,
  routeId: envelope.route_id,              // or 0x00…00 to let the Router generate one
  escrow,                                  // 0n for a data route
  payee,                                   // origin-ledger account paid the escrow on DELIVERED
};
const hash = await wallet.writeContract({
  address: router, abi: ROUTER_ABI, functionName: "send", args: [req],
  value: escrow + envelope.constraints.remaining_fee_budget,
});
```

### 2.3 What `send` checks

`send` reverts, and nothing moves, if any of these fail:

| Check | Error |
| --- | --- |
| `msg.value >= escrow` | `InsufficientValue` |
| Loose route with any value, or escrow with an explicit `receiptPath` or no `payee` | `ValueRoutesMustBeStrict` |
| Route id already used on this Router | `DuplicateRouteId` |
| At least one edge, at most `maxHops` (default 3, cap 8), no ledger twice, `hops[0]` is this ledger and Router, deadline in the future, fees within budget and `maxFee` | `InvalidRoute(reason)` |
| Every edge, ledger and Router not disabled; trust floor met; every filter passes on every ledger | `RouteBlocked(hop, reason)` |
| The first Channel's peer is `hops[1].ledgerId` | `RouteBlocked(0, BAD_ROUTE)` |

If the sender, the recipient or the payee is blacklisted, `send` **succeeds** but forwards nothing: all of
`msg.value` goes to the origin's quarantine vault and the route settles as `QUARANTINED` in the same transaction
(section 4).

### 2.4 After `send`

- The origin emits `RouteSent(routeId, sender, destinationLedger, escrow, feeBudget, deadline, messageId)`.
- On the reference CLPR Service, each intermediate hop and each receipt needs a second, permissionless
  transaction (`forward` or `flush`). Somebody must make those calls before the deadline: you, the services' trigger,
  or a pumper you contract. See the [operator guide](operator-guide.md#4-pumping-pending-hops).
- If no receipt arrives, anyone can call `reclaim(routeId)` after `deadline + RECLAIM_GRACE`. That refunds escrow and
  the whole fee budget to the sender.

## 3. Receive a route

A destination application implements `IClprRouteApplication`:

```solidity
contract MyApp is IClprRouteApplication {
    address public immutable ROUTER; // the CLPRouter on this ledger you trust

    function onRouteMessage(
        bytes16 routeId,
        string calldata originLedger,
        bytes calldata originApplication,
        string calldata sender,
        uint8 payloadType,
        bytes calldata payload
    ) external returns (bytes memory response) {
        require(msg.sender == ROUTER, "not the router");
        // originLedger / originApplication / sender are as strong as every Router and verifier on the route.
        // ...
        return abi.encode(true); // keccak256(response) goes back in the DELIVERED receipt
    }

    function onRouteNotice(bytes16 routeId, bytes32 caseId, string calldata contact) external {
        require(msg.sender == ROUTER, "not the router");
        // a transfer to you is held under a blacklist case; no accusation, only whom to contact
    }
}
```

- Always check `msg.sender` is the Router you trust.
- You get `APP_GAS` gas (a constructor parameter of the Router; 300,000 in the tests). Running out or reverting
  sends a `FAILED` receipt with reason `APPLICATION_ERROR`, and the origin refunds the escrow.
- Do not rely on the envelope's `origin_signature`: it is not passed to you and not checked on-chain. Sign inside the
  payload if you need end-to-end authentication, especially on loose routes (threat model R5).
- The destination never delivers after the deadline.

## 4. Read receipts and outcomes

### 4.1 On-chain, at the origin

| Source | What you get |
| --- | --- |
| `RouteSettled(routeId, status, reason, hopIndex, caseId, contact, feesPaid)` | Final outcome. `status`: 2 DELIVERED, 3 FAILED, 4 EXPIRED, 5 QUARANTINED |
| `routes(routeId)` | Stored route: sender, deadline, status (1 PENDING until settled), escrow, budget |
| `IClprRouteSender.onRouteReceipt(routeId, status, reason, caseId, responseHash)` | Optional callback if the sender is a contract. It gets exactly `APP_GAS` (a settling call with less gas left reverts, so a route never settles without its callback); a revert in the callback is ignored |
| `ReceiptIgnored(routeId)` | A receipt that failed authentication, or arrived after the route settled |
| `owed(account)` + `withdraw()` | Payments the Router could not push (30,000 gas stipend) |

Reasons (`RouteTypes.Reason`): 1 APPLICATION_ERROR, 2 DEADLINE, 3 DISABLED_EDGE, 4 DISABLED_LEDGER, 5 DISABLED_ROUTER,
6 DISABLED_INBOUND, 7 FILTER, 8 FEE_BUDGET, 9 BLACKLIST, 10 NEXT_HOP_ERROR, 11 SEND_FAILED, 12 BAD_ROUTE,
13 TRUST_FLOOR. `DISABLED_EDGE` also covers a Channel direction the provider registry does not approve (at `send`, in
either direction of an edge).

Settlement pays the fee of each hop that forwarded (to its `fee_payee` on the origin ledger) and then:

| Outcome | Escrow | Unused fee budget |
| --- | --- | --- |
| DELIVERED | To `payee` | To the sender |
| FAILED, EXPIRED | To the sender | To the sender |
| QUARANTINED | To the vault | To the vault |

A route already settled cannot settle again. A `DELIVERED` receipt is re-checked against the blacklist at
settlement: a sender or payee listed after `send` turns it into `QUARANTINED`.

### 4.2 Through the services (optional)

`GET /routes/<routeId>` returns hop-by-hop status (`waiting`, `sent`, `forward-pending`, `forwarded`, `rejected`,
`delivered`, `stopped`), the transaction of every event on every ledger, and the outcome, with the block numbers it
was built from. `GET /stream?routeId=<id>` streams updates as server-sent events. Both are convenience views; the
on-chain events are authoritative.

## 5. Handle QUARANTINED

A route is quarantined when the sender, the recipient or the payee is on the provider's blacklist (a CAIP-10 entry
under a case id), at the origin, at any hop, or at settlement.

What you see:

- At the origin: `RouteSettled(…, status = 5, reason = 9 BLACKLIST, …, caseId, contact, …)` and, for contract senders,
  `onRouteReceipt`. The escrow and the unused budget are in the origin ledger's `QuarantineVault`:
  `Deposited(depositId, routeId, caseId, depositor, sender, recipient, amount)`.
- On the ledger where the route stopped: `QuarantineNotice(recipientKey, routeId, recipient, caseId, contact)`, and the
  destination application's `onRouteNotice` if the route stopped at the destination.

What to do:

1. Do not retry the same transfer; it will be quarantined again while the listing is live.
2. Contact the provider at `contact` and quote the `caseId` and `routeId`. The notice makes no accusation.
3. A listing lapses after `BLACKLIST_LAPSE` (30 days recommended) unless renewed. A false positive is fixed by a
   `DELIST` and a vault release to the original sender or recipient.
4. Watch the vault for `RecoveryNamed(caseId, to, releasableAt, …)`. If you are the deposit's sender or recipient
   and object to the recovery address, call `QuarantineVault.challengeRecovery(depositId, evidenceHash)` before
   `releasableAt(depositId)`: the notice and challenge window run from the naming or from your deposit, whichever is
   later. A challenge blocks that address.
5. Funds are released only by a committee decision, and only to the original sender, the original recipient, or an
   unchallenged recovery address; never to a committee member.

Under the ISO 20022 filter, map the receipt with `receiptToPacs002`: `QUARANTINED` becomes a pacs.002 `RJCT` with
reason `RR04` and `AddtlInf` `CASE/<case id>` and `CONTACT/<contact>`. A later vault release to the sender maps to a
pacs.004 with `quarantineReturn`.

## 6. ISO 20022 routes

1. **Plan with the filter.** `plan(graph, { …, filters: { iso20022: true } })`. Every ledger on the route must hold a
   valid ISO 20022 certification and run an identified operated Router. If none qualifies the answer is
   `no-compliant-route`; the planner never falls back.
2. **Read the registry version.** `registryVersion = ProviderRegistry.version()` on the origin ledger. The route pins
   it; every hop checks the next ledger as of that version, so a later uncertification does not stop a route in
   flight. A hop whose registry has not reached that version fails closed with `FILTER`.
3. **Build the payload.** Use `@clprouter/sdk/iso20022`:

   ```ts
   import { buildIsoEnvelope, assertNoClearPersonalData, openIsoPayload, receiptToPacs002 } from "@clprouter/sdk/iso20022";

   const { envelope } = buildIsoEnvelope(
     { plan: isoPlan, originApp, destinationApp, sender, recipient, feeUnit, registryVersion },
     { message: pacs008, recipientPublicKey: destinationBankX25519Key }, // or { delivery: "off-chain" }
   );
   assertNoClearPersonalData(envelope); // throws on any clear personal data outside the ciphertext
   ```

   The route id is the payment's UETR (UUIDv4). The payload is a `ClprIsoPayload`: the UETR, amount, currency and two
   salted commitments in clear; the XML and the travel-rule data encrypted to the destination institution's X25519
   key (XChaCha20-Poly1305), or delivered off-chain with only the commitments on-chain.
4. **Send** with `payloadType = 1` (`ISO20022`) and the `ISO20022` filter bit.
5. **Status.** Each `RouteForwarded` hop maps to pacs.002 `ACSP` (`hopAcceptedStatus`). The receipt maps with
   `receiptToPacs002`: `DELIVERED` → `ACCC`; `EXPIRED` → `RJCT AB05`; `QUARANTINED` → `RJCT RR04`; `FAILED` → `RJCT`
   with `AB07` (disables), `AB09` (application error), `AB10` (next hop or send failure), `AGNT` (filter or trust
   floor), `AM04` (fee budget), `FF02` (bad route), `NARR` otherwise.
6. **At the destination institution.** `openIsoPayload(envelope, secretKey)` checks the key id, decrypts, verifies both
   commitments, re-validates the XML, and checks UETR, amount and currency against the clear header and `route_id`.
7. **Follow-ups.** camt.056 (cancellation), camt.029 (resolution) and pacs.004 (return) are new routes with a fresh
   UETR as route id and the payment's UETR as `original_uetr`, because a Router never accepts a route id twice.

MiCA works the same way with `filters: { mica: true }`. The builder refuses plaintext, and refuses assets that are not
MiCA-authorised e-money or asset-referenced tokens (a USDT transfer is refused).

## 7. Checklist before mainnet use

- [ ] Every Channel on your routes has a real verifier. Routes cannot leave Hiero on live networks yet (threat model R6).
- [ ] Both directions of every Channel on your routes are approved in the provider registry
      (`ProviderRegistry.channelApproval(edgeKey(channelId, toLedgerId))`), naming the verifier you expect; Routers
      carry nothing over a direction without an approval, and `send` refuses such a route.
- [ ] You pick Router deployments you recognise (the published addresses of a released version), and your destination
      application accepts only its own ledger's Router.
- [ ] Someone pumps `forward` / `flush` on every intermediate ledger before your deadline, and can flush a queued
      receipt over another Connector of its Channel if the route's own Connector refuses it.
- [ ] `deadline` leaves room for every hop's finality, bundle cadence and pumping; `RECLAIM_GRACE` on your origin
      Router covers the receipt's return.
- [ ] Value routes are strict (the Router enforces it) and have a `payee`.
- [ ] If you set an on-chain `trust_floor` above 0, every edge on the route is labelled at or above it.
- [ ] Without a filter, your payload is public on every ledger crossed.
