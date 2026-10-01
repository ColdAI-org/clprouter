import { describe, expect, it } from "vitest";
import type { WEdge } from "../src/index.js";
import { WeightedGraph, pathKey, yenKShortest } from "../src/index.js";

const e = (id: string, from: string, to: string, weight: number): WEdge => ({ id, from, to, weight });

// Classic Yen example (Wikipedia): C→H, k = 3 gives C-E-F-H (5), C-E-G-H (7), C-D-F-H (8).
const wiki = [
  e("CD", "C", "D", 3), e("CE", "C", "E", 2), e("DF", "D", "F", 4), e("ED", "E", "D", 1),
  e("EF", "E", "F", 2), e("EG", "E", "G", 3), e("FG", "F", "G", 2), e("FH", "F", "H", 1),
  e("GH", "G", "H", 2),
];

function take<T>(it: Iterable<T>, n: number): T[] {
  const out: T[] = [];
  for (const x of it) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

describe("Yen k-shortest paths", () => {
  it("matches the textbook example", () => {
    const ps = take(yenKShortest(new WeightedGraph(wiki), "C", "H"), 3);
    expect(ps.map((p) => p.nodes.join(""))).toEqual(["CEFH", "CEGH", "CDFH"]);
    expect(ps.map((p) => p.weight)).toEqual([5, 7, 8]);
  });

  it("yields every simple path exactly once, in non-decreasing weight", () => {
    const ps = [...yenKShortest(new WeightedGraph(wiki), "C", "H")];
    const keys = ps.map(pathKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < ps.length; i++) expect(ps[i]!.weight).toBeGreaterThanOrEqual(ps[i - 1]!.weight);
    for (const p of ps) expect(new Set(p.nodes).size).toBe(p.nodes.length);
    expect(ps).toHaveLength(7); // all simple C→H paths in this graph
  });

  it("treats parallel edges as distinct paths", () => {
    const g = new WeightedGraph([e("a1", "A", "B", 1), e("a2", "A", "B", 2), e("b", "B", "C", 1)]);
    const ps = [...yenKShortest(g, "A", "C")];
    expect(ps.map(pathKey)).toEqual(["a1|b", "a2|b"]);
  });

  it("honours removed edges and nodes", () => {
    const g = new WeightedGraph(wiki);
    const [p] = take(yenKShortest(g, "C", "H", { removedNodes: new Set(["E"]) }), 1);
    expect(p!.nodes.join("")).toBe("CDFH");
    const [q] = take(yenKShortest(g, "C", "H", { removedEdges: new Set(["FH"]) }), 1);
    expect(q!.nodes.join("")).toBe("CEGH");
  });

  it("yields nothing when the target is unreachable", () => {
    expect([...yenKShortest(new WeightedGraph(wiki), "H", "C")]).toEqual([]);
  });

  it("rejects negative or non-finite weights", () => {
    expect(() => new WeightedGraph([e("x", "A", "B", -1)])).toThrow();
    expect(() => new WeightedGraph([e("x", "A", "B", Infinity)])).toThrow();
  });
});
