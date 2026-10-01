import { StaticJsonSource, sampleGraph, type GraphSource } from "@clprouter/sdk";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "./api.js";
import { isLocalRpc, loadConfig, triggerKey, type ServicesConfig } from "./config.js";
import { EventBus, Indexer, LedgerWatcher } from "./indexer.js";
import { QuoteService } from "./quote.js";
import { Store } from "./store.js";
import { ForwardTrigger, viemRouterChain, type RouterChain } from "./trigger.js";

export interface Services {
  store: Store;
  indexer: Indexer;
  quote: QuoteService;
  trigger: ForwardTrigger;
  api: ReturnType<typeof createApi>;
  stop(): Promise<void>;
}

/** Wire the indexer, status API, quote service and forward trigger from a config. Does not listen or start polling. */
export async function buildServices(cfg: ServicesConfig, log: (m: string) => void = console.log): Promise<Services> {
  const store = new Store(cfg.database ?? "clprouter-services.sqlite");
  const bus = new EventBus();
  bus.setMaxListeners(1000);
  const indexer = new Indexer(store, bus);
  const clients: Record<string, PublicClient> = {};

  for (const l of cfg.ledgers) {
    const client = createPublicClient({ transport: http(l.rpcUrl) }) as PublicClient;
    clients[l.id] = client;
    const w = new LedgerWatcher(l, client, store, bus, log);
    indexer.add(w);
    await w.snapshotRegistry().catch((e: Error) => log(`registry snapshot ${l.id}: ${e.message.split("\n")[0]}`));
  }

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
  if (cfg.trigger?.enabled) {
    const key = triggerKey(cfg.trigger);
    if (!key) {
      log("trigger: no key in env; recording pending hops only");
    } else {
      const account = privateKeyToAccount(key);
      for (const l of cfg.ledgers) {
        if (cfg.trigger.ledgers && !cfg.trigger.ledgers.includes(l.id)) continue;
        // Test keys, local networks only: refuse to sign anywhere else.
        if (!isLocalRpc(l.rpcUrl)) throw new Error(`trigger: refusing to sign on ${l.id}: ${l.rpcUrl} is not a local RPC`);
        const chainId = await clients[l.id]!.getChainId();
        const pub = createPublicClient({ transport: http(l.rpcUrl) }) as PublicClient;
        const bound = createWalletClient({
          account,
          chain: { id: chainId, name: l.id, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [l.rpcUrl] } } },
          transport: http(l.rpcUrl),
        });
        chains[l.id] = viemRouterChain(pub, bound, l.contracts.router);
      }
      log(`trigger: submitting as ${account.address} on ${Object.keys(chains).join(", ")}`);
    }
  }
  const trigger = new ForwardTrigger({
    store,
    bus,
    routers: Object.fromEntries(cfg.ledgers.map((l) => [l.id, l.contracts.router])),
    chains,
    completeRejected: cfg.trigger?.completeRejected,
    log,
  });

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
      routerVersions: cfg.routerVersions ?? [1],
    },
  });

  return {
    store,
    indexer,
    quote,
    trigger,
    api,
    async stop() {
      await indexer.stop();
      await trigger.stop();
      await new Promise<void>((r) => api.close(() => r()));
      store.close();
    },
  };
}

async function main() {
  const path = process.argv[2] ?? process.env.CLPROUTER_SERVICES_CONFIG;
  if (!path) {
    console.error("usage: clprouter-services <config.json>   (or CLPROUTER_SERVICES_CONFIG)");
    process.exit(2);
  }
  const cfg = loadConfig(path);
  const s = await buildServices(cfg);
  s.indexer.start();
  s.trigger.start();
  const host = cfg.http?.host ?? "127.0.0.1";
  const port = cfg.http?.port ?? 8787;
  s.api.listen(port, host, () => console.log(`clprouter services on http://${host}:${port}`));
  const shutdown = () => void s.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
