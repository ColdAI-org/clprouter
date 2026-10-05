#!/usr/bin/env node
/**
 * Builds the planner data for the demo site from the SDK's route graph files.
 *
 *   sdk/data/edges.json          -> src/generated/graph-measured.json   (RouteGraphData, loaded by the real SDK planner)
 *   sdk/src/data/sample-graph.json -> src/generated/graph-sample.json
 *   sdk/data/chains.json         -> src/generated/chains.json            (86 chain pages: name, id, status, family)
 *
 * The site shows numbers, not prose: free-text `notes` and narrative fields are dropped, and only the fields the
 * planner and the chain chips need are kept.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = join(SITE, "../sdk");
const OUT = join(SITE, "src/generated");
mkdirSync(OUT, { recursive: true });

const read = (p) => JSON.parse(readFileSync(join(SDK, p), "utf8"));

/** Keep the planner's numeric model; drop prose. */
function cleanGraph(g) {
  return {
    version: g.version,
    asOf: g.asOf,
    disabledRouterVersions: g.disabledRouterVersions ?? [],
    ledgers: g.ledgers.map((l) => {
      const { sources: _s, ...rest } = l;
      return rest;
    }),
    edges: g.edges.map((e) => {
      const rest = pick(e, EDGE_FIELDS);
      return {
        ...rest,
        timing: { ...rest.timing, source: rest.timing.source && { kind: rest.timing.source.kind } },
        bundle: {
          ...rest.bundle,
          source: rest.bundle.source && { kind: rest.bundle.source.kind, ref: refOnly(rest.bundle.source.ref) },
        },
        offChain: { ...rest.offChain, source: rest.offChain.source && { kind: rest.offChain.source.kind } },
      };
    }),
  };
}

/** Edge fields the planner reads; anything else (free-text notes, informational flags) is left out. */
const EDGE_FIELDS = [
  "id", "from", "to", "channelId", "verifierFamily", "trustTier", "timing", "bundle", "connectors", "status",
  "history", "maxPayloadBytes", "offChain", "disabled", "synthetic",
];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** A data-source reference reduced to its branch:file anchor (no quoted text). */
function refOnly(ref) {
  if (!ref) return undefined;
  const m = /(pr\/[\w-]+:[\w./-]+(?:#L\d+)?)/.exec(ref);
  const basis = /^(family-proxy|live-mainnet|live-testnet|live-partial|estimate|synthetic)/.exec(ref)?.[1];
  return [basis, m?.[1]].filter(Boolean).join(": ") || undefined;
}

const measured = cleanGraph(read("data/edges.json"));
const sample = cleanGraph(read("src/data/sample-graph.json"));
const inGraph = new Set(measured.ledgers.map((l) => l.id));

const chainsRaw = read("data/chains.json");
const chains = chainsRaw.chains.map((c) => ({
  name: c.name,
  id: c.caip2?.id ?? null,
  status: c.status?.class ?? null,
  family: c.verifier?.family ?? null,
  tier: c.trust?.tier ?? null,
  bundleGas: c.bundle?.gas ?? null,
  calldataBytes: c.bundle?.calldataBytes ?? null,
  inGraph: Boolean(c.caip2?.id && inGraph.has(c.caip2.id)),
}));

writeFileSync(join(OUT, "graph-measured.json"), JSON.stringify(measured));
writeFileSync(join(OUT, "graph-sample.json"), JSON.stringify(sample));
writeFileSync(
  join(OUT, "chains.json"),
  JSON.stringify({ asOf: chainsRaw.asOf, count: chains.length, chains }),
);
console.log(
  `graph-measured: ${measured.ledgers.length} ledgers, ${measured.edges.length} edges; ` +
    `graph-sample: ${sample.ledgers.length} ledgers; chains: ${chains.length}`,
);
