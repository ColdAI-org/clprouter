# CLPRouter services

The optional off-chain services of CLPRouter: the event indexer, the route status API, the quote service and the
public forward/flush trigger. They are a convenience. Every answer carries the blocks and registry versions it was
built from, the SDK can re-check any quote, and every hop re-checks on-chain.

## Run

```sh
pnpm install --frozen-lockfile
pnpm test                       # unit, API, PostgreSQL (throwaway cluster via initdb) and anvil integration tests
pnpm start config.example.json  # or CLPROUTER_SERVICES_CONFIG=<file> / CLPROUTER_SERVICES_CONFIG_JSON=<json>
pnpm build                      # bundle to dist/main.js (one file, no runtime node_modules)
pnpm loadtest                   # autocannon against /routes/:id, /routes and /quote; writes loadtest/results.json
```

Container (build from the repository root, because the services import the SDK source):

```sh
docker build -f services/Dockerfile -t clprouter-services .
docker compose -f services/docker-compose.yml up --build    # anvil + PostgreSQL + services
```

The image is multi-stage, with base images pinned by digest. It installs from the lockfiles, ships a single bundled
file and runs as `node` (non-root), with a `/healthz` health check. The compose file runs it read-only, with all
capabilities dropped and `no-new-privileges`. Exit codes: 0 after a clean shutdown, 1 on a runtime failure, 2 on a
configuration error.

## Configuration

Configuration is a JSON file, validated with a strict schema (`src/config.ts`): unknown keys, bad addresses, bad URLs
and out-of-range values are errors that name the field. Strings may reference `${ENV_VAR}`, so RPC API keys and
database passwords stay in the environment. An unset variable is an error. Then these env variables override the
file:

| Variable | Overrides |
| --- | --- |
| `CLPROUTER_DATABASE_URL` | `database` (`postgres://...`, `sqlite:<path>`, a path, `:memory:`) |
| `CLPROUTER_HTTP_HOST`, `CLPROUTER_HTTP_PORT` | `http.host`, `http.port` |
| `CLPROUTER_LOG_LEVEL` | `log.level` (`debug`, `info`, `warn`, `error`) |
| `CLPROUTER_METRICS_PORT` | `metrics.port` (separate metrics listener) |
| `CLPROUTER_CORS_ORIGINS` | `http.cors.origins` (comma-separated, `*` for any) |
| `CLPROUTER_SIGNER_URL` | `trigger.signer.url` (web3signer) |
| `CLPROUTER_RPC_URLS_<LEDGER>` | a ledger's `rpcUrls`, e.g. `CLPROUTER_RPC_URLS_EIP155_296=https://a,https://b` |
| `CLPROUTER_STRICT` | strict mode (default: on when `NODE_ENV=production`) |

Per ledger: `id` (CAIP-2), `rpcUrls` (in order of preference; `rpcUrl` still works), `chainId`, `confirmations`,
`contracts` (`router`, `registry`, `vault`, optional `clprService`), `startBlock`, `batchSize`, `pollIntervalMs` and
`rpc` (`timeoutMs`, `retries`, `backoffMs`, `maxBackoffMs`, `cooldownMs`; a top-level `rpc` sets the default).
Strict mode requires `chainId` on every ledger and refuses local test keys. See `config.example.json` and
`docker/config.compose.json`.

## Storage

- **SQLite** (`node:sqlite`): one file, WAL mode. Good for a single instance.
- **PostgreSQL**: PostgreSQL is the system of record. Queries run on an in-process SQLite mirror that is hydrated from
  PostgreSQL at startup. Every write goes to the mirror and to an ordered, idempotent write queue for PostgreSQL. The
  queue uses upserts and range deletes, and retries with backoff until a write lands. The indexer waits for the
  queue before it announces events, and the trigger waits before it sends a transaction. `/readyz` fails while
  writes lag by more than 30 s. One writer per database is enforced with an advisory lock, so a second instance
  refuses to start. Memory grows with the indexed history.

Schema changes are versioned migrations (`src/db/migrations.ts`), applied in order inside transactions and recorded
in `schema_migrations`. PostgreSQL migrations run under an advisory lock. A database created before migrations
existed is adopted as it is. A database from a newer build is refused.

## RPC

Each ledger has its own client over several endpoints (`src/rpc.ts`). The client sets a timeout on every request. It
retries with exponential backoff and full jitter, and honours `Retry-After`, capped at `maxBackoffMs`. It treats
HTTP 429 and JSON-RPC `-32005` as rate limits, and cools an endpoint down after a rate limit or a failure. It moves
to the next endpoint without waiting. Deterministic errors are returned at once: reverts keep their revert data.
At startup the client checks `eth_chainId` on every endpoint, and a mismatch with the configured `chainId` is fatal.
An endpoint that was down at startup is checked before its first use. Credentials in an RPC URL are sent as an
`Authorization` header and never appear in logs or errors.

## Trigger signing

The trigger never needs a production key in its environment.

- `signer: { "kind": "web3signer", "url": "https://...", "address": "0x...", "authTokenEnv": "SIGNER_TOKEN" }` calls
  JSON-RPC `eth_signTransaction` on Web3Signer, or on a compatible front for a KMS or HSM. Only a bearer token sits
  in the env. The URL must be `https` unless it is local.
- A KMS-style `DigestSigner` (`{ address, signDigest(hash) }`) can be passed to `buildServices(cfg, log, { signer })`
  for in-process KMS adapters.
- `signer: { "kind": "local-test-key", "keyEnv": "..." }` (or the older `keyEnv`) is for local development only. It
  works only when every RPC the trigger uses is local (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) and strict
  mode is off.

Every signature from a remote signer is recovered and checked against the configured address. The signed
transaction is checked against the one requested (to, data, nonce, chain id, value, gas) before it is sent.

## HTTP API

The contract is [`openapi.json`](openapi.json) (OpenAPI 3.1, also served at `GET /openapi.json`). Tests check every
implemented route against it and validate live responses against its schemas.

| Endpoint | |
| --- | --- |
| `GET /routes` | routes sent, newest first; `?ledger=&sender=&limit=&cursor=` (keyset pagination) |
| `GET /routes/:routeId` | hop-by-hop status, tx hashes per ledger, final outcome (hex id or UUID) |
| `GET /accounts/:caip10/notices` | quarantine notices, sender receipts and listings |
| `GET /registry[?ledger=]` | certifications, disables, blacklist with case ids, committee, vault holdings |
| `POST /quote` | planner quote over the live graph, with its inputs |
| `GET /graphs/:hash` | the graph snapshot a quote was computed on |
| `GET /pending` | hops waiting for the public trigger, with calldata; `?ledger=&limit=&cursor=` |
| `GET /stream` | server-sent events (`route`, `indexed`, `reorg`, `shutdown`) |
| `GET /health`, `/healthz`, `/readyz`, `/metrics` | cursors, liveness, readiness, Prometheus |

Hardening:

- Strict input validation (`POST /quote` rejects unknown keys and out-of-range values; path and query parameters
  are checked).
- A body limit (`http.bodyLimitBytes`, 413) and a URL length limit (414).
- Header and request timeouts.
- Per-client token-bucket rate limiting (`http.rateLimit`; 429 with `Retry-After`). A quote costs
  `quoteCost` tokens, and probes are exempt. The client is the socket peer, or the last `X-Forwarded-For` hop when
  `trustProxy` is on.
- A cap on concurrent quotes (503 with `Retry-After`) and on SSE streams in total and per client.
- A CORS allowlist (`http.cors.origins`).
- `nosniff`, a CSP and `no-store` on every response, and an `x-request-id` header (taken from the request or
  generated).
- 5xx bodies are `{ "error": "internal error", "requestId": ... }`, with no message and no stack. The error goes
  to the log.

`POST /quote` memoises the live graph on its inputs (the confirmed block number and hash per ledger, and the
evaluation second), so concurrent quotes share one build. The answer is unchanged: it is a pure function of those
inputs.

## Operations

- **Logs**: one JSON object per line on stdout (`level`, `time`, `msg`, fields). URLs are redacted (user info,
  long path segments and query values), and fields named like secrets are masked.
- **Metrics** (`/metrics`, or `metrics.port` for a separate listener):
  - indexer: `clprouter_indexer_head_block`, `_cursor_block`, `_lag_blocks`, `_last_success_timestamp_seconds` and
    `_poll_errors_total`;
  - `clprouter_reorgs_total` and `clprouter_reorg_removed_events_total`;
  - `clprouter_pending_hops{ledger,kind,status}` and `clprouter_trigger_jobs_total{result}`;
  - `clprouter_quote_duration_seconds`;
  - HTTP: `clprouter_http_requests_total`, `clprouter_http_request_duration_seconds` and `clprouter_api_errors_total`;
  - RPC: `clprouter_rpc_requests_total{endpoint,outcome}`, `clprouter_rpc_retries_total` and
    `clprouter_rpc_request_duration_seconds`;
  - `clprouter_store_write_backlog`, `clprouter_sse_clients` and the Node process metrics.
- **Probes**: `/healthz` is liveness. `/readyz` checks that the store answers and is durable, that every ledger had a
  successful poll within `readiness.maxStalePolls` poll intervals with a chain-id-verified endpoint, and that the
  service is not shutting down.
- **Shutdown** (SIGTERM or SIGINT): the service becomes not ready, tells SSE clients and closes their streams, stops
  accepting connections and finishes in-flight requests. It lets the indexer poll and the trigger pass in progress
  complete, then flushes and closes the store, within `shutdownTimeoutMs` (default 25 s). A second signal exits at
  once.

## Load test

`pnpm loadtest` seeds 2,000 routes on a fake chain and starts the services in a child process (SQLite, rate limiting
off). It then runs autocannon with 50 connections for 15 s per scenario. Results on an Apple M1 Max with Node
24.21 ([`loadtest/results.json`](loadtest/results.json)):

| Scenario | req/s | p50 | p99 | non-2xx |
| --- | ---: | ---: | ---: | ---: |
| `GET /routes/:routeId` | 14,536 | 3 ms | 7 ms | 0 |
| `GET /routes?limit=50` | 3,630 | 13 ms | 26 ms | 0 |
| `POST /quote` (live graph memoised per block and second) | 9,966 | 4 ms | 9 ms | 0 |
| `POST /quote` (distinct `now` per request, no memo) | 344 | 143 ms | 179 ms | 0 |

Building the live graph costs about 2.9 ms of CPU per uncached quote, almost all of it outside the planner. The
quote rate limit (5 tokens a quote, 600 tokens a minute per client) keeps the uncached cost bounded per client.
`pnpm loadtest -- --url http://host:8787 --route 0x...` runs the same scenarios against a deployed instance.
