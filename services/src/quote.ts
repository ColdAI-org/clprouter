import {
  OnChainGraphSource,
  ViemOnChainReader,
  edgeId,
  plan,
  type Certification,
  type ChannelState,
  type ConnectorState,
  type Edge,
  type FilterLabel,
  type GraphSource,
  type OnChainReader,
  type PlanRequest,
  type PlanResult,
  type RegistryState,
  type RouteGraph,
  type RouteGraphData,
} from "@clprouter/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { keccak256, toHex } from "viem";
import type { LedgerConfig } from "./config.js";
import type { LedgerRegistryState } from "./registry.js";
import { certificationsInEffect, keys, loadRegistry, switchActive } from "./registry.js";
import type { Cursor, Store } from "./store.js";

const LABELS: Record<string, FilterLabel> = { ISO20022: "ISO20022", MICA: "MICA", ENERGY: "ENERGY" };

/**
 * Turn indexed registry state into the planner's `RegistryState`.
 *
 * - Certifications come from one registry (`registryLedger`): every registry applies the same decisions in the
 *   same order, so one is enough; the response names the version it was at.
 * - Disables are the union over every ledger's registry (conservative: a Router checks its own registry, and
 *   registries may lag each other by a few decisions).
 * - A disabled Router deployment disables its ledger for planning (the planner has one Router per ledger).
 */
export function plannerRegistryState(
  certSource: LedgerRegistryState | undefined,
  all: LedgerRegistryState[],
  graph: RouteGraph,
  routers: Record<string, Address>,
  routerVersions: number[],
  now: number,
): RegistryState {
  const certifications: RegistryState["certifications"] = {};
  if (certSource) {
    for (const c of certificationsInEffect(certSource.certificationLog, now)) {
      const label = LABELS[c.label];
      if (!label || !graph.hasLedger(c.ledgerId)) continue;
      const cert: Certification = {
        status: c.certified ? "full" : "revoked",
        expiresAt: new Date(c.expiry * 1000).toISOString(),
        effectiveFrom: c.effectiveFrom,
        evidenceHash: c.evidenceHash,
        source: { kind: "on-chain", ref: `ProviderRegistry v${c.version} on ${certSource.ledger}` },
      };
      // µgCO2e → kgCO2e.
      if (label === "ENERGY" && c.emissionsUg > 0) cert.kgCO2ePerTx = c.emissionsUg / 1e9;
      (certifications[c.ledgerId] ??= {})[label] = cert;
    }
  }

  const disabled = new Set<string>();
  for (const st of all) for (const sw of st.switches) if (switchActive(sw, now)) disabled.add(sw.subject.toLowerCase());
  const isOff = (k: Hex) => disabled.has(k.toLowerCase());

  const disabledLedgers = graph
    .ledgers()
    .filter((l) => isOff(keys.ledger(l.id)) || (routers[l.id] !== undefined && isOff(keys.router(l.id, routers[l.id]!))))
    .map((l) => l.id);
  const disabledEdges = graph
    .edges()
    .filter((e) => /^0x[0-9a-fA-F]{64}$/.test(e.channelId) && isOff(keys.edge(e.channelId as Hex, e.to)))
    .map((e) => edgeId(e));
  const disabledRouterVersions = routerVersions.filter((v) => isOff(keys.routerVersion(v)));
  return { certifications, disabledLedgers, disabledEdges, disabledRouterVersions };
}

/** Wrap a client so every read is pinned to `blockNumber` (the indexer's confirmed block on that ledger). */
export function pinnedClient(client: PublicClient, blockNumber: bigint): PublicClient {
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === "call" || prop === "getBalance" || prop === "readContract") {
        const fn = Reflect.get(target, prop, recv) as (x: object) => unknown;
        return (a: object) => fn.call(target, { ...a, blockTag: undefined, blockNumber });
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

export interface QuoteRequestBody {
  origin: string;
  destination: string;
  mode?: PlanRequest["mode"];
  filters?: PlanRequest["filters"];
  constraints?: PlanRequest["constraints"];
  payloadBytes?: number;
  k?: number;
  balancedWeights?: PlanRequest["balancedWeights"];
  /** Unix seconds to evaluate certifications at. Default: now. */
  now?: number;
  /** Include the full graph snapshot in the response (otherwise fetch it by hash from `/graphs/:hash`). */
  includeGraph?: boolean;
}

export interface QuoteInputs {
  /** The planner request exactly as run (with `now` fixed). */
  request: Omit<PlanRequest, "now"> & { now: number };
  /** Confirmed block per ledger: live state (registry, Channels, Connectors) was read at these blocks. */
  blocks: Record<string, Cursor | null>;
  /** Registry version (decisions applied) per ledger at those blocks. */
  registryVersions: Record<string, number>;
  /** Registry that supplied certifications. */
  registryLedger: string | null;
  graph: { hash: Hex; version?: string; asOf?: string };
  /** Edges and Connectors whose live state was read on-chain (others keep the base snapshot). */
  liveReads: { channels: number; connectors: number };
}

export type QuoteResponse =
  | ({
      ok: true;
      mode: string;
      filters: FilterLabel[];
      chosen: unknown;
      perHop: unknown[];
      pareto: unknown[];
      fallback?: unknown;
      warnings: string[];
      candidates: number;
      /**
       * `ProviderRegistry.version()` on the origin ledger at the quoted block: pass it to `buildEnvelope` as
       * `registryVersion` (required when a filter is on). Absent when the origin's registry was not read.
       */
      registryVersion?: number;
      inputs: QuoteInputs;
      graph?: RouteGraphData;
    })
  | { ok: false; reason: string; details: string[]; inputs: QuoteInputs; graph?: RouteGraphData };

/** Hash of a graph snapshot: keccak256 of its JSON. */
export function graphHash(data: RouteGraphData): Hex {
  return keccak256(toHex(JSON.stringify(data)));
}

export interface QuoteServiceOptions {
  base: GraphSource;
  store: Store;
  ledgers: LedgerConfig[];
  /** Per-ledger confirmed cursor (normally `indexer.cursors()`). */
  cursors: () => Record<string, Cursor | null>;
  /** Public clients per ledger; with `contracts.clprService` set, Channel and Connector state are read live. */
  clients?: Record<string, PublicClient>;
  registryLedger?: string;
  routerVersions?: number[];
  /** Snapshots kept for `/graphs/:hash`. Default 32. */
  keepGraphs?: number;
  clock?: () => number;
}

/**
 * Wraps the SDK planner with the live graph from the indexer. Every answer carries its inputs (blocks, registry
 * versions, graph hash), so a client can fetch the same graph and re-run `plan()` itself ({@link recheckQuote}).
 */
export class QuoteService {
  private readonly graphs = new Map<string, RouteGraphData>();

  constructor(private readonly o: QuoteServiceOptions) {}

  private now(): number {
    return this.o.clock ? this.o.clock() : Math.floor(Date.now() / 1000);
  }

  graphByHash(hash: string): RouteGraphData | undefined {
    return this.graphs.get(hash.toLowerCase());
  }

  /** Build the live graph and the inputs it was built from. */
  async liveGraph(now = this.now()): Promise<{ graph: RouteGraph; inputs: Omit<QuoteInputs, "request"> }> {
    const blocks = this.o.cursors();
    const states = this.o.ledgers.map((l) => loadRegistry(this.o.store, l.id));
    const regLedger = this.o.registryLedger ?? this.o.ledgers[0]?.id ?? null;
    const certSource = states.find((s) => s.ledger === regLedger);
    const routers = Object.fromEntries(this.o.ledgers.map((l) => [l.id, l.contracts.router]));
    const routerVersions = this.o.routerVersions ?? [1];

    const live = { channels: 0, connectors: 0 };
    const viemReaders = new Map<string, ViemOnChainReader>();
    for (const l of this.o.ledgers) {
      const client = this.o.clients?.[l.id];
      const cur = blocks[l.id];
      if (!client || !l.contracts.clprService || !cur) continue;
      viemReaders.set(
        l.id,
        new ViemOnChainReader({
          ledgers: { [l.id]: { client: pinnedClient(client, BigInt(cur.blockNumber)), clprService: l.contracts.clprService } },
          ledgerIds: [],
        }),
      );
    }

    let baseGraph: RouteGraph | undefined;
    const reader: OnChainReader = {
      channelState: async (e: Edge): Promise<ChannelState | undefined> => {
        const r = viemReaders.get(e.to);
        if (!r || !/^0x[0-9a-fA-F]{64}$/.test(e.channelId)) return undefined;
        const s = await r.channelState(e).catch(() => undefined);
        if (s) live.channels++;
        return s;
      },
      connectorState: async (e: Edge, connectorId: string): Promise<ConnectorState | undefined> => {
        const r = viemReaders.get(e.to);
        if (!r || !/^0x[0-9a-fA-F]{64}$/.test(connectorId)) return undefined;
        const s = await r.connectorState(e, connectorId).catch(() => undefined);
        if (s) live.connectors++;
        return s;
      },
      registryState: async () => plannerRegistryState(certSource, states, baseGraph!, routers, routerVersions, now),
    };
    baseGraph = await this.o.base.load();
    const graph = await new OnChainGraphSource({ load: async () => baseGraph! }, reader).load();
    // Make the snapshot time the evaluation time, so the hash is reproducible from the inputs.
    graph.data.asOf = new Date(now * 1000).toISOString();
    const hash = graphHash(graph.data);
    this.remember(hash, graph.data);

    return {
      graph,
      inputs: {
        blocks,
        registryVersions: Object.fromEntries(states.map((s) => [s.ledger, s.version])),
        registryLedger: regLedger,
        graph: { hash, version: graph.data.version, asOf: graph.data.asOf },
        liveReads: live,
      },
    };
  }

  private remember(hash: Hex, data: RouteGraphData) {
    this.graphs.set(hash.toLowerCase(), data);
    const keep = this.o.keepGraphs ?? 32;
    while (this.graphs.size > keep) this.graphs.delete(this.graphs.keys().next().value!);
  }

  async quote(body: QuoteRequestBody): Promise<QuoteResponse> {
    validateQuoteBody(body);
    const now = body.now ?? this.now();
    const { graph, inputs: partial } = await this.liveGraph(now);
    const request: QuoteInputs["request"] = {
      origin: body.origin,
      destination: body.destination,
      mode: body.mode ?? "balanced",
      filters: body.filters ?? {},
      constraints: body.constraints ?? {},
      ...(body.payloadBytes !== undefined ? { payloadBytes: body.payloadBytes } : {}),
      ...(body.k !== undefined ? { k: body.k } : {}),
      ...(body.balancedWeights ? { balancedWeights: body.balancedWeights } : {}),
      now,
    };
    const inputs: QuoteInputs = { request, ...partial };
    const result = runPlan(graph, request);
    const extra = body.includeGraph ? { graph: graph.data } : {};
    if (!result.ok) return { ok: false, reason: result.reason, details: result.details, inputs, ...extra };
    return {
      ok: true,
      mode: result.mode,
      filters: result.filters,
      chosen: result.route,
      perHop: result.route.hops,
      pareto: result.pareto,
      ...(result.fallback ? { fallback: result.fallback } : {}),
      warnings: result.warnings,
      candidates: result.candidates,
      ...(inputs.registryVersions[request.origin] !== undefined ? { registryVersion: inputs.registryVersions[request.origin] } : {}),
      inputs,
      ...extra,
    };
  }
}

function runPlan(graph: RouteGraph | RouteGraphData, request: QuoteInputs["request"]): PlanResult {
  const { now, ...rest } = request;
  return plan(graph, { ...rest, now: new Date(now * 1000) });
}

const MODES = new Set(["cheapest", "fastest", "reliable", "greenest", "balanced"]);

export class BadRequest extends Error {}

export function validateQuoteBody(b: QuoteRequestBody): void {
  if (!b || typeof b !== "object") throw new BadRequest("body must be a JSON object");
  if (typeof b.origin !== "string" || typeof b.destination !== "string") {
    throw new BadRequest("origin and destination (CAIP-2) are required");
  }
  if (b.mode !== undefined && !MODES.has(b.mode)) throw new BadRequest(`unknown mode ${String(b.mode)}`);
  if (b.now !== undefined && !Number.isFinite(b.now)) throw new BadRequest("now must be unix seconds");
}

/**
 * Re-check a quote against a graph snapshot (fetched by `inputs.graph.hash`): the hash must match and re-running
 * the planner with `inputs.request` must give the same chosen route and Pareto set.
 */
export function recheckQuote(q: QuoteResponse, graph: RouteGraphData): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (graphHash(graph) !== q.inputs.graph.hash) problems.push("graph hash does not match the quote's inputs");
  const r = runPlan(structuredClone(graph), q.inputs.request);
  if (r.ok !== q.ok) problems.push(`planner says ok=${r.ok}, quote says ok=${q.ok}`);
  else if (r.ok && q.ok) {
    const chosen = q.chosen as { key: string };
    if (r.route.key !== chosen.key) problems.push(`chosen route differs: ${r.route.key} vs ${chosen.key}`);
    const a = r.pareto.map((p) => p.key).sort().join(",");
    const b = (q.pareto as { key: string }[]).map((p) => p.key).sort().join(",");
    if (a !== b) problems.push("Pareto set differs");
  }
  return { ok: problems.length === 0, problems };
}
