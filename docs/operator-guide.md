# Operator guide

For people who run parts of CLPRouter: the optional services, a pumper, a CLPR Connector or endpoint on a route,
or an operated Router for regulated hops. No role here needs anyone's approval to start, except the regulated
operator's certification. None of them can redirect a route: every hop re-checks on-chain.

## 1. Roles

| Role | What you run | What you need | How you are paid | What keeps you honest |
| --- | --- | --- | --- | --- |
| Pumper | Calls `forward` / `flush` on pending hops | An RPC node, a funded account per ledger | Nothing on-chain today (hop fees go to each hop's `fee_payee`) | Nothing to keep honest: the Router checks the envelope hash and re-runs every check |
| Connector operator | A CLPR Connector on a ledger of the route | Stake and funds per CLPR rules | Its margin per message; the planner compares Connectors by price and track record | CLPR slashes Connector stake on failures |
| Endpoint / relayer | CLPR endpoint carrying bundles | Per CLPR | Reimbursement plus margin, paid by Connectors (CLPR rule) | Bundles are proof-verified; endpoint bonds |
| Indexer / quote service | `services/` | Node 22.13+ or the Docker image, RPC per ledger | Optional fees, off-chain | Every answer carries the blocks and registry versions it used; the SDK and every hop re-check |
| Regulated operator | An operated Router on an ISO 20022 or MiCA hop (identity, screening hook, CASP status) | Provider certification of identity and licence | Hop fee per forward | Can be uncertified; cannot redirect a route |

The Router deployment itself has no operator. Anyone can deploy one (`docs/deployment.md`); it has no admin key.

## 2. Run the services

The services index Router, registry and vault events on every configured ledger, serve route status and quotes,
and optionally complete pending hops.

| Component | Source | Does |
| --- | --- | --- |
| Indexer | `services/src/indexer.ts` | Polls `eth_getLogs` per ledger, `confirmations` blocks behind the head; rolls back on reorgs |
| Status API | `services/src/api.ts`, `status.ts`, `notices.ts` | Route status, account notices, registry view, SSE stream |
| Quote service | `services/src/quote.ts` | Planner over a base graph overlaid with live Channel, Connector and registry state |
| Forward trigger | `services/src/trigger.ts` | Records `ForwardPending`, `OutboxQueued` and `ForwardRejected` as jobs; serves calldata; optionally submits |

### 2.1 Configure and run

The configuration reference is `services/config.example.json` and the services' own documentation; the HTTP API is
described in `services/openapi.json`. The settings that matter for safety:

| Setting | Guidance |
| --- | --- |
| Ledger id | Must equal the Router's `ledgerId()` on that ledger |
| RPC URL | Your own node or a provider you trust for liveness; the services re-check nothing against a second source |
| Confirmations | Blocks behind the head before an event is indexed: 0 on instant-finality ledgers (Hedera, anvil), the practical finality depth elsewhere |
| Start block | The Router's deployment block |
| Contracts | `router`, `registry`, `vault`, and the CLPR Service for live Channel and Connector reads |
| HTTP host | `127.0.0.1` unless behind a reverse proxy |
| Trigger | Off unless you intend to pump (section 3) |

From source:

```sh
(cd sdk && pnpm install --frozen-lockfile)
cd services && pnpm install --frozen-lockfile
pnpm start ./config.json        # or CLPROUTER_SERVICES_CONFIG=./config.json pnpm start
```

### 2.2 Run the container

Release images are published to `ghcr.io/<owner>/clprouter-services` with an SPDX SBOM and SLSA build provenance
attached. Verify the digest before running it, and run it by digest:

```sh
gh attestation verify oci://ghcr.io/<owner>/clprouter-services@sha256:<digest> --repo <owner>/clprouter
docker run --rm -p 127.0.0.1:8787:8787 \
  -v "$PWD/config.json:/config/config.json:ro" -v clprouter-data:/data \
  -e CLPROUTER_SERVICES_CONFIG=/config/config.json \
  ghcr.io/<owner>/clprouter-services@sha256:<digest>
```

The image runs as an unprivileged user, keeps state on the `/data` volume, and has a container health check. Inside
the container the HTTP host must be `0.0.0.0`; publish the port on the host's loopback (as above) or behind a proxy.

### 2.3 API exposure

The API reads chain state only and has no authentication. Serve it on localhost or behind a reverse proxy with TLS,
rate limits and connection limits (the server-sent event stream holds connections open). Its answers carry the block
numbers and registry versions they were built from; clients that act on them should re-check on-chain.

### 2.4 Operations

- **Reorgs.** The indexer re-checks the last indexed block before every step and rolls back events above a reorg.
  Set confirmations to the ledger's practical finality depth.
- **Restarts.** Jobs left in flight by a crash are retried; the trigger re-reads the Router before sending, so a hop
  someone else completed is skipped.
- **State.** The database is a cache of on-chain events and can be rebuilt from the start block.
- **Logs.** Keys are never logged; RPC URLs are redacted.

## 3. Forward trigger and keys

The trigger turns `ForwardPending`, `OutboxQueued` and `ForwardRejected` events into jobs, serves their calldata so
anyone can send them, and optionally submits them itself.

- **Test keys** come from an environment variable and are accepted only when every RPC the trigger uses is local
  (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). They are for development and test networks.
- **Anything else** signs through an external signer (a KMS or HSM behind a signing service), so no production key
  sits in the service's environment, config, image or logs.
- **One account per ledger, gas money only.** The account needs no permission on any contract; a compromised signer
  can only waste its own balance.
- **Exact calldata.** Send `forward(envelope, [])` or `flush(channelId, connectorId, target, data)` exactly as served
  (the Router checks `keccak256(envelope)` against `pendingHash`, and the outbox key `keccak256(abi.encode(channelId,
  target, data))`). For `flush`, `connectorId` may be any Connector registered on the Channel.
- **Gas.** Simulate first. A call below `MIN_SEND_GAS` reverts with `InsufficientGas` and changes nothing, so
  over-provision gas (the trigger uses about three times the estimate, capped at 10M).

## 4. Pumping pending hops

On the reference Solidity `ClprService`, a Router cannot call `sendMessage` while being delivered a message (one
reentrancy lock guards both). So:

| Event on the hop ledger | Meaning | Call |
| --- | --- | --- |
| `ForwardPending(routeId, hopIndex, envelope)` | Hop checked, waiting to be sent | `forward(envelope, [])` |
| `OutboxQueued(key, channelId, connectorId, target, data)` | Receipt waiting to be sent | `flush(channelId, connectorId, target, data)`; if that Connector refuses it, the same call with another Connector of the Channel (the services trigger tries `trigger.receiptConnectors` in order) |
| A receipt's `RouteForwarded(receiptId, hopIndex, channelId, messageId, key, data)` with no later `HopResponse` once the CLPR Service has processed that message's reply (`messageId < getChannel(channelId).nextExpectedReplyId`) | The Router never received the reply (its Response callback failed, or the message was redacted) | `requeue(channelId, messageId)`, then `flush` |
| `ForwardRejected(routeId, hopIndex, envelopeHash, clprStatus, reason, envelope)` | Next hop rejected it (NACK) or the local send failed | Strict: `forward(envelope, [])` sends the `FAILED` receipt that refunds the origin. Loose: `forward(envelope, newTail)` re-routes |

Every check runs again at that time, including the deadline and the Channel approvals. A receipt that CLPR keeps
rejecting is re-queued each time; the trigger stops after `maxAttempts` (default 3) per job, so a permanently refused
receipt does not cost gas for ever. Pump promptly: an intermediate hop that waits past the
deadline stops the route with `EXPIRED`. The services' `completeRejected` option (default off) completes rejected
hops with the refund receipt instead of leaving them for re-routing.

## 5. Connector and endpoint operators

Nothing changes from plain CLPR. A routed hop is an ordinary CLPR Data Message from the hop's Router through your
Connector. Two things to watch:

- The Router's response to a delivered envelope is `abi.encodePacked(uint8 accepted|rejected, uint8 reason)`; a
  revert (`APPLICATION_ERROR` to the previous hop) means the envelope was malformed, misaddressed, unauthenticated or
  a replay.
- Receipts are new Data Messages in the reverse direction. Fund both directions of every Channel you serve.

## 6. Regulated operators (ISO 20022 and MiCA hops)

Phase 1 ships the same `ClprRouter` for every operator. A regulated operator:

1. Deploys a Router from a released build (`docs/deployment.md`) on its ledger.
2. Publishes its identity, jurisdiction and, for MiCA, its CASP authorisation, with evidence the committee can check.
3. Asks the provider committee for certification. The planner uses operated Routers on filtered routes only after
   the certification is effective (after `CERT_NOTICE`).
4. Publishes the X25519 encryption key that ISO 20022 payloads for its institution are sealed to, and rotates it with
   notice (the key id is part of the payload header).
5. Runs its screening (sanctions, AML) off-chain. Phase 1 has no on-chain screening hook, and anyone can pump a
   pending hop, so a screening hit cannot stop a forward on-chain yet. Until the hook ships, a hit is handled through
   the provider (a `BLACKLIST` decision stops the route at the next Router that checks it).

Legal compliance stays with the operator: the filters supply controls, not a licence.
