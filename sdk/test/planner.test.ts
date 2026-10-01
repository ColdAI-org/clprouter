import { describe, expect, it } from "vitest";
import type { PlanRequest, PlanResult, PlanSuccess, RouteGraphData } from "../src/index.js";
import { RouteGraph, plan } from "../src/index.js";
import { A, B, D, H, NOW, W1, W2, W3, X, Y, Z, cert, edge, fixtureGraph, ledger } from "./fixtures.js";

function run(req: Partial<PlanRequest> = {}, g: RouteGraphData = fixtureGraph()): PlanResult {
  return plan(g, { origin: A, destination: B, now: NOW, ...req });
}

function ok(r: PlanResult): PlanSuccess {
  if (!r.ok) throw new Error(`expected a route, got ${r.reason}: ${r.details.join("; ")}`);
  return r;
}

const path = (r: PlanResult) => ok(r).route.ledgers;

describe("modes", () => {
  it("cheapest picks the lowest total cost within the default 3 hops", () => {
    const r = ok(run({ mode: "cheapest" }));
    expect(r.route.ledgers).toEqual([A, X, B]);
    expect(r.route.totals.costUsd).toBeCloseTo(1.0);
  });

  it("fastest picks the lowest p90 time", () => {
    const r = ok(run({ mode: "fastest" }));
    expect(r.route.ledgers).toEqual([A, Y, B]);
    expect(r.route.totals.timeP90S).toBe(4);
  });

  it("most reliable picks the highest success probability", () => {
    const r = ok(run({ mode: "reliable" }));
    expect(r.route.ledgers).toEqual([A, H, B]);
    expect(r.route.totals.successProbability).toBeGreaterThan(0.99);
  });

  it("most reliable prepares a node-disjoint fallback", () => {
    const r = ok(run({ mode: "reliable" }));
    expect(r.fallback).toBeDefined();
    expect(r.fallback!.disjointness).toBe("node");
    expect(r.fallback!.route.ledgers).toEqual([A, Z, B]);
    const primaryEdges = new Set(r.route.hops.map((h) => h.edgeId));
    expect(r.fallback!.route.hops.some((h) => primaryEdges.has(h.edgeId))).toBe(false);
  });

  it("most reliable falls back to an edge-disjoint route when every route shares a ledger", () => {
    const g: RouteGraphData = {
      ledgers: [ledger(A), ledger(H), ledger(B)],
      edges: [
        edge(A, H),
        edge(H, B),
        { ...edge(A, H, { attempts: 100, successes: 90 }), channelId: "ch-alt" },
        { ...edge(H, B, { attempts: 100, successes: 90 }), channelId: "ch-alt" },
      ],
    };
    const r = ok(run({ mode: "reliable" }, g));
    expect(r.fallback?.disjointness).toBe("edge");
    expect(r.fallback?.route.hops[0]!.channelId).toBe("ch-alt");
  });

  it("most reliable warns when no disjoint fallback exists", () => {
    const g: RouteGraphData = { ledgers: [ledger(A), ledger(B)], edges: [edge(A, B)] };
    const r = ok(run({ mode: "reliable" }, g));
    expect(r.fallback).toBeUndefined();
    expect(r.warnings).toContain("no disjoint fallback route exists");
  });

  it("greenest picks the least kgCO2e", () => {
    const r = ok(run({ mode: "greenest" }));
    expect(r.route.ledgers).toEqual([A, Z, B]);
    // hop 1: A enqueue (1 tx × 0.01) + Z bundle share (1 tx × 0.0001); hop 2 mirrors it
    expect(r.route.totals.kgCO2e).toBeCloseTo(0.0202, 6);
  });

  it("greenest breaks ties by cost", () => {
    const g = fixtureGraph();
    // Make the hub exactly as green as Z: A-H-B (cost 2) now ties A-Z-B (cost 5) on carbon.
    g.ledgers.find((l) => l.id === H)!.certifications!.ENERGY = cert(0.0001);
    g.ledgers.find((l) => l.id === H)!.certifications!.MICA = cert(0.0001);
    const r = ok(run({ mode: "greenest" }, g));
    expect(r.route.ledgers).toEqual([A, H, B]);
  });

  it("greenest ranks uncertified networks at the highest certified figure and flags them", () => {
    const r = ok(run({ mode: "cheapest" }));
    expect(r.route.ledgers).toEqual([A, X, B]);
    const xs = r.route.emissions.sources.find((s) => s.ledger === X)!;
    expect(xs.uncertifiedDefault).toBe(true);
    expect(xs.kgCO2ePerTx).toBe(0.5); // Y's figure is the highest certified one
    expect(r.route.emissions.uncertifiedLedgers).toEqual([X]);
    expect(r.warnings.join()).toContain("no certified emissions figure for test:x");
  });

  it("greenest avoids a proof-of-work hop unless an end is one", () => {
    const g = fixtureGraph();
    // Z becomes a PoW network: 400 kg/tx. Greenest must move to the hub.
    g.ledgers.find((l) => l.id === Z)!.certifications = { ENERGY: cert(400) };
    expect(path(run({ mode: "greenest" }, g))).toEqual([A, H, B]);
    // ...but if Z is the origin, the route still starts there.
    expect(path(plan(g, { origin: Z, destination: B, mode: "greenest", now: NOW }))).toEqual([Z, B]);
  });

  it("counts off-chain proof and relay energy × grid intensity", () => {
    const g = fixtureGraph();
    for (const e of g.edges) if (e.from === A && e.to === Z) e.offChain = { kWhPerBundle: 10, gridKgPerKWh: 0.5 };
    const r = ok(run({ mode: "greenest" }, g));
    expect(r.route.ledgers).toEqual([A, H, B]); // 5 kg of proving makes Z dirtier than the hub
  });

  it("balanced (the default) picks by normalised weighted score from the Pareto set", () => {
    const r = ok(run());
    expect(r.mode).toBe("balanced");
    expect(r.route.ledgers).toEqual([A, H, B]);
    expect(r.route.balancedScore).toBeGreaterThanOrEqual(0);
    expect(r.pareto.map((p) => p.key)).toContain(r.route.key);
  });

  it("balanced follows the weights", () => {
    expect(path(run({ balancedWeights: { cost: 1, time: 0, reliability: 0, carbon: 0 } }))).toEqual([A, X, B]);
    expect(path(run({ balancedWeights: { cost: 0, time: 1, reliability: 0, carbon: 0 } }))).toEqual([A, Y, B]);
    expect(path(run({ balancedWeights: { cost: 0, time: 0, reliability: 0, carbon: 1 } }))).toEqual([A, Z, B]);
  });

  it("most reliable picks the Connector with the best track record; other modes the lowest margin", () => {
    const g = fixtureGraph();
    const e = g.edges.find((x) => x.from === A && x.to === H)!;
    e.connectors = [
      { id: "cheap", marginUsd: 0.1, balanceUsd: 100, successRate: 0.9 },
      { id: "solid", marginUsd: 0.5, balanceUsd: 100, successRate: 0.999 },
    ];
    expect(ok(run({ mode: "reliable" }, g)).route.hops[0]!.connectorId).toBe("solid");
    const cheapest = ok(run({ mode: "cheapest", constraints: { excludedLedgers: [X, Y, Z, D] } }, g));
    expect(cheapest.route.hops[0]!.connectorId).toBe("cheap");
  });
});

describe("Pareto set", () => {
  it("holds every non-dominated route and drops dominated ones", () => {
    const r = ok(run({ mode: "cheapest" }));
    const sets = r.pareto.map((p) => p.ledgers.join(">"));
    for (const via of [H, X, Y, Z]) expect(sets).toContain([A, via, B].join(">"));
    expect(sets).not.toContain([A, D, B].join(">"));
  });

  it("no route in the Pareto set dominates another", () => {
    const r = ok(run());
    for (const a of r.pareto) {
      for (const b of r.pareto) {
        if (a === b) continue;
        const le =
          a.totals.costUsd <= b.totals.costUsd &&
          a.totals.timeP90S <= b.totals.timeP90S &&
          a.totals.successProbability >= b.totals.successProbability &&
          a.totals.kgCO2e <= b.totals.kgCO2e;
        const lt =
          a.totals.costUsd < b.totals.costUsd ||
          a.totals.timeP90S < b.totals.timeP90S ||
          a.totals.successProbability > b.totals.successProbability ||
          a.totals.kgCO2e < b.totals.kgCO2e;
        expect(le && lt).toBe(false);
      }
    }
  });

  it("the chosen route is in the Pareto set in every mode", () => {
    for (const mode of ["cheapest", "fastest", "reliable", "greenest", "balanced"] as const) {
      const r = ok(run({ mode }));
      expect(r.pareto.map((p) => p.key)).toContain(r.route.key);
    }
  });

  it("collapses to one route when one route wins everything", () => {
    const g: RouteGraphData = {
      ledgers: [ledger(A, { ENERGY: cert(0.01) }), ledger(H, { ENERGY: cert(0.01) }), ledger(D, { ENERGY: cert(0.3) }), ledger(B, { ENERGY: cert(0.01) })],
      edges: [edge(A, H), edge(H, B), edge(A, D, { cost: 9, time: 99, attempts: 10, successes: 5 }), edge(D, B, { cost: 9, time: 99, attempts: 10, successes: 5 })],
    };
    const r = ok(run({}, g));
    expect(r.pareto).toHaveLength(1);
    expect(r.candidates).toBe(2);
  });
});

describe("constraints", () => {
  it("max hops defaults to 3 and can be raised", () => {
    expect(path(run({ mode: "cheapest" }))).toEqual([A, X, B]);
    const r = ok(run({ mode: "cheapest", constraints: { maxHops: 4 } }));
    expect(r.route.ledgers).toEqual([A, W1, W2, W3, B]);
    expect(r.route.totals.costUsd).toBeCloseTo(0.4);
  });

  it("max hops can be lowered to force a direct Channel", () => {
    const r = run({ mode: "cheapest", constraints: { maxHops: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-route");
  });

  it("deadline drops routes whose p90 time is too long", () => {
    expect(path(run({ mode: "cheapest", constraints: { deadlineS: 20 } }))).toEqual([A, H, B]);
    expect(path(run({ mode: "cheapest", constraints: { deadlineS: 5 } }))).toEqual([A, Y, B]);
    expect(run({ mode: "cheapest", constraints: { deadlineS: 3 } }).ok).toBe(false);
  });

  it("max fee drops routes that cost too much", () => {
    expect(path(run({ mode: "fastest", constraints: { maxFeeUsd: 2 } }))).toEqual([A, H, B]);
    expect(path(run({ mode: "fastest", constraints: { maxFeeUsd: 1.5 } }))).toEqual([A, X, B]);
    expect(run({ mode: "fastest", constraints: { maxFeeUsd: 0.5 } }).ok).toBe(false);
  });

  it("trust floor drops hops below the floor", () => {
    expect(path(run({ mode: "cheapest", constraints: { trustFloor: "committee" } }))).toEqual([A, H, B]);
    expect(path(run({ mode: "fastest", constraints: { trustFloor: "light-client" } }))).toEqual([A, H, B]);
    expect(run({ mode: "fastest", constraints: { trustFloor: "validity-proof" } }).ok).toBe(false);
  });

  it("reports the effective trust tier as the weakest hop", () => {
    const g = fixtureGraph();
    g.edges.find((e) => e.from === H && e.to === B)!.trustTier = "committee";
    g.edges.find((e) => e.from === A && e.to === H)!.trustTier = "validity-proof";
    const r = ok(run({ mode: "reliable" }, g));
    expect(r.route.ledgers).toEqual([A, H, B]);
    expect(r.route.effectiveTrustTier).toBe("committee");
  });

  it("excluded ledgers are never visited", () => {
    expect(path(run({ mode: "reliable", constraints: { excludedLedgers: [H] } }))).toEqual([A, Z, B]);
  });

  it("excluding the origin or destination leaves no route", () => {
    const r = run({ constraints: { excludedLedgers: [B] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details.join()).toContain("excluded by the sender");
  });

  it("excluded jurisdictions drop ledgers whose operated Router or governing entity is there", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === H)!.operatedRouter!.jurisdiction = "US";
    g.ledgers.find((l) => l.id === Z)!.jurisdictions = ["us"];
    expect(path(run({ mode: "reliable", constraints: { excludedJurisdictions: ["US"] } }, g))).not.toContain(H);
    expect(path(run({ mode: "greenest", constraints: { excludedJurisdictions: ["US"] } }, g))).not.toContain(Z);
  });

  it("finalized-only drops Channels that verify non-finalized state", () => {
    const g = fixtureGraph();
    for (const e of g.edges) if (e.from === Y || e.to === Y) e.finalized = false;
    expect(path(run({ mode: "fastest" }, g))).toEqual([A, Y, B]);
    expect(path(run({ mode: "fastest", constraints: { finalizedOnly: true } }, g))).toEqual([A, H, B]);
  });

  it("payload size counts the envelope overhead on every hop", () => {
    expect(path(run({ mode: "cheapest", payloadBytes: 100 }))).toEqual([A, X, B]);
    expect(path(run({ mode: "cheapest", payloadBytes: 600 }))).toEqual([A, H, B]); // X hops carry 1 KiB
    expect(run({ mode: "cheapest", payloadBytes: 70000 }).ok).toBe(false);
  });

  it("never visits a ledger twice", () => {
    const g = fixtureGraph();
    g.edges.push(edge(H, A, { cost: 0 }), edge(X, H, { cost: 0 }));
    const r = ok(run({ mode: "cheapest", k: 50 }, g));
    for (const p of [r.route, ...r.pareto]) expect(new Set(p.ledgers).size).toBe(p.ledgers.length);
  });

  it("combines constraints", () => {
    const r = ok(
      run({ mode: "cheapest", constraints: { maxFeeUsd: 6, deadlineS: 80, trustFloor: "light-client", excludedLedgers: [H] } }),
    );
    expect(r.route.ledgers).toEqual([A, Z, B]);
  });
});

describe("compliance filters", () => {
  it("fastest + ISO20022: quickest route over ISO 20022 networks only", () => {
    const r = ok(run({ mode: "fastest", filters: { iso20022: true } }));
    expect(r.route.ledgers).toEqual([A, Y, B]);
    expect(r.filters).toEqual(["ISO20022"]);
    expect(r.plannedAt).toBe(1790812800);
  });

  it("cheapest + ISO20022 skips the uncertified cheap route", () => {
    expect(path(run({ mode: "cheapest", filters: { iso20022: true } }))).toEqual([A, H, B]);
  });

  it("cheapest + MICA uses only MiCA networks", () => {
    expect(path(run({ mode: "cheapest", filters: { mica: true } }))).toEqual([A, H, B]);
  });

  it("greenest + MICA + ENERGY", () => {
    const r = ok(run({ mode: "greenest", filters: { mica: true, energy: true } }));
    expect(r.route.ledgers).toEqual([A, Z, B]);
    expect(r.plannedAt).toBe(1790812800);
    for (const s of r.route.emissions.sources) expect(s.basis).toBe("MICA");
  });

  it("greenest + MICA needs the figure from the MiCA disclosure", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === Z)!.certifications!.MICA = cert(undefined);
    expect(path(run({ mode: "greenest", filters: { mica: true } }, g))).toEqual([A, H, B]);
    // Other modes under MICA do not need the figure.
    expect(path(run({ mode: "fastest", filters: { mica: true }, constraints: { excludedLedgers: [H] } }, g))).toEqual([A, Z, B]);
  });

  it("ENERGY excludes uncertified networks", () => {
    expect(path(run({ mode: "cheapest", filters: { energy: true } }))).toEqual([A, H, B]);
  });

  it("ENERGY with a cap excludes networks above it", () => {
    expect(path(run({ mode: "fastest", filters: { energy: true } }))).toEqual([A, Y, B]);
    expect(path(run({ mode: "fastest", filters: { energy: { capKgPerTx: 0.1 } } }))).toEqual([A, H, B]);
    const r = run({ mode: "fastest", filters: { energy: { capKgPerTx: 0.001 } } });
    expect(r.ok).toBe(false);
  });

  it("most reliable + ISO20022 + MICA", () => {
    const r = ok(run({ mode: "reliable", filters: { iso20022: true, mica: true } }));
    expect(r.route.ledgers).toEqual([A, H, B]);
    expect(r.fallback).toBeUndefined(); // Y lacks MICA, Z lacks ISO: no compliant fallback
  });

  it("cheapest + ISO20022 + MICA + ENERGY", () => {
    expect(path(run({ mode: "cheapest", filters: { iso20022: true, mica: true, energy: true } }))).toEqual([A, H, B]);
  });

  it("balanced + every filter", () => {
    expect(path(run({ filters: { iso20022: true, mica: true, energy: { capKgPerTx: 1 } } }))).toEqual([A, H, B]);
  });

  it("returns no compliant route when filters leave nothing; never falls back", () => {
    const g = fixtureGraph();
    delete g.ledgers.find((l) => l.id === H)!.certifications!.ISO20022;
    g.ledgers.find((l) => l.id === Y)!.certifications!.ISO20022 = cert(undefined, { status: "revoked" });
    const r = run({ mode: "fastest", filters: { iso20022: true } }, g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-compliant-route");
      expect(r.details.join()).toContain("test:hub has no valid ISO20022 certification");
    }
  });

  it("checks the origin and destination too", () => {
    const g = fixtureGraph();
    delete g.ledgers.find((l) => l.id === B)!.certifications!.MICA;
    const r = run({ mode: "cheapest", filters: { mica: true } }, g);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-compliant-route");
      expect(r.details).toEqual(["MICA: test:b has no valid MICA certification"]);
    }
  });

  it("expired certifications do not count", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === Y)!.certifications!.ISO20022 = cert(undefined, { expiresAt: "2026-09-30T00:00:00Z" });
    expect(path(run({ mode: "fastest", filters: { iso20022: true } }, g))).toEqual([A, H, B]);
  });

  it("ISO20022 needs an identified operated Router; MICA an authorised CASP", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === Y)!.operatedRouter!.identified = false;
    g.ledgers.find((l) => l.id === H)!.operatedRouter!.caspAuthorised = false;
    expect(path(run({ mode: "fastest", filters: { iso20022: true } }, g))).toEqual([A, H, B]);
    expect(path(run({ mode: "cheapest", filters: { mica: true } }, g))).toEqual([A, Z, B]);
  });

  it("without filters the registry is not consulted", () => {
    const g = fixtureGraph();
    for (const l of g.ledgers) l.certifications = {};
    const r = ok(run({ mode: "cheapest" }, g));
    expect(r.filters).toEqual([]);
    expect(r.route.ledgers).toEqual([A, X, B]);
  });
});

describe("route safety and Channel state", () => {
  it("skips disabled edges", () => {
    const g = fixtureGraph();
    g.edges.find((e) => e.from === A && e.to === X)!.disabled = true;
    expect(path(run({ mode: "cheapest" }, g))).toEqual([A, H, B]);
  });

  it("skips disabled ledgers", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === H)!.disabled = true;
    expect(path(run({ mode: "reliable" }, g))).toEqual([A, Z, B]);
  });

  it("a disabled origin or destination leaves no route", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === A)!.disabled = true;
    const r = run({}, g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details.join()).toContain("disabled by the provider");
  });

  it("skips ledgers running a disabled Router version", () => {
    const g = fixtureGraph();
    g.ledgers.find((l) => l.id === X)!.routerVersion = 9;
    g.disabledRouterVersions = [9];
    expect(path(run({ mode: "cheapest" }, g))).toEqual([A, H, B]);
  });

  it("skips paused and closed Channels", () => {
    const g = fixtureGraph();
    g.edges.find((e) => e.from === X && e.to === B)!.status = "paused";
    g.edges.find((e) => e.from === A && e.to === Y)!.status = "closed";
    expect(path(run({ mode: "cheapest" }, g))).toEqual([A, H, B]);
    expect(path(run({ mode: "fastest" }, g))).toEqual([A, H, B]);
  });

  it("uses projected Channels only when asked", () => {
    const g: RouteGraphData = { ledgers: [ledger(A), ledger(B)], edges: [edge(A, B, { status: "projected" })] };
    expect(run({}, g).ok).toBe(false);
    expect(path(run({ constraints: { allowProjected: true } }, g))).toEqual([A, B]);
  });

  it("skips edges whose Connectors cannot fund delivery", () => {
    const g = fixtureGraph();
    const e = g.edges.find((x) => x.from === X && x.to === B)!;
    g.ledgers.find((l) => l.id === B)!.gasPriceNative = 1;
    g.ledgers.find((l) => l.id === B)!.execGasPerMessage = 10; // delivery costs 10 USD on B
    e.connectors[0]!.balanceUsd = 5;
    const r = ok(run({ mode: "cheapest" }, g));
    expect(r.route.ledgers).not.toEqual([A, X, B]);
  });
});

describe("no-route cases", () => {
  it("unknown ledgers", () => {
    const r = plan(fixtureGraph(), { origin: "test:nope", destination: B });
    expect(r.ok).toBe(false);
  });

  it("origin equals destination", () => {
    const r = plan(fixtureGraph(), { origin: A, destination: A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-route");
  });

  it("disconnected graph", () => {
    const g: RouteGraphData = { ledgers: [ledger(A), ledger(B), ledger(H)], edges: [edge(A, H)] };
    const r = run({}, g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-route");
  });

  it("wrong direction only (Channels are directed)", () => {
    const g: RouteGraphData = { ledgers: [ledger(A), ledger(B)], edges: [edge(B, A)] };
    expect(run({}, g).ok).toBe(false);
  });
});

describe("quotes", () => {
  it("per-hop and total cost, time, success probability and kgCO2e", () => {
    const r = ok(run({ mode: "reliable" }));
    const { route } = r;
    expect(route.hops).toHaveLength(2);
    const sum = (f: (h: (typeof route.hops)[number]) => number) => route.hops.reduce((s, h) => s + f(h), 0);
    expect(route.totals.costUsd).toBeCloseTo(sum((h) => h.cost.totalUsd));
    expect(route.totals.timeP90S).toBeCloseTo(sum((h) => h.timeP90S));
    expect(route.totals.kgCO2e).toBeCloseTo(sum((h) => h.carbon.totalKg));
    expect(route.totals.successProbability).toBeCloseTo(route.hops.reduce((s, h) => s * h.successProbability, 1));
    expect(route.emissions.perHopKg).toEqual(route.hops.map((h) => h.carbon.totalKg));
    for (const s of route.emissions.sources) {
      expect(s.source?.date).toBe("2026-09-30");
      expect(s.basis).toBe("ENERGY");
    }
  });

  it("costs margin + enqueue + bundle share + execution", () => {
    const g: RouteGraphData = {
      ledgers: [
        ledger(A, {}, { gasPriceNative: 1e-9, nativeUsd: 2000, enqueueGas: 100_000 }),
        ledger(B, {}, { gasPriceNative: 1e-6, nativeUsd: 0.2, execGasPerMessage: 50_000 }),
      ],
      edges: [{ ...edge(A, B, { cost: 0.05 }), bundle: { gas: 1_000_000, calldataBytes: 0, messagesPerBundle: 4 } }],
    };
    const c = ok(run({}, g)).route.hops[0]!.cost;
    expect(c.connectorMarginUsd).toBeCloseTo(0.05);
    expect(c.enqueueUsd).toBeCloseTo(0.2); // 1e5 × 1e-9 × 2000
    expect(c.bundleShareUsd).toBeCloseTo(0.05); // 1e6 × 1e-6 × 0.2 / 4
    expect(c.executionUsd).toBeCloseTo(0.01); // 5e4 × 1e-6 × 0.2
    expect(c.totalUsd).toBeCloseTo(0.31);
  });

  it("uses a measured bundle cost in native units when present", () => {
    const g: RouteGraphData = {
      ledgers: [ledger(A), ledger(B, {}, { nativeUsd: 0.2, gasPriceNative: 1 })],
      edges: [{ ...edge(A, B, { cost: 0 }), bundle: { gas: 1_645_052, calldataBytes: 19_140, messagesPerBundle: 1, costNative: 1.58 } }],
    };
    expect(ok(run({}, g)).route.hops[0]!.cost.bundleShareUsd).toBeCloseTo(0.316);
  });

  it("gas-weights on-chain emissions against the network's average transaction", () => {
    const g: RouteGraphData = {
      ledgers: [
        ledger(A, { ENERGY: cert(0.01) }, { avgTxGas: 100_000, enqueueGas: 50_000 }),
        ledger(B, { ENERGY: cert(0.02) }, { avgTxGas: 100_000, execGasPerMessage: 100_000 }),
      ],
      edges: [{ ...edge(A, B), bundle: { gas: 2_000_000, calldataBytes: 0, messagesPerBundle: 10 } }],
    };
    const c = ok(run({ mode: "greenest" }, g)).route.hops[0]!.carbon;
    expect(c.sourceTxs).toBeCloseTo(0.5);
    expect(c.destTxs).toBeCloseTo(3); // (2e6/10 + 1e5) / 1e5
    expect(c.onChainKg).toBeCloseTo(0.5 * 0.01 + 3 * 0.02);
  });

  it("lists synthetic figures the quote depends on", () => {
    const g = fixtureGraph();
    g.edges.find((e) => e.from === A && e.to === H)!.synthetic = ["timing"];
    const r = ok(run({ mode: "reliable" }, g));
    expect(r.route.synthetic).toContain(`edge ch-${A}-${H}:${A}->${H}: timing`);
    expect(r.warnings.join()).toContain("synthetic");
  });

  it("accepts a prebuilt RouteGraph", () => {
    const r = plan(new RouteGraph(fixtureGraph()), { origin: A, destination: B, mode: "fastest", now: NOW });
    expect(path(r)).toEqual([A, Y, B]);
  });
});

describe("graph validation", () => {
  it("rejects bad CAIP-2 ids, unknown ledgers, self loops and duplicates", () => {
    expect(() => new RouteGraph({ ledgers: [ledger("NOT CAIP")], edges: [] })).toThrow(/CAIP-2/);
    expect(() => new RouteGraph({ ledgers: [ledger(A)], edges: [edge(A, B)] })).toThrow(/unknown ledger/);
    expect(() => new RouteGraph({ ledgers: [ledger(A)], edges: [edge(A, A)] })).toThrow(/self loop/);
    expect(() => new RouteGraph({ ledgers: [ledger(A), ledger(A)], edges: [] })).toThrow(/duplicate/);
    expect(() => new RouteGraph({ ledgers: [ledger(A), ledger(B)], edges: [edge(A, B), edge(A, B)] })).toThrow(/duplicate edge/);
  });
});
