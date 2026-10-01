import type { RouteGraphData } from "../types.js";
import sample from "./sample-graph.json" with { type: "json" };

/**
 * Sample route graph. Bundle gas and calldata on chain → Hiero edges are measured (see each edge's `bundle.source`);
 * everything listed in an edge's or ledger's `synthetic` array is a placeholder. Hiero → chain edges are `projected`:
 * they are blocked today, so the planner ignores them unless `constraints.allowProjected` is set.
 */
export function sampleGraph(): RouteGraphData {
  return structuredClone(sample) as RouteGraphData;
}
