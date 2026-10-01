import { describe, expect, it } from "vitest";
import type { IndexedEvent } from "../src/events.js";
import { EventBus, LedgerWatcher, type ReorgInfo } from "../src/indexer.js";
import { Store } from "../src/store.js";
import { ADDR, G, MockChain, R, V, ev, h32, rid } from "./helpers.js";

const LEDGER = "eip155:31001";

function setup(confirmations = 2, batchSize = 2000) {
  const chain = new MockChain();
  const store = new Store();
  const bus = new EventBus();
  const seen: IndexedEvent[] = [];
  const reorgs: ReorgInfo[] = [];
  bus.onEvent((e) => seen.push(e));
  bus.on("reorg", (r: ReorgInfo) => reorgs.push(r));
  const w = new LedgerWatcher(
    { id: LEDGER, rpcUrl: "http://127.0.0.1:8545", confirmations, contracts: { router: ADDR.router, registry: ADDR.registry, vault: ADDR.vault }, batchSize },
    chain,
    store,
    bus,
  );
  return { chain, store, bus, w, seen, reorgs };
}

describe("event decoding", () => {
  it("decodes router, registry and vault events with readable enum names", () => {
    const st = ev(LEDGER, R.settled(rid(1), 5, 9, 0, h32("case-1")), { block: 1 });
    expect(st.name).toBe("RouteSettled");
    expect(st.routeId).toBe(rid(1));
    expect(st.caseId).toBe(h32("case-1"));
    expect(st.args.statusName).toBe("QUARANTINED");
    expect(st.args.reasonName).toBe("BLACKLIST");
    expect(st.args.feesPaid).toBe("30"); // bigints are JSON-safe strings

    const stop = ev(LEDGER, R.stopped(rid(1), 1, 3, 2), { block: 1 });
    expect([stop.args.statusName, stop.args.reasonName]).toEqual(["EXPIRED", "DEADLINE"]);

    const rej = ev(LEDGER, R.rejected(rid(1), 0, "0xabcd"), { block: 1 });
    expect(rej.args.statusName).toBe("SEND_FAILED");
    expect(ev(LEDGER, R.hopResponse(rid(1), 3), { block: 1 }).args.statusName).toBe("CONNECTOR_UNDERFUNDED");

    const dis = ev(LEDGER, G.disabled(1, h32("edge"), 100), { block: 1 });
    expect(dis.contract).toBe("registry");
    expect(dis.args.kindName).toBe("EDGE");

    const bl = ev(LEDGER, G.listed(h32("acct"), "eip155:1:0xabc", h32("case"), 100), { block: 1 });
    expect(bl.accountKey).toBe(h32("acct"));
    expect(bl.caseId).toBe(h32("case"));

    const dep = ev(LEDGER, V.deposited(1, rid(2), h32("case"), 5n), { block: 1 });
    expect(dep.contract).toBe("vault");
    expect(dep.routeId).toBe(rid(2));
    expect(dep.args.amount).toBe("5");
  });
});

describe("LedgerWatcher", () => {
  it("indexes only blocks at the confirmation depth and stores timestamps and tx hashes", async () => {
    const { chain, store, w, seen } = setup(2);
    chain.mine([R.sent(rid(1))]); // block 1
    chain.mine([]); // block 2: head = 2, safe = 0
    expect(await w.poll()).toBe(0);
    expect(w.cursor()?.blockNumber).toBe(0);

    chain.mine([]); // head = 3, safe = 1
    expect(await w.poll()).toBe(1);
    expect(w.cursor()?.blockNumber).toBe(1);
    const [e] = store.eventsByRouteIds([rid(1)]);
    expect(e?.name).toBe("RouteSent");
    expect(e?.timestamp).toBe(chain.blocks[1]!.timestamp);
    expect(e?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(seen.map((x) => x.name)).toEqual(["RouteSent"]);

    // Idempotent: nothing new.
    expect(await w.poll()).toBe(0);
  });

  it("walks long ranges in batches", async () => {
    const { chain, store, w } = setup(0, 3);
    for (let i = 1; i <= 10; i++) chain.mine([R.forwarded(rid(i), 1)]);
    expect(await w.poll()).toBe(10);
    expect(chain.getLogsCalls.length).toBe(4); // [0..2] [3..5] [6..8] [9..10]
    expect(store.eventsByName("RouteForwarded")).toHaveLength(10);
  });

  it("rolls back and re-indexes when a reorg goes deeper than the confirmation depth", async () => {
    const { chain, store, w, reorgs } = setup(1);
    chain.mine([R.sent(rid(1))]); // 1
    chain.mine([R.forwarded(rid(1), 1)]); // 2
    chain.mine([R.delivered(rid(1))]); // 3
    chain.mine([]); // 4
    await w.poll();
    expect(w.cursor()?.blockNumber).toBe(3);
    expect(store.eventsByRouteIds([rid(1)]).map((e) => e.name)).toEqual(["RouteSent", "RouteForwarded", "RouteDelivered"]);

    // Blocks 2.. replaced: the forward never happened; instead the route stopped.
    chain.reorg(2, [[R.stopped(rid(1), 0, 2, 3)], [], []], "fork");
    await w.poll();
    expect(reorgs).toHaveLength(1);
    expect(reorgs[0]).toMatchObject({ from: 3, to: 1, removedEvents: 2 });
    expect(store.eventsByRouteIds([rid(1)]).map((e) => e.name)).toEqual(["RouteSent", "RouteStopped"]);
    expect(w.cursor()?.blockHash).toBe(chain.blocks[3]!.hash);
  });

  it("ignores logs from other contracts and unknown events", async () => {
    const { chain, store, w } = setup(0);
    chain.blocks[0]!.logs.push(R.sent(rid(9)));
    // Same event from a non-watched address.
    const other = { ...R.sent(rid(8)), address: "0x9999999999999999999999999999999999999999" as const };
    chain.mine([other]);
    await w.poll();
    expect(store.eventsByRouteIds([rid(9)])).toHaveLength(1);
    expect(store.eventsByRouteIds([rid(8)])).toHaveLength(0);
  });

  it("persists across restarts (SQLite file)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = `${mkdtempSync(`${tmpdir()}/clpr-`)}/idx.sqlite`;
    const chain = new MockChain();
    chain.mine([R.sent(rid(1))]);
    const cfg = { id: LEDGER, rpcUrl: "http://127.0.0.1:8545", confirmations: 0, contracts: { router: ADDR.router, registry: ADDR.registry, vault: ADDR.vault } };
    let store = new Store(path);
    await new LedgerWatcher(cfg, chain, store, new EventBus()).poll();
    store.close();
    store = new Store(path);
    expect(store.getCursor(LEDGER)?.blockNumber).toBe(1);
    expect(store.eventsByRouteIds([rid(1)])).toHaveLength(1);
    chain.mine([R.forwarded(rid(1), 1)]);
    await new LedgerWatcher(cfg, chain, store, new EventBus()).poll();
    expect(store.eventsByRouteIds([rid(1)])).toHaveLength(2);
    expect(chain.getLogsCalls.at(-1)).toEqual({ from: 2, to: 2 });
    store.close();
  });
});
