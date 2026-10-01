/**
 * Yen's k-shortest simple paths over a directed multigraph, with Dijkstra as the inner search.
 * Paths are sequences of edge ids, so parallel Channels between the same two ledgers are distinct paths.
 */

export interface WEdge {
  id: string;
  from: string;
  to: string;
  weight: number;
}

export interface WPath {
  edges: WEdge[];
  nodes: string[];
  weight: number;
}

/** Minimal binary heap keyed on a number, with insertion order as a stable tie-breaker. */
class Heap<T> {
  private items: Array<{ k: number; s: number; v: T }> = [];
  private seq = 0;
  get size(): number {
    return this.items.length;
  }
  push(k: number, v: T): void {
    const a = this.items;
    a.push({ k, s: this.seq++, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[i]!, a[p]!)) {
        [a[i], a[p]] = [a[p]!, a[i]!];
        i = p;
      } else break;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top.v;
  }
  private less(x: { k: number; s: number }, y: { k: number; s: number }): boolean {
    return x.k < y.k || (x.k === y.k && x.s < y.s);
  }
}

export class WeightedGraph {
  private readonly out = new Map<string, WEdge[]>();
  constructor(edges: WEdge[]) {
    for (const e of edges) {
      if (!(e.weight >= 0) || !Number.isFinite(e.weight)) throw new Error(`edge ${e.id}: weight must be finite and >= 0`);
      const list = this.out.get(e.from) ?? [];
      list.push(e);
      this.out.set(e.from, list);
    }
  }

  outgoing(n: string): WEdge[] {
    return this.out.get(n) ?? [];
  }

  dijkstra(source: string, target: string, removedEdges: Set<string>, removedNodes: Set<string>): WPath | undefined {
    if (removedNodes.has(source) || removedNodes.has(target)) return undefined;
    const dist = new Map<string, number>([[source, 0]]);
    const prev = new Map<string, WEdge>();
    const done = new Set<string>();
    const heap = new Heap<string>();
    heap.push(0, source);
    while (heap.size > 0) {
      const u = heap.pop()!;
      if (done.has(u)) continue;
      done.add(u);
      if (u === target) break;
      const du = dist.get(u)!;
      for (const e of this.outgoing(u)) {
        if (removedEdges.has(e.id) || removedNodes.has(e.to) || done.has(e.to)) continue;
        const nd = du + e.weight;
        const cur = dist.get(e.to);
        if (cur === undefined || nd < cur) {
          dist.set(e.to, nd);
          prev.set(e.to, e);
          heap.push(nd, e.to);
        }
      }
    }
    if (!done.has(target)) return undefined;
    const edges: WEdge[] = [];
    let n = target;
    while (n !== source) {
      const e = prev.get(n)!;
      edges.unshift(e);
      n = e.from;
    }
    return mkPath(source, edges);
  }
}

function mkPath(source: string, edges: WEdge[]): WPath {
  return {
    edges,
    nodes: [source, ...edges.map((e) => e.to)],
    weight: edges.reduce((s, e) => s + e.weight, 0),
  };
}

export function pathKey(p: { edges: Array<{ id: string }> }): string {
  return p.edges.map((e) => e.id).join("|");
}

/**
 * Lazily yields simple paths from `source` to `target` in non-decreasing total weight (Yen, 1971).
 * The caller stops iterating when it has enough paths that satisfy its constraints.
 */
export function* yenKShortest(
  g: WeightedGraph,
  source: string,
  target: string,
  opts: { removedEdges?: Set<string>; removedNodes?: Set<string> } = {},
): Generator<WPath> {
  const baseEdges = opts.removedEdges ?? new Set<string>();
  const baseNodes = opts.removedNodes ?? new Set<string>();
  const first = g.dijkstra(source, target, baseEdges, baseNodes);
  if (!first) return;
  const A: WPath[] = [first];
  const seen = new Set<string>([pathKey(first)]);
  const B = new Heap<WPath>();
  yield first;

  for (;;) {
    const prev = A[A.length - 1]!;
    for (let i = 0; i < prev.edges.length; i++) {
      const spurNode = prev.nodes[i]!;
      const root = prev.edges.slice(0, i);
      const rootKey = pathKey({ edges: root });
      const removedEdges = new Set(baseEdges);
      for (const p of A) {
        if (p.edges.length > i && pathKey({ edges: p.edges.slice(0, i) }) === rootKey) {
          removedEdges.add(p.edges[i]!.id);
        }
      }
      const removedNodes = new Set(baseNodes);
      for (const n of prev.nodes.slice(0, i)) removedNodes.add(n);
      const spur = g.dijkstra(spurNode, target, removedEdges, removedNodes);
      if (!spur) continue;
      const total = mkPath(source, [...root, ...spur.edges]);
      const k = pathKey(total);
      if (seen.has(k)) continue;
      seen.add(k);
      B.push(total.weight, total);
    }
    const next = B.pop();
    if (!next) return;
    A.push(next);
    yield next;
  }
}
