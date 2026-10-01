/**
 * Core types for the CLPRouter route graph, planner, quotes and envelopes.
 *
 * Units used throughout:
 * - money: USD (the off-chain quote currency; see spec "Fee unit for cheapest")
 * - time: seconds
 * - emissions: kgCO2e
 * - gas: gas units of the ledger the transaction runs on
 */

/** CAIP-2 chain id, e.g. `eip155:1`, `hedera:mainnet`. */
export type Caip2 = string;
/** CAIP-10 account id, e.g. `eip155:1:0xabc...`. */
export type Caip10 = string;

export type Mode = "cheapest" | "fastest" | "reliable" | "greenest" | "balanced";

export type FilterLabel = "ISO20022" | "MICA" | "ENERGY";

/**
 * Trust tiers, weakest to strongest. A route's effective tier is its weakest hop's tier.
 *
 * - `attested`: t-of-n operators attest the remote state; nothing about the remote chain is proven (e.g. Canton today).
 * - `committee`: a K-of-N committee or a sampled subset of the validator set signs (e.g. Ethereum sync committee,
 *   Solana attested committee).
 * - `light-client`: the full consensus of the source chain is verified (validator-set BLS/Ed25519 quorum, SCP quorum,
 *   PoW with k confirmations, Hiero TSS).
 * - `validity-proof`: a ZK validity proof of the source chain's state transition is verified.
 */
export type TrustTier = "attested" | "committee" | "light-client" | "validity-proof";

export const TRUST_TIER_ORDER: readonly TrustTier[] = ["attested", "committee", "light-client", "validity-proof"];

export function trustRank(tier: TrustTier): number {
  const i = TRUST_TIER_ORDER.indexOf(tier);
  if (i < 0) throw new Error(`unknown trust tier ${tier}`);
  return i;
}

export function weakestTier(tiers: readonly TrustTier[]): TrustTier {
  if (tiers.length === 0) throw new Error("no tiers");
  return tiers.reduce((a, b) => (trustRank(b) < trustRank(a) ? b : a));
}

/** Where a number came from. `synthetic` numbers are placeholders, not measurements. */
export interface DataSource {
  kind: "measured" | "mica-whitepaper" | "independent" | "synthetic" | "on-chain";
  /** Human-readable reference, e.g. "clpr-smart-contracts-eth src/verifiers/evm/ethereum/README.md". */
  ref?: string;
  /** ISO date (YYYY-MM-DD) the figure was captured. */
  date?: string;
}

/** A provider certification entry for one label on one network. */
export interface Certification {
  /** `provisional` launch-list entries are accepted by the filter, like `full` ones. */
  status: "provisional" | "full" | "revoked";
  evidenceHash?: `0x${string}`;
  /** ISO date; the certification is invalid at or after this instant. */
  expiresAt: string;
  /** Unix seconds from which the registry entry is effective, if known. */
  effectiveFrom?: number;
  /**
   * Emissions per transaction (kgCO2e; on-chain the registry stores integer µgCO2e). Required for ENERGY; optional for MICA, where it is the sustainability
   * indicator disclosed in the registered white paper.
   */
  kgCO2ePerTx?: number;
  source?: DataSource;
}

/** The operated (identified) Router on a ledger, used on ISO 20022 and MiCA hops. */
export interface OperatedRouter {
  operator: string;
  /** ISO 3166-1 alpha-2 jurisdiction tag. */
  jurisdiction: string;
  /** Identity certified by the provider (ISO 20022 criterion 4). */
  identified: boolean;
  /** Authorised CASP listed in ESMA's register (MiCA criterion 3). */
  caspAuthorised: boolean;
  synthetic?: boolean;
}

export interface Ledger {
  id: Caip2;
  name: string;
  /** Jurisdiction(s) of the network's governing entity, if any. */
  jurisdictions?: string[];
  /** CLPRouter contract version deployed on this ledger (`router_version` in the envelope). */
  routerVersion?: number;
  /** Native token price in USD. */
  nativeUsd: number;
  /** Gas price in native units per gas unit (e.g. 1e-9 for 1 gwei on Ethereum, HBAR per gas on Hedera). */
  gasPriceNative: number;
  /** Average gas used by one transaction on this network, used to gas-weight emissions per transaction. */
  avgTxGas?: number;
  /** Gas to enqueue one message on this ledger (sending side). */
  enqueueGas: number;
  /** Gas to execute one delivered message on this ledger (receiving side). */
  execGasPerMessage: number;
  /** Consensus family, informational (`pos`, `pow`, `bft`, `hashgraph`, ...). */
  consensus?: string;
  certifications?: Partial<Record<FilterLabel, Certification>>;
  operatedRouter?: OperatedRouter;
  /** Disabled by the provider (route safety). */
  disabled?: boolean;
  /** Fields that are placeholders rather than measured. */
  synthetic?: string[];
  sources?: Record<string, DataSource>;
}

export interface Connector {
  id: string;
  /** Connector's own margin per message, USD. */
  marginUsd: number;
  /** Connector balance on the destination ledger, USD. */
  balanceUsd: number;
  /** Delivered / attempted, from history. */
  successRate?: number;
}

export interface ChannelHistory {
  attempts: number;
  successes: number;
  /** Pauses in the last 30 days. */
  pauses30d: number;
  /** p90 acknowledgement latency, seconds (informational). */
  ackLatencyP90S?: number;
}

export interface Bundle {
  /** Gas used by `verifyBundle` on the receiving ledger. */
  gas: number;
  calldataBytes: number;
  /** Messages carried per bundle; the per-message share is gas / messagesPerBundle. */
  messagesPerBundle: number;
  /** Measured cost of one bundle in the receiving ledger's native token, if known (overrides gas × gas price). */
  costNative?: number;
  source?: DataSource;
}

export interface Timing {
  /** Source-chain finality, p90 seconds. */
  sourceFinalityS: number;
  /** Bundle cadence (time until the next bundle is submitted), p90 seconds. */
  bundleCadenceS: number;
  /** Off-chain proof generation, p90 seconds. */
  proofGenS: number;
  /** On-chain verification and inclusion on the receiving ledger, p90 seconds. */
  verifyS: number;
  source?: DataSource;
}

export interface OffChainEnergy {
  /** kWh per bundle spent on proof generation and relaying. */
  kWhPerBundle: number;
  /** Operator grid carbon intensity, kgCO2e per kWh. */
  gridKgPerKWh: number;
  source?: DataSource;
}

export type ChannelStatus = "active" | "paused" | "closed" | "projected";

/** One active Channel direction: an edge of the route graph. */
export interface Edge {
  /** Unique edge id; defaults to `${channelId}:${from}->${to}`. */
  id?: string;
  from: Caip2;
  to: Caip2;
  channelId: string;
  verifierFamily: string;
  trustTier: TrustTier;
  /** True when the verifier checks finalized (not just attested/safe) state. */
  finalized: boolean;
  timing: Timing;
  bundle: Bundle;
  connectors: Connector[];
  status: ChannelStatus;
  history: ChannelHistory;
  maxPayloadBytes: number;
  offChain: OffChainEnergy;
  /** Disabled by the provider (route safety). */
  disabled?: boolean;
  /** Fields that are placeholders rather than measured. */
  synthetic?: string[];
  notes?: string;
}

export interface RouteGraphData {
  /** Version of the graph snapshot (free form). */
  version?: string;
  /** ISO date the snapshot was built. */
  asOf?: string;
  ledgers: Ledger[];
  edges: Edge[];
  /** Router contract versions disabled by the provider. */
  disabledRouterVersions?: number[];
  /**
   * `ProviderRegistry.version()` (decision counter) the registry overlay was read at, if any. Pass it to
   * `buildEnvelope` as `registryVersion` for filtered routes.
   */
  registryVersion?: number;
}

export interface Filters {
  iso20022?: boolean;
  mica?: boolean;
  /** `true`, or an object with an optional cap in kgCO2e per transaction. */
  energy?: boolean | { capKgPerTx?: number };
}

export interface Constraints {
  /** Maximum number of hops (edges). Default 3. */
  maxHops?: number;
  /** Delivery deadline in seconds from now (compared with p90 time). */
  deadlineS?: number;
  /** Maximum total fee, USD. */
  maxFeeUsd?: number;
  /** Minimum trust tier every hop must meet. */
  trustFloor?: TrustTier;
  excludedLedgers?: Caip2[];
  /** ISO 3166-1 alpha-2 codes; excludes ledgers whose operated Router or governing entity is there. */
  excludedJurisdictions?: string[];
  /** Only Channels whose verifier checks finalized state. */
  finalizedOnly?: boolean;
  /** Include `projected` Channels (not yet live, e.g. Hiero → chain today). Default false. */
  allowProjected?: boolean;
}

export interface BalancedWeights {
  cost: number;
  time: number;
  reliability: number;
  carbon: number;
}

export interface PlanRequest {
  origin: Caip2;
  destination: Caip2;
  mode?: Mode;
  filters?: Filters;
  constraints?: Constraints;
  /** Application payload size, bytes; checked against every hop's max payload with envelope overhead. */
  payloadBytes?: number;
  /** Candidate paths generated per objective by Yen's algorithm. Default 8. */
  k?: number;
  balancedWeights?: Partial<BalancedWeights>;
  /** Evaluation time for certification expiry; default `new Date()`. */
  now?: Date;
}
