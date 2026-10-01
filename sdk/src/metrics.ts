import type { ActiveFilters } from "./filters.js";
import { certValid } from "./filters.js";
import type { RouteGraph } from "./graph.js";
import { edgeId } from "./graph.js";
import type { Connector, DataSource, Edge, Ledger, Mode, TrustTier } from "./types.js";

export interface EmissionsFigure {
  ledger: string;
  kgCO2ePerTx: number;
  /** `true` when the network has no certified figure and was ranked at the conservative default. */
  uncertifiedDefault: boolean;
  /** Which certification supplied the figure. */
  basis: "ENERGY" | "MICA" | "default" | "none";
  source?: DataSource;
}

export interface HopCost {
  connectorMarginUsd: number;
  enqueueUsd: number;
  bundleShareUsd: number;
  executionUsd: number;
  totalUsd: number;
}

export interface HopCarbon {
  /** Transactions-equivalent charged on the sending ledger (gas-weighted). */
  sourceTxs: number;
  /** Transactions-equivalent charged on the receiving ledger (gas-weighted bundle share + execution). */
  destTxs: number;
  onChainKg: number;
  offChainKg: number;
  totalKg: number;
  figures: EmissionsFigure[];
  offChainSource?: DataSource;
}

export interface HopQuote {
  edgeId: string;
  from: string;
  to: string;
  channelId: string;
  connectorId: string;
  verifierFamily: string;
  trustTier: TrustTier;
  finalized: boolean;
  cost: HopCost;
  timeP90S: number;
  successProbability: number;
  carbon: HopCarbon;
  /** Fields on this hop (edge or ledger) that are synthetic placeholders. */
  synthetic: string[];
}

export interface MetricContext {
  graph: RouteGraph;
  filters: ActiveFilters;
  mode: Mode;
  now: Date;
  /** Conservative default for uncertified networks: the highest certified figure on the graph. */
  defaultKgPerTx: number | undefined;
}

/** Tier factor: proof-verified tiers are preferred over committee and attested tiers. */
const TIER_FACTOR: Record<TrustTier, number> = {
  "validity-proof": 1,
  "light-client": 0.999,
  committee: 0.995,
  attested: 0.98,
};

/** A connector whose balance covers fewer than this many deliveries counts as thinly funded. */
const THIN_FUNDING_MULTIPLE = 10;

export function emissionsFigure(ledger: Ledger, ctx: MetricContext): EmissionsFigure {
  const certs = ledger.certifications ?? {};
  const mica = certs.MICA;
  const energy = certs.ENERGY;
  // greenest + MiCA: the figure must come from the registered MiCA disclosure.
  const micaFirst = ctx.mode === "greenest" && ctx.filters.labels.includes("MICA");
  const order: Array<["ENERGY" | "MICA", typeof energy]> = micaFirst
    ? [["MICA", mica]]
    : [
        ["ENERGY", energy],
        ["MICA", mica],
      ];
  for (const [basis, c] of order) {
    if (certValid(c, ctx.now) && c.kgCO2ePerTx !== undefined) {
      return { ledger: ledger.id, kgCO2ePerTx: c.kgCO2ePerTx, uncertifiedDefault: false, basis, source: c.source };
    }
  }
  if (ctx.defaultKgPerTx !== undefined) {
    return {
      ledger: ledger.id,
      kgCO2ePerTx: ctx.defaultKgPerTx,
      uncertifiedDefault: true,
      basis: "default",
      source: { kind: "synthetic", ref: "highest certified figure on the graph (conservative default)" },
    };
  }
  return { ledger: ledger.id, kgCO2ePerTx: 0, uncertifiedDefault: true, basis: "none" };
}

function usd(gas: number, l: Ledger): number {
  return gas * l.gasPriceNative * l.nativeUsd;
}

/** Cost the Connector must fund on the receiving ledger for one message on this edge. */
export function deliveryCostUsd(edge: Edge, src: Ledger, dst: Ledger): Omit<HopCost, "connectorMarginUsd" | "totalUsd"> {
  const enqueueUsd = usd(src.enqueueGas, src);
  const bundleNative = edge.bundle.costNative ?? edge.bundle.gas * dst.gasPriceNative;
  const bundleShareUsd = (bundleNative * dst.nativeUsd) / edge.bundle.messagesPerBundle;
  const executionUsd = usd(dst.execGasPerMessage, dst);
  return { enqueueUsd, bundleShareUsd, executionUsd };
}

/**
 * Pick the Connector for an edge. Only Connectors whose balance covers the delivery are eligible. Most-reliable mode
 * prefers the best track record; every other mode prefers the lowest margin.
 */
export function pickConnector(edge: Edge, deliveryUsd: number, mode: Mode): Connector | undefined {
  const funded = edge.connectors.filter((c) => c.balanceUsd >= deliveryUsd);
  if (funded.length === 0) return undefined;
  const sr = (c: Connector) => c.successRate ?? 1;
  return [...funded].sort((a, b) =>
    mode === "reliable"
      ? sr(b) - sr(a) || a.marginUsd - b.marginUsd || a.id.localeCompare(b.id)
      : a.marginUsd - b.marginUsd || sr(b) - sr(a) || a.id.localeCompare(b.id),
  )[0];
}

export function hopSuccessProbability(edge: Edge, connector: Connector, deliveryUsd: number): number {
  const h = edge.history;
  const base = (h.successes + 1) / (h.attempts + 2); // Laplace-smoothed channel history
  const pause = 1 - Math.min(0.5, 0.02 * h.pauses30d);
  const tier = TIER_FACTOR[edge.trustTier];
  const conn = connector.successRate ?? 1;
  const funding = connector.balanceUsd < deliveryUsd * THIN_FUNDING_MULTIPLE ? 0.95 : 1;
  return base * pause * tier * conn * funding;
}

/** Full per-hop quote, or `undefined` if no Connector is funded for this edge. */
export function hopQuote(edge: Edge, ctx: MetricContext): HopQuote | undefined {
  const src = ctx.graph.ledger(edge.from);
  const dst = ctx.graph.ledger(edge.to);
  const d = deliveryCostUsd(edge, src, dst);
  const deliveryUsd = d.bundleShareUsd + d.executionUsd;
  const connector = pickConnector(edge, deliveryUsd, ctx.mode);
  if (!connector) return undefined;

  const cost: HopCost = {
    connectorMarginUsd: connector.marginUsd,
    ...d,
    totalUsd: connector.marginUsd + d.enqueueUsd + d.bundleShareUsd + d.executionUsd,
  };

  const t = edge.timing;
  const timeP90S = t.sourceFinalityS + t.bundleCadenceS + t.proofGenS + t.verifyS;

  // Greenest: transactions needed × emissions per transaction, gas-weighted, plus off-chain energy × grid intensity.
  const fSrc = emissionsFigure(src, ctx);
  const fDst = emissionsFigure(dst, ctx);
  const sourceTxs = src.avgTxGas ? src.enqueueGas / src.avgTxGas : 1;
  const destTxs = dst.avgTxGas
    ? (edge.bundle.gas / edge.bundle.messagesPerBundle + dst.execGasPerMessage) / dst.avgTxGas
    : 1 / edge.bundle.messagesPerBundle;
  const onChainKg = sourceTxs * fSrc.kgCO2ePerTx + destTxs * fDst.kgCO2ePerTx;
  const offChainKg = (edge.offChain.kWhPerBundle / edge.bundle.messagesPerBundle) * edge.offChain.gridKgPerKWh;

  const synthetic = [
    ...(edge.synthetic ?? []).map((f) => `edge ${edgeId(edge)}: ${f}`),
    ...(src.synthetic ?? []).map((f) => `ledger ${src.id}: ${f}`),
    ...(dst.synthetic ?? []).map((f) => `ledger ${dst.id}: ${f}`),
  ];

  return {
    edgeId: edgeId(edge),
    from: edge.from,
    to: edge.to,
    channelId: edge.channelId,
    connectorId: connector.id,
    verifierFamily: edge.verifierFamily,
    trustTier: edge.trustTier,
    finalized: edge.finalized,
    cost,
    timeP90S,
    successProbability: hopSuccessProbability(edge, connector, deliveryUsd),
    carbon: {
      sourceTxs,
      destTxs,
      onChainKg,
      offChainKg,
      totalKg: onChainKg + offChainKg,
      figures: [fSrc, fDst],
      offChainSource: edge.offChain.source,
    },
    synthetic,
  };
}
