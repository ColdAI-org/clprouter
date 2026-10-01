import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RouteGraph, StaticJsonSource, plan } from "../../src/index.js";

const file = (name: string) => fileURLToPath(new URL(`../../data/${name}`, import.meta.url));
const chains = JSON.parse(readFileSync(file("chains.json"), "utf8")) as {
  count: number;
  chains: Array<{
    key: string;
    name: string;
    caip2: { id: string | null; reason?: string };
    status: { class: string; text: string; source: string };
    trust: { text: string | null; tier: string | null };
    bundle: { gas: number | null; calldataBytes: number | null; reason?: string; txs?: Array<{ gas: { value: number; source: string } }> };
    toHiero: { status: string };
    fromHiero: { status: string };
  }>;
};

const HEDERA = "hedera:mainnet";
const ETH = "eip155:1";
const BSC = "eip155:56";
const STELLAR = "stellar:pubnet";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const NOW = new Date("2026-10-01T00:00:00Z");
const SOURCE = /^pr\/[-a-z0-9]+:[^#]+#L\d+$/;

describe("measured route data (sdk/data)", async () => {
  const g: RouteGraph = await new StaticJsonSource({ file: file("edges.json") }).load();

  it("chains.json has one sourced record per chain page", () => {
    expect(chains.chains.length).toBe(chains.count);
    expect(chains.count).toBeGreaterThanOrEqual(80);
    for (const c of chains.chains) {
      expect(c.status.source).toMatch(SOURCE);
      if (c.caip2.id === null) expect(c.caip2.reason).toBeTruthy();
      if (c.bundle.gas === null) expect(c.bundle.reason).toBeTruthy();
      for (const t of c.bundle.txs ?? []) expect(t.gas.source).toMatch(SOURCE);
      expect(c.fromHiero.status).toBe("blocked");
    }
  });

  it("loads through StaticJsonSource with every reachable chain wired to Hiero", () => {
    const reachable = chains.chains.filter((c) => c.toHiero.status !== "none");
    expect(g.ledgers().length).toBe(reachable.length + 1);
    for (const c of reachable) {
      const e = g.outgoing(c.caip2.id!).find((x) => x.to === HEDERA)!;
      expect(e.bundle.gas).toBe(c.bundle.gas);
      expect(e.status).toBe(c.toHiero.status);
    }
    // Hiero → chain is projected for every chain.
    expect(g.outgoing(HEDERA).every((e) => e.status === "projected")).toBe(true);
  });

  it("keeps the Hedera testnet measurement for Ethereum", () => {
    const e = g.outgoing(ETH).find((x) => x.to === HEDERA)!;
    expect(e.bundle.gas).toBe(1_645_052);
    expect(e.bundle.calldataBytes).toBe(19_140);
    expect(e.bundle.costNative).toBeCloseTo(1.58, 2);
    expect(g.ledger(HEDERA).gasPriceNative * 1_645_052).toBeCloseTo(e.bundle.costNative!, 6);
  });

  it("quotes chain → Hiero routes", () => {
    for (const origin of [ETH, BSC, STELLAR]) {
      const r = plan(g, { origin, destination: HEDERA, mode: "cheapest", now: NOW });
      expect(r.ok && r.route.ledgers).toEqual([origin, HEDERA]);
    }
    const eth = plan(g, { origin: ETH, destination: HEDERA, now: NOW });
    expect(eth.ok && eth.route.effectiveTrustTier).toBe("committee");
    const floor = plan(g, { origin: ETH, destination: HEDERA, now: NOW, constraints: { trustFloor: "light-client" } });
    expect(floor.ok).toBe(false);
  });

  it("in-progress chains are projected; Hiero → chain is blocked", () => {
    expect(plan(g, { origin: BTC, destination: HEDERA, now: NOW }).ok).toBe(false);
    const btc = plan(g, { origin: BTC, destination: HEDERA, now: NOW, constraints: { allowProjected: true } });
    expect(btc.ok && btc.route.ledgers).toEqual([BTC, HEDERA]);
    expect(plan(g, { origin: ETH, destination: STELLAR, now: NOW }).ok).toBe(false);
    const via = plan(g, { origin: ETH, destination: STELLAR, mode: "greenest", now: NOW, constraints: { allowProjected: true } });
    expect(via.ok && via.route.ledgers).toEqual([ETH, HEDERA, STELLAR]);
  });

  it("fastest uses the measured finality where the source states it", () => {
    const btc = g.outgoing(BTC).find((x) => x.to === HEDERA)!;
    expect(btc.timing.sourceFinalityS).toBe(3600);
    expect(btc.synthetic).not.toContain("timing.sourceFinalityS");
  });
});
