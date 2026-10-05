# FAQ

### Is CLPRouter part of CLPR or LF Decentralized Trust?

No. CLPRouter is an independent, MIT-licensed application built on [CLPR](https://github.com/LFDT-CLPR) and
maintained by ColdAI ([GOVERNANCE.md](../GOVERNANCE.md)). We have proposed it to the CLPR maintainers as a possible
lab or reference application ([lfdt/briefing.md](lfdt/briefing.md)).

### Does it change the CLPR protocol?

No. It calls `sendMessage` and receives application deliveries like any CLPR application. The CLPR reference
contracts are a submodule that this repository never modifies. Changes we think CLPR would benefit from are written
up as proposals ([`proposals/`](proposals)) for the CLPR project to decide.

### What does it add on top of CLPR?

Multi-hop routing: a message (and optionally an escrowed payment) travels Router to Router across several Channels,
every hop re-checks the sender's rules, a receipt returns to the origin, and the origin settles or refunds. Plus route
selection (five modes), compliance filters (ISO 20022, MiCA, Energy) and Settle on Hedera. See the
[technical reference](technical-reference.md).

### Why route through a hub instead of opening more Channels?

Every Channel needs a verifier in each direction and someone to operate it. A full mesh of 100 ledgers is 4,950
Channels; a hub topology is 100. Hiero is a natural hub because it can host verifiers for many ledgers.

### Does a route trust anything a direct Channel does not?

Each hop is verified by that Channel's CLPR verifier, exactly as a direct message would be, and nothing is accepted
without it. A route is as strong as its weakest hop, and the Routers on the path are part of it: they are immutable,
admin-less and must sit at their canonical CREATE2 addresses, so every envelope was built by Router code. The
[threat model](threat-model.md) lists what remains.

### Who can stop or redirect a route?

Nobody can redirect one. The provider committee (k of n, public, signed decisions) can disable a Channel direction,
a ledger or a Router version (k + 1 signatures, lapses after 7 days unless renewed) and blacklist an account after an
exploit (k + 1, lapses after 30 days). A blacklisted party's routed funds go to the quarantine vault, which pays only
the original sender, the original recipient, or a recovery address named after a public notice and challenge window,
never a committee account. Routes in flight pin the registry version, so certification changes cannot reach them.

### What happens if a hop fails or a route expires?

The hop that stops the route sends a `FAILED`, `EXPIRED` or `QUARANTINED` receipt back, and the origin refunds or
quarantines the escrow. If no receipt arrives, anyone can request `reclaim` after the deadline plus a grace period per
hop, and the refund follows one grace period later. Receipts are never dropped: one that cannot be sent waits in the
outbox for a permissionless `flush`.

### Why does each intermediate hop take two transactions?

The reference Solidity CLPR Service guards both `submitBundle` and `sendMessage` with one reentrancy lock, so a Router
cannot forward from inside the delivery. It records the hop as pending, and anyone completes it with `forward()` in
the next transaction (all checks run again). On a Service that allows sends during delivery, the hop goes out at once.

### What runs on public networks today?

Sepolia and Hedera testnet: the full Router stack at identical addresses, a Channel verified on Hedera by the CLPR
repo's `EthMainnetVerifier`, one route Sepolia → Hedera delivered, and the Settle on Hedera contracts with a bonded test
Connector. Every transaction is linked from [deployments/README.md](../deployments/README.md). Nothing runs on a
mainnet.

### Why can't the receipt get back to Sepolia?

Hiero → chain verification needs a Hiero state-proof source for EVM storage, which is not available yet, so the
Sepolia side of the testnet Channel uses a test-only stub that accepts no bundles. The route's origin stays pending
until `reclaim`. Local tests cover the full round trip with a test verifier.

### What is the Hedera trace-size cap?

Hedera consensus nodes fail a contract transaction whose recorded call trace exceeds
`contracts.maxSerializedTraceDataBytes` (262,144 B), with `INSUFFICIENT_GAS`, even when gas was sufficient. It blocked
opening a Channel with a 512-key sync-committee config in one transaction; we staged the committee instead. Evidence,
reproduction and impact: [lfdt/hedera-trace-cap.md](lfdt/hedera-trace-cap.md).

### Which chains can it route between?

Any EVM ledger with a CLPR Service can host a Router. The planner ships measured route data for 86 chains
(`sdk/data/`), taken from CLPR verifier work; chain → Hiero edges are active where a verifier is live-verified or
family-covered, and every Hiero → chain edge is projected until a Hiero proof source exists. Non-EVM ledgers fail
closed until the registry can certify their Router.

### What is Settle on Hedera, and how does it differ from routing?

Routing forwards a message and settles an escrow at the origin. Settle on Hedera lets a bonded Connector pay a user on
chain X after the user paid on chain Y; both payments are proven to an order book on Hedera, and a missed deadline
pays the user from the Connector's bond. It needs proofs only chain → Hedera. See [settle-on-hedera.md](settle-on-hedera.md).

### How do ISO 20022 routes keep payment data private?

The SDK's ISO 20022 module builds pacs.008, pacs.009, pacs.002, camt.056, pacs.004 and camt.029 messages, encrypts the
payment message to the destination institution and puts only a hash or ciphertext on-chain; the UETR travels end to
end in its own field. See [integrator-guide.md](integrator-guide.md).

### What does a route cost?

On anvil with the reference Service, a three-hop route with escrow uses about 1.79M gas to send and 1.15M to 1.65M per
hop transaction; every step fits in one Hedera transaction (largest Router step on a local Hiero network: 11 % of the
15M limit). Figures: [technical-reference.md](technical-reference.md#gas-anvil-reference-clprservice-three-hop-route-with-escrow).

### Is it audited? Can I use it with real funds?

Two internal security reviews found and fixed 4 High, 9 Medium and 5 Low items, each with a regression test; a
re-review is in progress. There has been no external audit. Do not use CLPRouter with real funds.

### How do I try it?

`script/e2e/run.sh` runs five routes over three local anvil chains; `script/settle-e2e/run.sh` runs Settle on Hedera
locally. See the [README quick start](../README.md#quick-start).

### How do I contribute or report a problem?

[CONTRIBUTING.md](../CONTRIBUTING.md) (DCO sign-off required). Report security problems privately as described in
[SECURITY.md](../SECURITY.md), never in a public issue.
