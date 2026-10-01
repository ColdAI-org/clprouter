import { StaticJsonSource, sampleGraph, type RouteGraphData } from "@clprouter/sdk";
import { describe, expect, it } from "vitest";
import type { LedgerConfig } from "../src/config.js";
import { keys } from "../src/registry.js";
import { QuoteService, recheckQuote, type QuoteResponse } from "../src/quote.js";
import { Store } from "../src/store.js";
import { ADDR, G, ev, h32 } from "./helpers.js";

const L = "eip155:31001";
const LEDGERS: LedgerConfig[] = [
  { id: L, rpcUrl: "http://127.0.0.1:8545", confirmations: 0, contracts: { router: ADDR.router, registry: ADDR.registry, vault: ADDR.vault } },
];

/** Sample graph with 32-byte Channel ids, so registry edge keys apply. */
function graph(): RouteGraphData {
  const g = sampleGraph();
  for (const e of g.edges) e.channelId = h32(e.channelId);
  return g;
}

function service(store: Store, now: { t: number }) {
  return new QuoteService({
    base: new StaticJsonSource(graph()),
    store,
    ledgers: LEDGERS,
    cursors: () => ({ [L]: store.getCursor(L) ?? null }),
    clock: () => now.t,
  });
}

const ETH_HEDERA = { origin: "eip155:1", destination: "hedera:mainnet", mode: "cheapest" as const };

describe("quote service", () => {
  it("quotes over the live graph and returns its inputs", async () => {
    const store = new Store();
    store.applyRange(L, [ev(L, G.applied(4, 1), { block: 7 })], { blockNumber: 7, blockHash: h32("b7") }, []);
    const now = { t: 1_800_000_000 };
    const q = await service(store, now).quote(ETH_HEDERA);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect((q.chosen as { ledgers: string[] }).ledgers).toEqual(["eip155:1", "hedera:mainnet"]);
    expect(q.perHop).toHaveLength(1);
    expect(q.pareto.length).toBeGreaterThan(0);
    expect(q.inputs.blocks[L]).toEqual({ blockNumber: 7, blockHash: h32("b7") });
    expect(q.inputs.registryVersions[L]).toBe(4);
    expect(q.inputs.registryLedger).toBe(L);
    expect(q.inputs.request).toMatchObject({ ...ETH_HEDERA, now: now.t });
    expect(q.inputs.graph.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("skips an edge the provider disabled, until the disable lapses", async () => {
    const store = new Store();
    const subject = keys.edge(h32("ch-eip155-1-hedera"), "hedera:mainnet");
    store.applyRange(L, [ev(L, G.disabled(1, subject, 1_800_000_500), { block: 1 })], { blockNumber: 1, blockHash: h32("b1") }, []);
    const now = { t: 1_800_000_000 };
    const svc = service(store, now);
    const q = await svc.quote(ETH_HEDERA);
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.reason).toBe("no-route");

    now.t = 1_800_000_600;
    expect((await svc.quote(ETH_HEDERA)).ok).toBe(true);
  });

  it("disables a ledger when its Router deployment is disabled", async () => {
    const store = new Store();
    // A deployment-specific Router disable on the destination.
    const svc = new QuoteService({
      base: new StaticJsonSource(graph()),
      store,
      ledgers: [{ ...LEDGERS[0]!, id: "hedera:mainnet" }],
      cursors: () => ({}),
      clock: () => 1_800_000_000,
    });
    store.applyRange("hedera:mainnet", [ev("hedera:mainnet", G.disabled(3, keys.router("hedera:mainnet", ADDR.router), 1_900_000_000), { block: 1 })], { blockNumber: 1, blockHash: h32("b1") }, []);
    const q = await svc.quote(ETH_HEDERA);
    expect(q.ok).toBe(false);
  });

  it("overlays on-chain certifications (µgCO2e → kgCO2e)", async () => {
    const store = new Store();
    const cert = (ledgerId: string, v: number) =>
      ev(L, G.cert({ certKey: h32(`${ledgerId}-energy`), ledgerId, label: 3, certified: true, effectiveFrom: 1_700_000_000, expiry: 1_810_000_000, emissionsUg: 2400, version: v }), { block: v });
    store.applyRange(L, [cert("eip155:1", 1), cert("hedera:mainnet", 2)], { blockNumber: 2, blockHash: h32("b2") }, []);
    const { graph: g } = await service(store, { t: 1_800_000_000 }).liveGraph();
    const c = g.ledger("eip155:1").certifications?.ENERGY;
    expect(c?.kgCO2ePerTx).toBeCloseTo(2.4e-6);
    expect(c?.source?.kind).toBe("on-chain");
  });

  it("lets a client re-check a quote against the graph snapshot", async () => {
    const store = new Store();
    const svc = service(store, { t: 1_800_000_000 });
    const q = (await svc.quote({ ...ETH_HEDERA, mode: "balanced", includeGraph: true })) as QuoteResponse;
    expect(q.graph).toBeDefined();
    expect(recheckQuote(q, q.graph!)).toEqual({ ok: true, problems: [] });
    expect(svc.graphByHash(q.inputs.graph.hash)).toEqual(q.graph);

    const tampered = structuredClone(q.graph!);
    tampered.edges[0]!.connectors[0]!.marginUsd += 1;
    expect(recheckQuote(q, tampered).problems).toContain("graph hash does not match the quote's inputs");
  });

  it("rejects malformed requests", async () => {
    const svc = service(new Store(), { t: 1 });
    await expect(svc.quote({ origin: "eip155:1" } as never)).rejects.toThrow(/origin and destination/);
    await expect(svc.quote({ ...ETH_HEDERA, mode: "teleport" as never })).rejects.toThrow(/unknown mode/);
  });
});

