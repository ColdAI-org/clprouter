import type { Caip2, Edge, Ledger, RouteGraphData } from "./types.js";
import { TRUST_TIER_ORDER } from "./types.js";

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export function isCaip2(id: string): boolean {
  return CAIP2.test(id);
}

export function edgeId(e: Pick<Edge, "id" | "channelId" | "from" | "to">): string {
  return e.id ?? `${e.channelId}:${e.from}->${e.to}`;
}

/** Validated, indexed route graph. Nodes are ledgers (CAIP-2), edges are Channel directions. */
export class RouteGraph {
  readonly data: RouteGraphData;
  private readonly ledgerById = new Map<Caip2, Ledger>();
  private readonly out = new Map<Caip2, Edge[]>();
  private readonly edgeById = new Map<string, Edge>();

  constructor(data: RouteGraphData) {
    this.data = data;
    for (const l of data.ledgers) {
      if (!isCaip2(l.id)) throw new Error(`ledger id is not CAIP-2: ${l.id}`);
      if (this.ledgerById.has(l.id)) throw new Error(`duplicate ledger ${l.id}`);
      this.ledgerById.set(l.id, l);
      this.out.set(l.id, []);
    }
    for (const e of data.edges) {
      const id = edgeId(e);
      if (!this.ledgerById.has(e.from)) throw new Error(`edge ${id}: unknown ledger ${e.from}`);
      if (!this.ledgerById.has(e.to)) throw new Error(`edge ${id}: unknown ledger ${e.to}`);
      if (e.from === e.to) throw new Error(`edge ${id}: self loop`);
      if (!TRUST_TIER_ORDER.includes(e.trustTier)) throw new Error(`edge ${id}: unknown trust tier ${e.trustTier}`);
      if (!(e.bundle.messagesPerBundle >= 1)) throw new Error(`edge ${id}: messagesPerBundle must be >= 1`);
      if (this.edgeById.has(id)) throw new Error(`duplicate edge ${id}`);
      this.edgeById.set(id, e);
      this.out.get(e.from)!.push(e);
    }
  }

  ledger(id: Caip2): Ledger {
    const l = this.ledgerById.get(id);
    if (!l) throw new Error(`unknown ledger ${id}`);
    return l;
  }

  hasLedger(id: Caip2): boolean {
    return this.ledgerById.has(id);
  }

  ledgers(): Ledger[] {
    return [...this.ledgerById.values()];
  }

  edges(): Edge[] {
    return [...this.edgeById.values()];
  }

  outgoing(id: Caip2): Edge[] {
    return this.out.get(id) ?? [];
  }

  edge(id: string): Edge {
    const e = this.edgeById.get(id);
    if (!e) throw new Error(`unknown edge ${id}`);
    return e;
  }

  /**
   * Highest certified emissions figure (kgCO2e per transaction) on the graph, from ENERGY certifications or,
   * where there is none, MiCA sustainability disclosures. This is the conservative default for uncertified networks.
   */
  maxCertifiedKgPerTx(now: Date = new Date()): number | undefined {
    let max: number | undefined;
    for (const l of this.ledgerById.values()) {
      for (const label of ["ENERGY", "MICA"] as const) {
        const c = l.certifications?.[label];
        if (!c || c.status === "revoked" || c.kgCO2ePerTx === undefined) continue;
        if (new Date(c.expiresAt).getTime() <= now.getTime()) continue;
        if (max === undefined || c.kgCO2ePerTx > max) max = c.kgCO2ePerTx;
      }
    }
    return max;
  }
}
