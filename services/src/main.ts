import { StaticJsonSource, sampleGraph, type GraphSource } from "@clprouter/sdk";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createPublicClient, createWalletClient, type Hex, type PublicClient } from "viem";
import { createApi, type ApiServer, type ReadinessReport } from "./api.js";
import { ConfigError, loadConfig, resolveConfig, type DatabaseTarget, type ResolvedConfig, type ServicesConfig } from "./config.js";
import { PgStore } from "./db/pg.js";
import { EventBus, Indexer, LedgerWatcher, type ReorgInfo } from "./indexer.js";
import type { IndexedEvent } from "./events.js";
import { createLogger, loggerFromFn, redactUrl, type Logger } from "./log.js";
import { Metrics } from "./metrics.js";
import { QuoteService } from "./quote.js";
import { ResilientRpc } from "./rpc.js";
import { buildSigner, type DigestSigner } from "./signer.js";
import { Store } from "./store.js";
import { ForwardTrigger, viemRouterChain, type RouterChain } from "./trigger.js";

export interface Services {
  config: ResolvedConfig;
  logger: Logger;
  store: Store;
  indexer: Indexer;
  quote: QuoteService;
  trigger: ForwardTrigger;
  api: ApiServer;
  metrics: Metrics;
  rpcs: Record<string, ResilientRpc>;
  /** Readiness: store reachable and durable, every ledger polled recently, RPC usable, not shutting down. */
  readiness(): Promise<ReadinessReport>;
  /** Start the indexer and the trigger. */
  start(): void;
  /** Listen on the configured host/port (and the metrics port, if separate). Resolves with the bound API port. */
  listen(): Promise<number>;
  /** Graceful stop: not-ready, close streams and listeners, finish in-flight work, flush and close the store. */
  stop(): Promise<void>;
}

export interface BuildOptions {
  /** KMS-style signer for the trigger (overrides the configured signer). */
  signer?: DigestSigner;
  env?: NodeJS.ProcessEnv;
  /** fetch for RPC and signer calls (tests). */
  fetch?: typeof fetch;
}

function loadOpenApi(): unknown {
  for (const rel of ["../openapi.json", "./openapi.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as unknown;
    } catch {
      // try the next location (source tree vs. bundled dist)
    }
  }
  return undefined;
}

export async function openStore(db: DatabaseTarget, logger: Logger): Promise<Store> {
  if (db.kind === "postgres") return PgStore.open({ url: db.url, poolMax: db.poolMax, statementTimeoutMs: db.statementTimeoutMs, log: logger.child({ component: "store" }) });
  return new Store(db.path);
}

/**
 * Wire the indexer, status API, quote service and forward trigger from a config. Does not listen or start polling.
 * `log` is a structured {@link Logger} or a legacy `(msg) => void` callback.
 */
export async function buildServices(input: ServicesConfig, log?: Logger | ((m: string) => void), opts: BuildOptions = {}): Promise<Services> {
  const env = opts.env ?? process.env;
  const cfg = resolveConfig(input, env);
  const logger: Logger = typeof log === "function" ? loggerFromFn(log) : (log ?? createLogger({ level: cfg.log.level }));
  const metrics = new Metrics();

  const store = await openStore(cfg.database, logger);
  try {
    return await wire(cfg, logger, metrics, store, opts, env);
  } catch (e) {
    await store.shutdown().catch(() => {});
    throw e;
  }
}

async function wire(cfg: ResolvedConfig, logger: Logger, metrics: Metrics, store: Store, opts: BuildOptions, env: NodeJS.ProcessEnv): Promise<Services> {
  const bus = new EventBus();
  bus.setMaxListeners(cfg.http.sse.maxClients + 100);
  const indexer = new Indexer(store, bus);
  const clients: Record<string, PublicClient> = {};
  const rpcs: Record<string, ResilientRpc> = {};

  for (const l of cfg.ledgers) {
    const rpc = new ResilientRpc({ ledger: l.id, urls: l.rpcUrls, policy: l.rpc, chainId: l.chainId, log: logger.child({ component: "rpc", ledger: l.id }), observer: metrics.rpcObserver(), fetch: opts.fetch });
    rpcs[l.id] = rpc;
    // Startup chain-id check: a configured chainId that an endpoint contradicts is fatal.
    const results = await rpc.checkChainId();
    const implied = l.id.startsWith("eip155:") ? Number(l.id.slice(7)) : undefined;
    for (const r of results) {
      if (l.chainId === undefined && r.chainId !== undefined && implied !== undefined && r.chainId !== implied) {
        logger.warn("rpc chain id differs from the CAIP-2 reference and no chainId is configured", { ledger: l.id, endpoint: r.endpoint, chainId: r.chainId });
      }
    }
    const client = createPublicClient({ transport: rpc.transport() }) as PublicClient;
    clients[l.id] = client;
    const w = new LedgerWatcher(l, client, store, bus, logger.child({ component: "indexer", ledger: l.id }).fn("debug"));
    indexer.add(w);
    await w.snapshotRegistry().catch((e: Error) => logger.warn("registry snapshot failed", { ledger: l.id, err: e.message.split("\n")[0] }));
  }

  bus.on("reorg", (r: ReorgInfo) => {
    metrics.reorgs.inc({ ledger: r.ledger });
    metrics.reorgEvents.inc({ ledger: r.ledger }, r.removedEvents);
    logger.warn("reorg rolled back indexed state", { ...r });
  });
  bus.on("event", (e: IndexedEvent) => metrics.indexedEvents.inc({ ledger: e.ledger, name: e.name }));
  bus.on("pollError", (p: { ledger: string; error: Error }) => {
    metrics.pollErrors.inc({ ledger: p.ledger });
    logger.warn("indexer poll failed", { ledger: p.ledger, err: p.error.message.split("\n")[0] });
  });

  const base: GraphSource = cfg.graph?.file ? new StaticJsonSource({ file: cfg.graph.file }) : new StaticJsonSource(sampleGraph());
  const quote = new QuoteService({
    base,
    store,
    ledgers: cfg.ledgers,
    cursors: () => indexer.cursors(),
    clients,
    registryLedger: cfg.registryLedger,
    routerVersions: cfg.routerVersions,
  });

  const chains: Record<string, RouterChain> = {};
  if (cfg.trigger.enabled) {
    const triggerLedgers = cfg.ledgers.filter((l) => !cfg.trigger.ledgers || cfg.trigger.ledgers.includes(l.id));
    const signer = buildSigner(cfg.trigger.signer, triggerLedgers, { strict: cfg.strict, env, injected: opts.signer, fetch: opts.fetch });
    if (!signer) {
      logger.warn("trigger: no signer available; recording pending hops only");
    } else {
      for (const l of triggerLedgers) {
        const rpc = rpcs[l.id]!;
        const chainId = l.chainId ?? Number(BigInt((await rpc.request("eth_chainId")) as string));
        const wallet = createWalletClient({
          account: signer.account,
          chain: { id: chainId, name: l.id, nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [] } } },
          transport: rpc.transport(),
        });
        chains[l.id] = viemRouterChain(clients[l.id]!, wallet, l.contracts.router);
      }
      logger.info("trigger: submitting", { signer: signer.kind, address: signer.account.address, ledgers: Object.keys(chains) });
    }
  }
  const trigger = new ForwardTrigger({
    store,
    bus,
    routers: Object.fromEntries(cfg.ledgers.map((l) => [l.id, l.contracts.router])),
    chains,
    completeRejected: cfg.trigger.completeRejected,
    maxAttempts: cfg.trigger.maxAttempts,
    receiptConnectors: cfg.trigger.receiptConnectors as Record<string, Hex[]>,
    log: logger.child({ component: "trigger" }).fn("info"),
    onResult: (j, result) => metrics.triggerTx.inc({ ledger: j.ledger, kind: j.kind, result }),
  });

  let stopping = false;
  const readiness = async (): Promise<ReadinessReport> => {
    const checks: ReadinessReport["checks"] = {};
    if (stopping) checks.shutdown = { ok: false, detail: "shutting down" };
    try {
      await store.ping();
      const h = store.health();
      checks.store = { ok: h.ok, ...(h.detail ? { detail: h.detail } : {}) };
    } catch (e) {
      checks.store = { ok: false, detail: `unreachable: ${(e as Error).message.split("\n")[0]}` };
    }
    const t = Date.now();
    for (const w of indexer.watchers.values()) {
      const maxAge = cfg.readiness.maxStalePolls * (w.cfg.pollIntervalMs ?? 2000);
      const rpc = rpcs[w.ledger]!;
      if (!rpc.usable()) checks[`ledger:${w.ledger}`] = { ok: false, detail: "no RPC endpoint with a verified chain id" };
      else if (w.lastSuccessAt === undefined) checks[`ledger:${w.ledger}`] = { ok: false, detail: w.lastError ? `not indexed yet: ${redactUrl(w.lastError.split("\n")[0]!)}` : "no successful poll yet" };
      else if (t - w.lastSuccessAt > maxAge) checks[`ledger:${w.ledger}`] = { ok: false, detail: `last successful poll ${Math.round((t - w.lastSuccessAt) / 1000)} s ago` };
      else checks[`ledger:${w.ledger}`] = { ok: true };
    }
    return { ready: Object.values(checks).every((c) => c.ok), checks };
  };

  const api = createApi({
    store,
    bus,
    ledgers: cfg.ledgers.map((l) => ({ id: l.id, router: l.contracts.router })),
    cursors: () => indexer.cursors(),
    quote,
    trigger,
    registryLedger: cfg.registryLedger,
    subjects: {
      ledgers: cfg.ledgers.map((l) => ({ id: l.id, router: l.contracts.router })),
      edges: (await base.load()).edges(),
      routerVersions: cfg.routerVersions,
    },
    http: cfg.http,
    logger: logger.child({ component: "api" }),
    metrics: cfg.metrics.enabled ? metrics : undefined,
    metricsOnApi: cfg.metrics.enabled && cfg.metrics.port === undefined,
    readiness,
    openapi: loadOpenApi(),
  });

  metrics.setSources({
    ledgers: () =>
      [...indexer.watchers.values()].map((w) => ({
        ledger: w.ledger,
        head: w.head,
        cursor: w.cursor()?.blockNumber,
        confirmations: w.cfg.confirmations,
        lastSuccessAt: w.lastSuccessAt,
      })),
    jobs: () => store.jobCounts(),
    storeBacklog: () => (store instanceof PgStore ? store.backlog : 0),
    sseClients: () => api.sseClientCount(),
  });

  let metricsServer: Server | undefined;
  let started = false;
  let stopped: Promise<void> | undefined;

  const closeServer = (s: Server, timeoutMs: number) =>
    new Promise<void>((resolve) => {
      if (!s.listening) return resolve();
      const t = setTimeout(() => {
        s.closeAllConnections();
        resolve();
      }, timeoutMs);
      s.close(() => {
        clearTimeout(t);
        resolve();
      });
      s.closeIdleConnections();
    });

  return {
    config: cfg,
    logger,
    store,
    indexer,
    quote,
    trigger,
    api,
    metrics,
    rpcs,
    readiness,
    start() {
      started = true;
      indexer.start();
      trigger.start();
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        api.once("error", reject);
        api.listen(cfg.http.port, cfg.http.host, () => {
          api.off("error", reject);
          resolve();
        });
      });
      const port = (api.address() as { port: number }).port;
      logger.info("api listening", { host: cfg.http.host, port });
      if (cfg.metrics.enabled && cfg.metrics.port !== undefined) {
        metricsServer = createServer((req, res) => {
          if (req.method === "GET" && req.url === "/metrics") {
            void metrics.render().then(
              (m) => {
                res.writeHead(200, { "content-type": m.contentType });
                res.end(m.body);
              },
              () => {
                res.writeHead(500);
                res.end();
              },
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        await new Promise<void>((resolve, reject) => {
          metricsServer!.once("error", reject);
          metricsServer!.listen(cfg.metrics.port, cfg.metrics.host, () => resolve());
        });
        logger.info("metrics listening", { host: cfg.metrics.host, port: (metricsServer.address() as { port: number }).port });
      }
      return port;
    },
    stop() {
      stopped ??= (async () => {
        stopping = true;
        logger.info("shutting down");
        const budget = cfg.shutdownTimeoutMs;
        api.drain();
        await Promise.all([closeServer(api, Math.floor(budget / 2)), indexer.stop(), trigger.stop()]);
        if (metricsServer) await closeServer(metricsServer, 1000);
        await store.shutdown();
        if (started) logger.info("stopped");
      })();
      return stopped;
    },
  };
}

/** Process entry point: config from argv / env, structured logs, graceful shutdown on SIGTERM and SIGINT. */
export async function main(argv = process.argv, env = process.env): Promise<void> {
  const bootLog = createLogger({ level: (env.CLPROUTER_LOG_LEVEL as never) ?? "info" });
  let s: Services;
  try {
    const cfg = loadConfig(argv[2] ?? env.CLPROUTER_SERVICES_CONFIG, env);
    const logger = createLogger({ level: resolveConfig(cfg, env).log.level, base: { service: "clprouter-services" } });
    s = await buildServices(cfg, logger, { env });
    s.start();
    await s.listen();
  } catch (e) {
    bootLog.error("startup failed", { err: e instanceof ConfigError ? e.message : e });
    process.exitCode = e instanceof ConfigError ? 2 : 1;
    return;
  }

  let exiting = false;
  const shutdown = (reason: string, code: number) => {
    if (exiting) {
      s.logger.warn("second signal: exiting now");
      process.exit(1);
    }
    exiting = true;
    s.logger.info("shutdown requested", { reason });
    const force = setTimeout(() => {
      s.logger.error("shutdown timed out; exiting", { timeoutMs: s.config.shutdownTimeoutMs });
      process.exit(1);
    }, s.config.shutdownTimeoutMs);
    force.unref();
    s.stop().then(
      () => process.exit(code),
      (e: unknown) => {
        s.logger.error("shutdown failed", { err: e });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("uncaughtException", (e) => {
    s.logger.error("uncaught exception", { err: e });
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (e) => {
    s.logger.error("unhandled rejection", { err: e });
    shutdown("unhandledRejection", 1);
  });
}

const entry = process.argv[1];
if (entry && (import.meta.url === `file://${entry}` || /[\\/]dist[\\/]main\.js$/.test(entry))) void main();
