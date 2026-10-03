# Settle Connector (reference)

A reference Connector for "settle on Hedera". It quotes, watches deposits, delivers, and settles orders on the
Hedera order book. The contracts are in `src/settle`. The Connector holds a bond in `SettleOrderBook` on Hedera.
Users pay it on chain Y through `SettleDeposit`, and it pays them on chain X through `SettleDelivery`. If it misses
a quote's deadline, anyone can call `claimDefault`, and the user is paid cover plus penalty from the bond.

## Commands

Run these from `services/`:

```sh
pnpm connector run   --config <file> --once [--relay-order deposit-first|delivery-first] [--skip-delivery all|<orderId>]
pnpm connector quote --config <file> --request <request.json> --out <quote.json>
pnpm connector serve --config <file> [--http-only]
pnpm connector bond  --config <file> post <amount> | withdraw-request <amount> | withdraw-execute
```

- `run --once` makes one pass. It registers the Connector (with the configured quote signer) if it is not
  registered, and tops the bond up to `bond.target`. It scans `Deposited` events from each chain's cursor and
  delivers the matching orders. It relays CLPR bundles if a relay is configured, then settles orders on Hedera. It
  prints one JSON line to stdout, for example
  `{"delivered":[],"skipped":[{"orderId":"0x..","reason":"too-late"}],"relayed":2,"closed":[],"cancelled":[],"settled":[],"deposits":1,"ignored":0,"errors":[]}`,
  and exits 0. It exits 1 if `errors` is not empty. Without `--once`, `run` repeats every `pollIntervalMs`.
- `--relay-order delivery-first` relays the chains the Connector delivered on to Hedera before the chains users
  paid on. The order book then records the delivery first, and the Connector closes the order with
  `closeWithRecordedDelivery`. The default is `deposit-first`.
- `--skip-delivery` leaves the matching orders undelivered for good. It simulates a Connector that misses the
  deadline. These orders are never cancelled.
- `quote` validates a request and prices it. It checks bond capacity and the Connector's balance on the
  destination chain, then signs the quote, records it in the store, and writes the response.
- `serve` runs the HTTP API and the `run` loop in one process. Use `--http-only` to run the API alone.
- Logs are JSON lines on stderr. Set the level with `CONNECTOR_LOG_LEVEL`.
- Exit codes: 0 on success, 1 on a runtime failure, 2 on a usage or configuration error.

## HTTP API

The API binds to `127.0.0.1:8787` by default. Request bodies are limited to `http.bodyLimitBytes` (default
16 KiB).

- `POST /quote` takes a quote request and returns a quote response (see `src/quote.ts`).
- `GET /info` returns the name, Connector, signer, order book, Hedera chain id, routes, and bond. In the bond
  object, `free` is the capacity left for new quotes.
- `GET /orders/:id` returns what the Connector knows about an order, plus the order's state on the order book.

Errors use the shape `{ "error": "<message>", "code": "<code>" }`:

| Status | Codes |
| --- | --- |
| 400 | `bad-request`, `unsupported-route` |
| 404 | `not-found` |
| 405 | method not allowed |
| 413 | `body-too-large` |
| 415 | `unsupported-media-type` |
| 503 | `no-capacity`, `no-liquidity` |

## Pricing and capacity

- `amountIn = ceil(ceil(amountOut * rateDen / rateNum) * (10000 + feeBps) / 10000)`. The fee is the part above the
  base amount.
- `coverAmount = floor(amountIn * coverNum / coverDen)`, in bond-asset base units.
- `owedOnDefault = coverAmount + floor(coverAmount * PENALTY_BPS / 10000)`. `PENALTY_BPS` is read from the order
  book.
- Times use ledger clocks, not wall time. `issuedAt` and `expiry` come from the source chain's latest block. The
  delivery margin check uses the destination chain's latest block.
- A quote is refused unless `deadline > expiry + deliveryP90S` and the deadline is within `quote.maxDeadlineS`
  (default 7 days).
- Capacity for new quotes is the order book's `freeCapacity` minus the `owedOnDefault` of quotes that are not open
  yet. A quote stops counting when the order book has it, or when its source chain has been scanned past its
  expiry with no deposit seen.

## Delivery rules

The Connector delivers a deposit only if all of these hold:

- The order id is a quote this Connector issued.
- The event's recovered signer is the configured signer.
- The event's connector, source chain, `amountIn`, `payTo`, and `assetIn` match the quote.
- At least `quote.minDeliveryMarginS` seconds remain before the deadline.

It records any other deposit for one of its quotes as skipped, with a reason. Native coin is delivered with
`msg.value`. For an ERC-20, the Connector approves `SettleDelivery` first. The store records the delivery intent
before the transaction is sent, and the tx hash right after. After a restart, the Connector looks for its own
`Delivered` event before it sends again. The recorded delivery struct (`SettleTypes.Delivery`) comes from the
`Delivered` event and its block time.

With `cancelUndeliverable: true`, the Connector cancels open orders it skipped as `too-late`, so the user is paid
from the bond at once. The default is `false`.

## Configuration

The config is a JSON file with a strict schema: unknown keys are errors. `${ENV}` references in strings are
replaced from the environment, and an unset variable is an error. The fields:

- `name`
- `hedera`: `ledgerId`, `rpcUrl`, `chainId`, `orderBook`, `clprService`
- `chains[]`: `ledgerId`, `rpcUrl`, `chainId`, `clprService`, `deposit`, `delivery`, `channelId`,
  `confirmations`, `startBlock`, and optional `logBatch`
- `routes[]`: `srcLedger`, `assetIn`, `dstLedger`, `assetOut`, `rateNum`, `rateDen`, `feeBps`, `coverNum`,
  `coverDen`, `deliveryP90S`
- `bond`: `asset`, `target`
- `quote`: `ttlS`, `defaultDeadlineS`, `minDeliveryMarginS`, and optional `maxDeadlineS`
- `keys`: `connector`, `signer`
- `relay`
- `store`: a path relative to the working directory
- `http`: optional `host`, `port`, `bodyLimitBytes`
- `pollIntervalMs` (optional)
- `cancelUndeliverable` (optional)

Keys:

- `local-test-key` (`privateKey`, usually `"${ENV_VAR}"`) is accepted only when every RPC URL in the config is
  local (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`).
- `web3signer` (`url`, `address`, optional `authTokenEnv`, `timeoutMs`) works for the `connector` key, which signs
  transactions. A remote web3signer must use https.
- The quote `signer` must be `local-test-key` for now: typed-data signing through an external signer is not
  supported yet.

Relay:

- `none` means another party submits the CLPR proofs. Real proof submission plugs in through the `ProofRelay`
  interface (`src/relay.ts`), and each verifier needs its own proof format.
- `e2e-test-only` is for local test networks only. It moves bundles without any proof, so it works only with the
  CLPR repository's `E2EVerifier`. It encodes them through the CLPR test contract `BundleEncoderHelper` at
  `bundleEncoder` on `bundleEncoderLedger`, and it refuses any RPC URL that is not local.

## Store

The store is one JSON file. It holds issued quotes, deposits seen, deliveries, skipped and closed orders, and one
scan cursor per chain. Each save writes a temp file, syncs it, and renames it into place. Run only one process per
store file.

## Known gaps

- On Hedera, the JSON-RPC relay scales native `value` (weibars to tinybars). Posting a native HBAR bond through it
  needs that conversion, which is not done here. ERC-20 (HTS) bonds and local EVM test networks are unaffected.
- There is no external signer for quote signing, and no signer rotation command.
- There are no metrics, and there is no lock against two processes sharing one store file.
