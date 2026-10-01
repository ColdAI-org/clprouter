import { StaticJsonSource, sampleGraph } from "@clprouter/sdk";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { EventBus, Indexer, LedgerWatcher } from "../src/indexer.js";
import { QuoteService } from "../src/quote.js";
import { keys } from "../src/registry.js";
import { Store } from "../src/store.js";
import { ForwardTrigger } from "../src/trigger.js";
import { ADDR, G, MockChain, R, V, h32, rid } from "./helpers.js";

const L = "eip155:31001";
const ROUTE = rid(0x77);
const CASE = h32("case-api");
const RECIPIENT = "eip155:31003:0xc0ffee0000000000000000000000000000000003";

let base: string;
let close: () => Promise<void>;
const chain = new MockChain();
const store = new Store();
const bus = new EventBus();
const indexer = new Indexer(store, bus);
const cfg = { id: L, rpcUrl: "http://127.0.0.1:8545", confirmations: 0, contracts: { router: ADDR.router, registry: ADDR.registry, vault: ADDR.vault } };
indexer.add(new LedgerWatcher(cfg, chain, store, bus));

beforeAll(async () => {
  chain.mine([G.applied(1, 5), G.listed(keys.account(RECIPIENT), RECIPIENT, CASE, 4_000_000_000)]);
  chain.mine([
    R.sent(ROUTE, { messageId: 0n }),
    R.notice(ROUTE, RECIPIENT, keys.account(RECIPIENT), CASE),
    V.deposited(1, ROUTE, CASE, 99n),
    R.settled(ROUTE, 5, 9, 0, CASE),
  ]);
  chain.mine([R.pending(rid(0x88), 1, "0xabcdef")]);
  await indexer.pollAll();

  const quote = new QuoteService({ base: new StaticJsonSource(sampleGraph()), store, ledgers: [cfg], cursors: () => indexer.cursors() });
  const trigger = new ForwardTrigger({ store, bus, routers: { [L]: ADDR.router } });
  trigger.start();
  const server = createApi({ store, bus, ledgers: [{ id: L, router: ADDR.router }], cursors: () => indexer.cursors(), quote, trigger, heartbeatMs: 50 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await trigger.stop();
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  };
});

afterAll(async () => {
  await close();
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

describe("status API", () => {
  it("GET /routes/:routeId gives hop-by-hop status and the final outcome", async () => {
    const { status, body } = await get(`/routes/${ROUTE}`);
    expect(status).toBe(200);
    expect(body.outcome).toMatchObject({ status: "QUARANTINED", settled: true, caseId: CASE });
    expect(body.hops[0].ledger).toBe(L);
    expect(body.hops[0].events.map((e: { name: string }) => e.name)).toContain("RouteSent");
    expect(body.inputs[L].blockNumber).toBe(3);
  });

  it("accepts the UUID form of a route id and 404s unknown ones", async () => {
    const uuid = "00000000-0000-4000-8000-000000000077";
    expect((await get(`/routes/${uuid}`)).status).toBe(404);
    expect((await get(`/routes/00000000-0000-0000-0000-000000000077`)).status).toBe(200);
    expect((await get(`/routes/nope`)).status).toBe(400);
  });

  it("GET /accounts/:caip10/notices", async () => {
    const { body } = await get(`/accounts/${encodeURIComponent(RECIPIENT)}/notices`);
    expect(body.recipientNotices).toHaveLength(1);
    expect(body.recipientNotices[0]).toMatchObject({ routeId: ROUTE, caseId: CASE });
    expect(body.listings[0]).toMatchObject({ event: "AccountBlacklisted", caseId: CASE });
  });

  it("GET /registry lists the blacklist with case ids and the vault holdings", async () => {
    const { body } = await get("/registry");
    const l = body.ledgers[L];
    expect(l.version).toBe(1);
    expect(l.blacklist).toEqual([expect.objectContaining({ caip10: RECIPIENT, caseId: CASE })]);
    expect(l.quarantine.heldByCase).toEqual({ [CASE]: "99" });
    expect((await get("/registry?ledger=eip155:9")).status).toBe(404);
  });

  it("POST /quote returns the plan and its inputs", async () => {
    const r = await fetch(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "eip155:1", destination: "hedera:mainnet", mode: "fastest" }),
    });
    const body = (await r.json()) as Record<string, any>;
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.inputs.blocks[L].blockNumber).toBe(3);
    expect((await get(`/graphs/${body.inputs.graph.hash}`)).status).toBe(200);
    const bad = await fetch(`${base}/quote`, { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
  });

  it("GET /pending lists hops waiting for the public trigger", async () => {
    const { body } = await get("/pending");
    expect(body.jobs).toEqual([expect.objectContaining({ kind: "forward", ledger: L, router: ADDR.router })]);
    expect(body.jobs[0].calldata).toMatch(/^0x/);
  });

  it("streams live updates over server-sent events", async () => {
    const id = rid(0x99);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/stream?routeId=${id}`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value);
      }
    };
    await until("event: route"); // initial status
    chain.mine([R.sent(id), R.sent(rid(0x55))]);
    await indexer.pollAll();
    await until("event: indexed");
    const indexed = buf.split("\n\n").filter((b) => b.includes("event: indexed"));
    expect(indexed).toHaveLength(1); // the other route is filtered out
    expect(indexed[0]).toContain('"name":"RouteSent"');
    ctrl.abort();
  });
});
