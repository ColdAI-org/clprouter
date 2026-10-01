import type { EmissionsFigure, HopQuote } from "./metrics.js";
import type { DataSource, TrustTier } from "./types.js";
import { weakestTier } from "./types.js";

export interface EmissionsSource {
  ledger: string;
  basis: EmissionsFigure["basis"];
  kgCO2ePerTx: number;
  uncertifiedDefault: boolean;
  source?: DataSource;
}

export interface RouteQuote {
  /** Stable key: the edge ids joined by `|`. */
  key: string;
  /** Ledgers visited, origin first. */
  ledgers: string[];
  hops: HopQuote[];
  totals: {
    costUsd: number;
    timeP90S: number;
    /** Product of per-hop success probabilities. */
    successProbability: number;
    kgCO2e: number;
  };
  /** The weakest hop's trust tier: a route is only as strong as its weakest hop. */
  effectiveTrustTier: TrustTier;
  emissions: {
    perHopKg: number[];
    totalKg: number;
    /** Emissions figure per ledger with its data source and date. */
    sources: EmissionsSource[];
    /** Ledgers ranked at the conservative default because they hold no certified figure. */
    uncertifiedLedgers: string[];
  };
  /** Synthetic (placeholder) figures the quote depends on. */
  synthetic: string[];
  /** Balanced mode only: the normalised weighted score (lower is better). */
  balancedScore?: number;
}

export function buildRouteQuote(hops: HopQuote[]): RouteQuote {
  if (hops.length === 0) throw new Error("a route needs at least one hop");
  const sources = new Map<string, EmissionsSource>();
  for (const h of hops) {
    for (const f of h.carbon.figures) {
      if (!sources.has(f.ledger)) {
        sources.set(f.ledger, {
          ledger: f.ledger,
          basis: f.basis,
          kgCO2ePerTx: f.kgCO2ePerTx,
          uncertifiedDefault: f.uncertifiedDefault,
          source: f.source,
        });
      }
    }
  }
  const perHopKg = hops.map((h) => h.carbon.totalKg);
  const totalKg = perHopKg.reduce((a, b) => a + b, 0);
  return {
    key: hops.map((h) => h.edgeId).join("|"),
    ledgers: [hops[0]!.from, ...hops.map((h) => h.to)],
    hops,
    totals: {
      costUsd: hops.reduce((s, h) => s + h.cost.totalUsd, 0),
      timeP90S: hops.reduce((s, h) => s + h.timeP90S, 0),
      successProbability: hops.reduce((s, h) => s * h.successProbability, 1),
      kgCO2e: totalKg,
    },
    effectiveTrustTier: weakestTier(hops.map((h) => h.trustTier)),
    emissions: {
      perHopKg,
      totalKg,
      sources: [...sources.values()],
      uncertifiedLedgers: [...sources.values()].filter((s) => s.uncertifiedDefault).map((s) => s.ledger),
    },
    synthetic: [...new Set(hops.flatMap((h) => h.synthetic))],
  };
}
