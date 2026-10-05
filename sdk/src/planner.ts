import { activeFilters, ledgerFilterFailures } from "./filters.js";
import { RouteGraph, edgeId } from "./graph.js";
import type { HopQuote, MetricContext } from "./metrics.js";
import { hopQuote } from "./metrics.js";
import type { RouteQuote } from "./quote.js";
import { buildRouteQuote } from "./quote.js";
import type {
  BalancedWeights,
  Caip2,
  FilterLabel,
  Mode,
  PlanRequest,
  RouteGraphData,
} from "./types.js";
import { trustRank } from "./types.js";
import type { WEdge } from "./yen.js";
import { WeightedGraph, yenKShortest } from "./yen.js";

export const DEFAULT_MAX_HOPS = 3;
export const DEFAULT_K = 8;
export const DEFAULT_BALANCED_WEIGHTS: BalancedWeights = { cost: 0.3, time: 0.3, reliability: 0.2, carbon: 0.2 };

/** Estimated envelope overhead in bytes (route id, ends, CAIP-10 accounts, constraints, registry pins, per-hop ids). */
export function envelopeOverheadBytes(hops: number): number {
  return 384 + 96 * hops;
}

/** Cap on paths examined per objective, so a heavily constrained search always terminates quickly. */
const MAX_PATHS_PER_OBJECTIVE = 5000;

export type Objective = "cost" | "time" | "reliability" | "carbon";


export interface FallbackRoute {
  route: RouteQuote;
  /** `node`: shares no intermediate ledger and no edge with the primary; `edge`: shares no edge. */
  disjointness: "node" | "edge";
}

export interface PlanSuccess {
  ok: true;
  mode: Mode;
  filters: FilterLabel[];
  /** The route the mode picked from the Pareto set. */
  route: RouteQuote;
  /** Non-dominated routes over (cost, p90 time, failure probability, kgCO2e). Includes `route`. */
  pareto: RouteQuote[];
  /** Most-reliable mode: a disjoint fallback route, if one exists. */
  fallback?: FallbackRoute;
  /**
   * Unix seconds the plan was made at (`req.now`); certifications are judged valid as of this time. It is not a
   * registry version: the envelope pins `ProviderRegistry.version()` (a decision counter read from the origin
   * ledger), passed to `buildEnvelope` as `registryVersion`.
   */
  plannedAt: number;
  /** ENERGY filter cap the plan used, kgCO2e per transaction (the envelope carries it as µgCO2e, rounded up). */
  energyCapKgPerTx?: number;
  /** Number of constraint-satisfying candidate paths evaluated. */
  candidates: number;
  warnings: string[];
}

export interface PlanFailure {
  ok: false;
  /** `no-compliant-route` when filters are active; otherwise `no-route`. */
  reason: "no-compliant-route" | "no-route";
  details: string[];
}

export type PlanResult = PlanSuccess | PlanFailure;

interface Prepared {
  graph: RouteGraph;
  ctx: MetricContext;
  quotes: Map<string, HopQuote>;
  removedNodes: Map<Caip2, string[]>;
  maxHops: number;
}

function excludedReasons(graph: RouteGraph, req: PlanRequest, mode: Mode, now: Date): Map<Caip2, string[]> {
  const filters = activeFilters(req.filters);
  const c = req.constraints ?? {};
  const disabledVersions = new Set(graph.data.disabledRouterVersions ?? []);
  const excluded = new Set(c.excludedLedgers ?? []);
  const excludedJur = new Set((c.excludedJurisdictions ?? []).map((j) => j.toUpperCase()));
  const out = new Map<Caip2, string[]>();
  for (const l of graph.ledgers()) {
    const r: string[] = [];
    if (l.disabled) r.push(`${l.id} is disabled by the provider`);
    if (l.routerVersion && disabledVersions.has(l.routerVersion)) {
      r.push(`${l.id} runs disabled Router version ${l.routerVersion}`);
    }
    if (excluded.has(l.id)) r.push(`${l.id} is excluded by the sender`);
    const jur = [...(l.jurisdictions ?? []), ...(l.operatedRouter ? [l.operatedRouter.jurisdiction] : [])];
    const hit = jur.find((j) => excludedJur.has(j.toUpperCase()));
    if (hit) r.push(`${l.id} is in excluded jurisdiction ${hit}`);
    r.push(...ledgerFilterFailures(l, filters, mode, now));
    if (r.length) out.set(l.id, r);
  }
  return out;
}

function prepare(graphIn: RouteGraph | RouteGraphData, req: PlanRequest, mode: Mode): Prepared {
  const graph = graphIn instanceof RouteGraph ? graphIn : new RouteGraph(graphIn);
  const now = req.now ?? new Date();
  const filters = activeFilters(req.filters);
  const ctx: MetricContext = { graph, filters, mode, now, defaultKgPerTx: graph.maxCertifiedKgPerTx(now) };
  const c = req.constraints ?? {};
  const removedNodes = excludedReasons(graph, req, mode, now);
  const quotes = new Map<string, HopQuote>();
  for (const e of graph.edges()) {
    if (e.disabled || e.approved === false) continue;
    if (!(e.status === "active" || (e.status === "projected" && c.allowProjected))) continue;
    if (removedNodes.has(e.from) || removedNodes.has(e.to)) continue;
    if (c.trustFloor && trustRank(e.trustTier) < trustRank(c.trustFloor)) continue;
    if (c.finalizedOnly && !e.finalized) continue;
    if (req.payloadBytes !== undefined && req.payloadBytes + envelopeOverheadBytes(1) > e.maxPayloadBytes) continue;
    const q = hopQuote(e, ctx);
    if (q) quotes.set(edgeId(e), q);
  }
  return { graph, ctx, quotes, removedNodes, maxHops: c.maxHops ?? DEFAULT_MAX_HOPS };
}

function weightOf(q: HopQuote, o: Objective): number {
  switch (o) {
    case "cost":
      return q.cost.totalUsd;
    case "time":
      return q.timeP90S;
    case "reliability":
      return -Math.log(Math.max(q.successProbability, 1e-12));
    case "carbon":
      return q.carbon.totalKg;
  }
}

function weightedGraph(p: Prepared, o: Objective): WeightedGraph {
  const edges: WEdge[] = [];
  for (const q of p.quotes.values()) edges.push({ id: q.edgeId, from: q.from, to: q.to, weight: weightOf(q, o) });
  return new WeightedGraph(edges);
}

function pathConstraintFailure(route: RouteQuote, req: PlanRequest, maxHops: number, edgeMaxPayload: number[]): string | undefined {
  const c = req.constraints ?? {};
  if (route.hops.length > maxHops) return `more than ${maxHops} hops`;
  if (c.deadlineS !== undefined && route.totals.timeP90S > c.deadlineS) return "misses deadline";
  if (c.maxFeeUsd !== undefined && route.totals.costUsd > c.maxFeeUsd) return "over max fee";
  if (req.payloadBytes !== undefined) {
    const need = req.payloadBytes + envelopeOverheadBytes(route.hops.length);
    if (edgeMaxPayload.some((m) => need > m)) return "payload too large for a hop";
  }
  return undefined;
}

/**
 * Generate up to `k` constraint-satisfying routes in objective order. Because Yen enumerates simple paths in
 * non-decreasing weight, the first route returned is optimal for the objective under the path constraints.
 */
function candidatesFor(
  p: Prepared,
  req: PlanRequest,
  o: Objective,
  k: number,
  opts: { removedEdges?: Set<string>; removedNodes?: Set<string> } = {},
): RouteQuote[] {
  const g = weightedGraph(p, o);
  const out: RouteQuote[] = [];
  let examined = 0;
  for (const path of yenKShortest(g, req.origin, req.destination, opts)) {
    if (++examined > MAX_PATHS_PER_OBJECTIVE) break;
    // Yen yields in weight order, not hop order, so over-long paths are skipped rather than ending the search.
    if (path.edges.length > p.maxHops) continue;
    const hops = path.edges.map((e) => p.quotes.get(e.id)!);
    const route = buildRouteQuote(hops);
    const maxPayloads = path.edges.map((e) => p.graph.edge(e.id).maxPayloadBytes);
    if (pathConstraintFailure(route, req, p.maxHops, maxPayloads)) continue;
    out.push(route);
    if (out.length >= k) break;
  }
  return out;
}

function failureProb(r: RouteQuote): number {
  return 1 - r.totals.successProbability;
}

function dominates(a: RouteQuote, b: RouteQuote): boolean {
  const av = [a.totals.costUsd, a.totals.timeP90S, failureProb(a), a.totals.kgCO2e];
  const bv = [b.totals.costUsd, b.totals.timeP90S, failureProb(b), b.totals.kgCO2e];
  let strictly = false;
  for (let i = 0; i < av.length; i++) {
    if (av[i]! > bv[i]!) return false;
    if (av[i]! < bv[i]!) strictly = true;
  }
  return strictly;
}

export function paretoSet(routes: RouteQuote[]): RouteQuote[] {
  return routes.filter((r) => !routes.some((o) => o !== r && dominates(o, r)));
}

type Cmp = (a: RouteQuote, b: RouteQuote) => number;

const byKey: Cmp = (a, b) => a.key.localeCompare(b.key);
const COMPARATORS: Record<Exclude<Mode, "balanced">, Cmp> = {
  cheapest: (a, b) => a.totals.costUsd - b.totals.costUsd || a.totals.timeP90S - b.totals.timeP90S || byKey(a, b),
  fastest: (a, b) => a.totals.timeP90S - b.totals.timeP90S || a.totals.costUsd - b.totals.costUsd || byKey(a, b),
  reliable: (a, b) =>
    b.totals.successProbability - a.totals.successProbability || a.totals.costUsd - b.totals.costUsd || byKey(a, b),
  // Greenest: ties are broken by cost (spec).
  greenest: (a, b) => a.totals.kgCO2e - b.totals.kgCO2e || a.totals.costUsd - b.totals.costUsd || byKey(a, b),
};

/** Min-max normalised weighted score over the candidate set; lower is better. */
export function balancedScores(routes: RouteQuote[], w: BalancedWeights): Map<string, number> {
  const metrics: Array<[keyof BalancedWeights, (r: RouteQuote) => number]> = [
    ["cost", (r) => r.totals.costUsd],
    ["time", (r) => r.totals.timeP90S],
    ["reliability", failureProb],
    ["carbon", (r) => r.totals.kgCO2e],
  ];
  const scores = new Map<string, number>(routes.map((r) => [r.key, 0]));
  for (const [name, f] of metrics) {
    const vals = routes.map(f);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    for (const r of routes) {
      const n = hi > lo ? (f(r) - lo) / (hi - lo) : 0;
      scores.set(r.key, scores.get(r.key)! + w[name] * n);
    }
  }
  return scores;
}

function fallbackFor(p: Prepared, req: PlanRequest, primary: RouteQuote, k: number): FallbackRoute | undefined {
  const removedEdges = new Set(primary.hops.map((h) => h.edgeId));
  const intermediates = primary.ledgers.slice(1, -1);
  const tries: Array<["node" | "edge", Set<string>]> = [
    ["node", new Set(intermediates)],
    ["edge", new Set()],
  ];
  for (const [disjointness, removedNodes] of tries) {
    const c = candidatesFor(p, req, "reliability", k, { removedEdges, removedNodes });
    const best = c.sort(COMPARATORS.reliable)[0];
    if (best) return { route: best, disjointness };
  }
  return undefined;
}

/**
 * Plan a route. Filters are applied as hard pre-filters on every ledger (origin and destination included); the mode
 * is the objective. Returns the chosen route, the Pareto set and, in most-reliable mode, a disjoint fallback.
 */
export function plan(graphIn: RouteGraph | RouteGraphData, req: PlanRequest): PlanResult {
  const mode: Mode = req.mode ?? "balanced";
  const filters = activeFilters(req.filters);
  const failReason = filters.labels.length ? "no-compliant-route" : "no-route";
  const graph = graphIn instanceof RouteGraph ? graphIn : new RouteGraph(graphIn);
  for (const end of [req.origin, req.destination]) {
    if (!graph.hasLedger(end)) return { ok: false, reason: "no-route", details: [`unknown ledger ${end}`] };
  }
  if (req.origin === req.destination) {
    return { ok: false, reason: "no-route", details: ["origin and destination are the same ledger"] };
  }
  const p = prepare(graph, req, mode);
  const endReasons = [req.origin, req.destination].flatMap((l) => p.removedNodes.get(l) ?? []);
  if (endReasons.length) return { ok: false, reason: failReason, details: endReasons };

  const k = req.k ?? DEFAULT_K;
  const all = new Map<string, RouteQuote>();
  for (const o of ["cost", "time", "reliability", "carbon"] as Objective[]) {
    for (const r of candidatesFor(p, req, o, k)) all.set(r.key, r);
  }
  if (all.size === 0) {
    const details = [`no path from ${req.origin} to ${req.destination} satisfies the constraints`];
    for (const [l, rs] of p.removedNodes) details.push(...rs.map((r) => `excluded ${l}: ${r}`));
    return { ok: false, reason: failReason, details };
  }
  const candidates = [...all.values()];
  const pareto = paretoSet(candidates);

  let route: RouteQuote;
  if (mode === "balanced") {
    const w = { ...DEFAULT_BALANCED_WEIGHTS, ...req.balancedWeights };
    const scores = balancedScores(candidates, w);
    route = [...pareto].sort((a, b) => scores.get(a.key)! - scores.get(b.key)! || byKey(a, b))[0]!;
    route = { ...route, balancedScore: scores.get(route.key) };
  } else {
    route = [...candidates].sort(COMPARATORS[mode])[0]!;
  }

  const warnings: string[] = [];
  const uncertified = route.emissions.uncertifiedLedgers;
  if (uncertified.length) {
    warnings.push(`no certified emissions figure for ${uncertified.join(", ")}; ranked at the conservative default`);
  }
  if (route.synthetic.length) warnings.push(`route uses ${route.synthetic.length} synthetic figure(s)`);

  const plannedAt = Math.floor((req.now ?? new Date()).getTime() / 1000);

  const result: PlanSuccess = {
    ok: true,
    mode,
    filters: filters.labels,
    route,
    pareto,
    plannedAt,
    energyCapKgPerTx: filters.energyCapKgPerTx,
    candidates: candidates.length,
    warnings,
  };
  if (mode === "reliable") {
    const fb = fallbackFor(p, req, route, k);
    if (fb) result.fallback = fb;
    else warnings.push("no disjoint fallback route exists");
  }
  return result;
}


