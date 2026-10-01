import type { Certification, Edge, FilterLabel, Ledger, RouteGraphData, TrustTier } from "../src/index.js";

export const NOW = new Date("2026-10-01T00:00:00Z");
const EXP = "2027-10-01T00:00:00Z";

export const A = "test:a";
export const B = "test:b";
export const H = "test:hub";
export const X = "test:x"; // cheap, slow, unreliable, uncertified for energy
export const Y = "test:y"; // fast, expensive, dirty, committee tier
export const Z = "test:z"; // green
export const D = "test:dom"; // dominated in every metric
export const W1 = "test:w1"; // W1..W3: a cheap 4-hop path
export const W2 = "test:w2";
export const W3 = "test:w3";

export function cert(kg?: number, extra: Partial<Certification> = {}): Certification {
  return { status: "full", expiresAt: EXP, kgCO2ePerTx: kg, source: { kind: "measured", ref: "fixture", date: "2026-09-30" }, ...extra };
}

export function ledger(id: string, certs: Partial<Record<FilterLabel, Certification>> = {}, extra: Partial<Ledger> = {}): Ledger {
  return {
    id,
    name: id,
    nativeUsd: 1,
    gasPriceNative: 0, // costs come from connector margins only, so they are easy to reason about
    enqueueGas: 0,
    execGasPerMessage: 0,
    routerVersion: 1,
    certifications: certs,
    operatedRouter: { operator: `${id}-op`, jurisdiction: "CH", identified: true, caspAuthorised: true },
    ...extra,
  };
}

export interface EdgeOpts {
  cost?: number;
  time?: number;
  successes?: number;
  attempts?: number;
  tier?: TrustTier;
  finalized?: boolean;
  maxPayloadBytes?: number;
  status?: Edge["status"];
  disabled?: boolean;
  kWh?: number;
}

export function edge(from: string, to: string, o: EdgeOpts = {}): Edge {
  return {
    from,
    to,
    channelId: `ch-${from}-${to}`,
    verifierFamily: "fixture",
    trustTier: o.tier ?? "light-client",
    finalized: o.finalized ?? true,
    timing: { sourceFinalityS: o.time ?? 10, bundleCadenceS: 0, proofGenS: 0, verifyS: 0 },
    bundle: { gas: 0, calldataBytes: 0, messagesPerBundle: 1 },
    connectors: [{ id: `conn-${from}-${to}`, marginUsd: o.cost ?? 1, balanceUsd: 1000, successRate: 1 }],
    status: o.status ?? "active",
    history: { attempts: o.attempts ?? 1000, successes: o.successes ?? o.attempts ?? 1000, pauses30d: 0 },
    maxPayloadBytes: o.maxPayloadBytes ?? 65536,
    offChain: { kWhPerBundle: o.kWh ?? 0, gridKgPerKWh: 0.5 },
    disabled: o.disabled,
  };
}

/**
 * Six routes from A to B, each best at something:
 * - A-H-B: most reliable (light-client, perfect history), balanced
 * - A-X-B: cheapest (1.0) but slow (100 s), attested, X has no emissions figure
 * - A-Y-B: fastest (4 s), expensive (6.0), committee tier, dirty (0.5 kg/tx)
 * - A-Z-B: greenest (Z 0.0001 kg/tx)
 * - A-D-B: dominated by A-H-B in every metric
 * - A-W1-W2-W3-B: cheapest of all (0.4) but 4 hops
 */
export function fixtureGraph(): RouteGraphData {
  const all = () => ({ ISO20022: cert(), MICA: cert(0.01), ENERGY: cert(0.01) });
  return {
    version: "fixture",
    ledgers: [
      ledger(A, all()),
      ledger(B, all()),
      ledger(H, all()),
      ledger(X, {}),
      ledger(Y, { ISO20022: cert(), ENERGY: cert(0.5) }),
      ledger(Z, { MICA: cert(0.0001), ENERGY: cert(0.0001) }),
      ledger(D, { ENERGY: cert(0.3) }),
      ledger(W1, { ENERGY: cert(0.01) }),
      ledger(W2, { ENERGY: cert(0.01) }),
      ledger(W3, { ENERGY: cert(0.01) }),
    ],
    edges: [
      edge(A, H, { cost: 1, time: 10 }),
      edge(H, B, { cost: 1, time: 10 }),
      edge(A, X, { cost: 0.5, time: 50, tier: "attested", attempts: 100, successes: 80, maxPayloadBytes: 1024 }),
      edge(X, B, { cost: 0.5, time: 50, tier: "attested", attempts: 100, successes: 80, maxPayloadBytes: 1024 }),
      edge(A, Y, { cost: 3, time: 2, tier: "committee", attempts: 100, successes: 90 }),
      edge(Y, B, { cost: 3, time: 2, tier: "committee", attempts: 100, successes: 90 }),
      edge(A, Z, { cost: 2.5, time: 30, attempts: 100, successes: 95 }),
      edge(Z, B, { cost: 2.5, time: 30, attempts: 100, successes: 95 }),
      edge(A, D, { cost: 5, time: 100, tier: "attested", attempts: 100, successes: 50 }),
      edge(D, B, { cost: 5, time: 100, tier: "attested", attempts: 100, successes: 50 }),
      edge(A, W1, { cost: 0.1, time: 40, attempts: 100, successes: 99 }),
      edge(W1, W2, { cost: 0.1, time: 40, attempts: 100, successes: 99 }),
      edge(W2, W3, { cost: 0.1, time: 40, attempts: 100, successes: 99 }),
      edge(W3, B, { cost: 0.1, time: 40, attempts: 100, successes: 99 }),
    ],
  };
}

export function via(ledgers: string[]): string {
  return ledgers.join(" > ");
}
