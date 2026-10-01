import { describe, expect, it } from "vitest";
import { RouteGraph, plan, sampleGraph } from "../src/index.js";

const HEDERA = "hedera:mainnet";
const ETH = "eip155:1";
const BSC = "eip155:56";
const STELLAR = "stellar:pubnet";
const XRPL = "xrpl:0";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const CANTON = "canton:global";
const NOW = new Date("2026-10-01T00:00:00Z");

describe("sample graph", () => {
  const data = sampleGraph();
  const g = new RouteGraph(data);

  it("is a valid graph with measured bundle figures where we have them", () => {
    const eth = g.edges().find((e) => e.from === ETH && e.to === HEDERA)!;
    expect(eth.bundle.gas).toBe(1_645_052);
    expect(eth.bundle.costNative).toBe(1.58);
    expect(eth.bundle.source?.kind).toBe("measured");
    expect(eth.finalized).toBe(false); // the verifier checks the attested header
    const bsc = g.edges().find((e) => e.from === BSC && e.to === HEDERA)!;
    expect(bsc.bundle.gas).toBe(1_953_408);
    // Hedera's gas price is derived from the measured 1.58 HBAR bundle.
    expect(g.ledger(HEDERA).gasPriceNative * 1_645_052).toBeCloseTo(1.58);
  });

  it("marks every non-measured figure as synthetic", () => {
    for (const e of g.edges()) {
      expect(e.synthetic).toEqual(expect.arrayContaining(["timing", "connectors", "history", "offChain"]));
      if (e.bundle.source?.kind !== "measured") expect(e.bundle.source?.kind).toBe("synthetic");
    }
    for (const l of g.ledgers()) expect(l.synthetic?.length).toBeGreaterThan(0);
  });

  it("chain → Hiero routes work today", () => {
    const r = plan(g, { origin: ETH, destination: HEDERA, now: NOW });
    expect(r.ok && r.route.ledgers).toEqual([ETH, HEDERA]);
    expect(r.ok && r.route.effectiveTrustTier).toBe("committee");
  });

  it("Hiero → chain is blocked today, so chain → chain has no route", () => {
    const r = plan(g, { origin: ETH, destination: STELLAR, now: NOW });
    expect(r.ok).toBe(false);
  });

  it("with projected Channels, chain → chain routes go through Hiero", () => {
    const r = plan(g, { origin: ETH, destination: STELLAR, now: NOW, constraints: { allowProjected: true } });
    expect(r.ok && r.route.ledgers).toEqual([ETH, HEDERA, STELLAR]);
  });

  it("fastest + ISO 20022 + MiCA: Stellar ↔ Hedera is the first compliant route", () => {
    const r = plan(g, { origin: STELLAR, destination: HEDERA, mode: "fastest", filters: { iso20022: true, mica: true }, now: NOW });
    expect(r.ok && r.route.ledgers).toEqual([STELLAR, HEDERA]);
    const eth = plan(g, { origin: ETH, destination: HEDERA, filters: { iso20022: true }, now: NOW });
    expect(eth.ok).toBe(false);
    expect(!eth.ok && eth.reason).toBe("no-compliant-route");
  });

  it("XRPL → Hiero is paused, so an XRPL route has to wait", () => {
    expect(plan(g, { origin: XRPL, destination: HEDERA, now: NOW }).ok).toBe(false);
    const r = plan(g, { origin: STELLAR, destination: XRPL, filters: { iso20022: true, mica: true }, now: NOW, constraints: { allowProjected: true } });
    expect(r.ok && r.route.ledgers).toEqual([STELLAR, HEDERA, XRPL]);
  });

  it("greenest from Bitcoin still starts at Bitcoin, and the ENERGY cap excludes it", () => {
    const r = plan(g, { origin: BTC, destination: HEDERA, mode: "greenest", now: NOW });
    expect(r.ok && r.route.totals.kgCO2e).toBeGreaterThan(100);
    const capped = plan(g, { origin: BTC, destination: HEDERA, mode: "greenest", filters: { energy: { capKgPerTx: 1 } }, now: NOW });
    expect(capped.ok).toBe(false);
  });

  it("trust floor light-client rules out the attested Canton Channel", () => {
    expect(plan(g, { origin: CANTON, destination: HEDERA, now: NOW }).ok).toBe(true);
    const r = plan(g, { origin: CANTON, destination: HEDERA, constraints: { trustFloor: "light-client" }, now: NOW });
    expect(r.ok).toBe(false);
  });

  it("warns about synthetic figures in every quote", () => {
    const r = plan(g, { origin: BSC, destination: HEDERA, mode: "cheapest", now: NOW });
    expect(r.ok && r.warnings.join()).toContain("synthetic");
  });
});
