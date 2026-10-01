import type { Address, Hex, PublicClient } from "viem";
import {
  decodeAbiParameters,
  encodePacked,
  encodeFunctionData,
  formatEther,
  hexToBigInt,
  keccak256,
  sliceHex,
} from "viem";
import { RouteGraph, edgeId } from "../graph.js";
import type { Caip2, Certification, ChannelStatus, Edge, FilterLabel, RouteGraphData, TrustTier } from "../types.js";
import { TRUST_TIER_ORDER } from "../types.js";
import { ugToKg } from "../filters.js";
import type { GraphSource } from "./static.js";

/** Live Channel state read from a ledger's CLPR service. */
export interface ChannelState {
  status: ChannelStatus;
}

/** Live Connector state on the ledger that funds delivery. */
export interface ConnectorState {
  /** Balance in the ledger's native token (decimal units). */
  balanceNative: number;
  slashCount?: number;
}

/** Provider registry state (certifications, route-safety switches). One decision applies on every ledger. */
export interface RegistryState {
  /**
   * `ProviderRegistry.version()`: the decision counter (not a timestamp). Pass it to `buildEnvelope` as
   * `registryVersion`; Routers read certifications as of this version.
   */
  version?: bigint;
  /**
   * `ProviderRegistry.headAt(version)`: head of the decision hash chain at `version`. Two ledgers whose registries
   * report the same head at a version hold the same registry state up to it, so a pinned version means the same
   * thing on every hop (see `checkRegistryHeads`). Undefined for registries without a decision chain.
   */
  headHash?: Hex;
  certifications: Record<Caip2, Partial<Record<FilterLabel, Certification>>>;
  disabledLedgers: Caip2[];
  /** Edge ids (see `edgeId`). */
  disabledEdges: string[];
  disabledRouterVersions: number[];
  /**
   * Trust tiers the provider labelled Channel directions with, by edge id. Routers enforce a route's trust floor
   * against these labels (an unlabelled edge fails any floor above `attested`), so they replace the snapshot's tier.
   */
  edgeTrustTiers?: Record<string, TrustTier>;
}

/**
 * Reads the planner needs from the ledgers themselves. Implement it over RPC (see `ViemOnChainReader`), an indexer,
 * or a mock in tests. Every method may return `undefined` when the value is unknown; the base snapshot is kept then.
 */
export interface OnChainReader {
  channelState(edge: Edge): Promise<ChannelState | undefined>;
  /** State of a Connector on the receiving ledger of `edge`. */
  connectorState(edge: Edge, connectorId: string): Promise<ConnectorState | undefined>;
  registryState(): Promise<RegistryState | undefined>;
}

/**
 * Overlays live on-chain state onto a base snapshot (measured timing, gas and emissions):
 * Channel status, Connector balances, certifications, disables and registry versions.
 */
export class OnChainGraphSource implements GraphSource {
  constructor(
    private readonly base: GraphSource,
    private readonly reader: OnChainReader,
  ) {}

  async load(): Promise<RouteGraph> {
    const baseGraph = await this.base.load();
    const data: RouteGraphData = structuredClone(baseGraph.data);
    const ledgers = new Map(data.ledgers.map((l) => [l.id, l]));

    await Promise.all(
      data.edges.map(async (e) => {
        const [ch, conns] = await Promise.all([
          this.reader.channelState(e),
          Promise.all(e.connectors.map((c) => this.reader.connectorState(e, c.id))),
        ]);
        // A projected edge stays projected until the Channel exists on-chain.
        if (ch) e.status = ch.status;
        const dst = ledgers.get(e.to)!;
        e.connectors.forEach((c, i) => {
          const s = conns[i];
          if (!s) return;
          c.balanceUsd = s.balanceNative * dst.nativeUsd;
          if (s.slashCount !== undefined && s.slashCount > 0) {
            c.successRate = (c.successRate ?? 1) * Math.pow(0.9, s.slashCount);
          }
        });
      }),
    );

    const reg = await this.reader.registryState();
    if (reg) {
      for (const l of data.ledgers) {
        const certs = reg.certifications[l.id];
        if (certs) l.certifications = { ...l.certifications, ...certs };
        if (reg.disabledLedgers.includes(l.id)) l.disabled = true;
      }
      const disabled = new Set(reg.disabledEdges);
      for (const e of data.edges) {
        if (disabled.has(edgeId(e))) e.disabled = true;
        const tier = reg.edgeTrustTiers?.[edgeId(e)];
        if (tier) e.trustTier = tier;
      }
      data.disabledRouterVersions = [...new Set([...(data.disabledRouterVersions ?? []), ...reg.disabledRouterVersions])];
      if (reg.version !== undefined) data.registryVersion = Number(reg.version);
    }
    data.asOf = new Date().toISOString();
    return new RouteGraph(data);
  }
}

/** CLPR `ChannelStatus` enum order (ClprTypes.sol). */
const CLPR_STATUS: ChannelStatus[] = ["projected", "active", "paused", "closed", "closed", "closed"]; // PENDING, ACTIVE, PAUSED, CLOSING, DRAINED, CLOSED

const GET_CHANNEL_ABI = [
  {
    type: "function",
    name: "getChannel",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }], // decoded by hand; only the static head is read
  },
] as const;

const GET_CONNECTOR_ABI = [
  {
    type: "function",
    name: "getConnector",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "connectorId", type: "bytes32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "connectorId", type: "bytes32" },
          { name: "connectorContract", type: "address" },
          { name: "admin", type: "address" },
          { name: "lockedStake", type: "uint256" },
          { name: "slashCount", type: "uint32" },
        ],
      },
    ],
  },
] as const;

/**
 * Read subset of the CLPRouter `ProviderRegistry` (src/ProviderRegistry.sol). The registry keeps an append-only
 * certification log per (ledger, label) and route-safety switches keyed by `Caip` key helpers.
 */
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "isDisabled",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "trustTier",
    stateMutability: "view",
    inputs: [{ name: "edgeKey", type: "bytes32" }],
    outputs: [
      { name: "labelled", type: "bool" },
      { name: "tier", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "headAt",
    stateMutability: "view",
    inputs: [{ name: "version", type: "uint64" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "certificationAt",
    stateMutability: "view",
    inputs: [
      { name: "certKey", type: "bytes32" },
      { name: "atVersion", type: "uint64" },
    ],
    outputs: [
      { name: "certified", type: "bool" },
      { name: "emissionsUg", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "certificationLog",
    stateMutability: "view",
    inputs: [{ name: "certKey", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        // ProviderRegistry.Certification, in declaration order.
        components: [
          { name: "version", type: "uint64" }, // registry version that appended the entry
          { name: "effectiveFrom", type: "uint64" },
          { name: "expiry", type: "uint64" },
          { name: "certified", type: "bool" },
          { name: "emissionsUg", type: "uint64" }, // µgCO2e per transaction, ENERGY only
          { name: "evidenceHash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

/** Registry certification labels (`ProviderRegistry.LABEL_*`). */
export const REGISTRY_LABEL: Record<FilterLabel, number> = { ISO20022: 1, MICA: 2, ENERGY: 3 };

/** Key helpers mirroring `Caip.sol`. */
export const registryKeys = {
  ledger: (ledgerId: string): Hex => keccak256(encodePacked(["string", "string"], ["ledger", ledgerId])),
  edge: (channelId: Hex, toLedgerId: string): Hex =>
    keccak256(encodePacked(["string", "bytes32", "string"], ["edge", channelId, toLedgerId])),
  routerVersion: (version: number): Hex =>
    keccak256(encodePacked(["string", "uint32"], ["router-version", version])),
  cert: (ledgerId: string, label: FilterLabel): Hex =>
    keccak256(encodePacked(["string", "uint8", "string"], ["cert", REGISTRY_LABEL[label], ledgerId])),
};

export interface ViemLedgerConfig {
  client: PublicClient;
  /** `ClprService` address on this ledger. */
  clprService: Address;
}

export interface ViemOnChainReaderConfig {
  /** EVM ledgers keyed by CAIP-2 id. Non-EVM ledgers keep the base snapshot (or use another reader). */
  ledgers: Record<Caip2, ViemLedgerConfig>;
  /** Ledger and address of the provider registry to read (one decision applies on every ledger). */
  registry?: { ledger: Caip2; address: Address };
  /** Ledgers to read certifications and disables for. */
  ledgerIds: Caip2[];
  routerVersions?: number[];
  /** Edges to check for disables (Channel ids must be 32-byte hex). */
  edges?: Edge[];
  /** Clock for picking the certification in effect; default `new Date()`. */
  now?: () => Date;
}

/**
 * `OnChainReader` over viem public clients. Channel ids and Connector ids in the graph must be 32-byte hex.
 * `getChannel` and `getConnector` are non-view in `IClprService`, so they are read with `eth_call`.
 */
export class ViemOnChainReader implements OnChainReader {
  constructor(private readonly cfg: ViemOnChainReaderConfig) {}

  async channelState(edge: Edge): Promise<ChannelState | undefined> {
    // A Channel direction is live when the receiving ledger's service has the Channel active (it verifies bundles).
    const l = this.cfg.ledgers[edge.to];
    if (!l) return undefined;
    const data = encodeFunctionData({ abi: GET_CHANNEL_ABI, functionName: "getChannel", args: [edge.channelId as Hex] });
    const res = await l.client.call({ to: l.clprService, data });
    if (!res.data) return undefined;
    // Return data: [offset][tuple head...]; Channel = (channelId, verifier, status, ...).
    const tupleStart = Number(hexToBigInt(sliceHex(res.data, 0, 32)));
    const statusWord = sliceHex(res.data, tupleStart + 64, tupleStart + 96);
    const s = CLPR_STATUS[Number(hexToBigInt(statusWord))];
    return s ? { status: s } : undefined;
  }

  async connectorState(edge: Edge, connectorId: string): Promise<ConnectorState | undefined> {
    const l = this.cfg.ledgers[edge.to];
    if (!l) return undefined;
    const data = encodeFunctionData({
      abi: GET_CONNECTOR_ABI,
      functionName: "getConnector",
      args: [edge.channelId as Hex, connectorId as Hex],
    });
    const res = await l.client.call({ to: l.clprService, data });
    if (!res.data) return undefined;
    const [c] = decodeAbiParameters(GET_CONNECTOR_ABI[0].outputs, res.data);
    const bal = await l.client.getBalance({ address: c.connectorContract });
    return { balanceNative: Number(formatEther(bal)), slashCount: c.slashCount };
  }

  async registryState(): Promise<RegistryState | undefined> {
    const r = this.cfg.registry;
    if (!r) return undefined;
    const client = this.cfg.ledgers[r.ledger]?.client;
    if (!client) return undefined;
    const now = Math.floor((this.cfg.now?.() ?? new Date()).getTime() / 1000);
    // Read the version first: every entry read below was appended at or before it, so the snapshot is
    // consistent with the version a route sent now would pin (entries appended later are ignored).
    const version = await client.readContract({ address: r.address, abi: REGISTRY_ABI, functionName: "version" });
    const headHash = await readHead(client, r.address, version);
    const disabled = (key: Hex) =>
      client.readContract({ address: r.address, abi: REGISTRY_ABI, functionName: "isDisabled", args: [key] });

    const certifications: RegistryState["certifications"] = {};
    const disabledLedgers: Caip2[] = [];
    for (const id of this.cfg.ledgerIds) {
      const certs: Partial<Record<FilterLabel, Certification>> = {};
      for (const label of Object.keys(REGISTRY_LABEL) as FilterLabel[]) {
        const log = await client.readContract({
          address: r.address,
          abi: REGISTRY_ABI,
          functionName: "certificationLog",
          args: [registryKeys.cert(id, label)],
        });
        // As `certificationAt(key, version)`: the last entry appended at or before `version` whose notice period
        // has passed (the log is ordered by version and by effective time).
        const entry = [...log].reverse().find((c) => c.version <= version && Number(c.effectiveFrom) <= now);
        if (!entry) continue;
        certs[label] = {
          status: entry.certified ? "full" : "revoked",
          expiresAt: new Date(Number(entry.expiry) * 1000).toISOString(),
          evidenceHash: entry.evidenceHash,
          effectiveFrom: Number(entry.effectiveFrom),
          kgCO2ePerTx: label === "ENERGY" && entry.emissionsUg > 0n ? ugToKg(entry.emissionsUg) : undefined,
          source: { kind: "on-chain", ref: `ProviderRegistry ${r.address} on ${r.ledger}` },
        };
      }
      certifications[id] = certs;
      if (await disabled(registryKeys.ledger(id))) disabledLedgers.push(id);
    }
    const disabledEdges: string[] = [];
    const edgeTrustTiers: Record<string, TrustTier> = {};
    for (const e of this.cfg.edges ?? []) {
      const key = registryKeys.edge(e.channelId as Hex, e.to);
      if (await disabled(key)) disabledEdges.push(edgeId(e));
      const [labelled, tier] = await client.readContract({
        address: r.address,
        abi: REGISTRY_ABI,
        functionName: "trustTier",
        args: [key],
      });
      const t = TRUST_TIER_ORDER[tier];
      if (labelled && t) edgeTrustTiers[edgeId(e)] = t;
    }
    const disabledRouterVersions: number[] = [];
    for (const v of this.cfg.routerVersions ?? []) {
      if (await disabled(registryKeys.routerVersion(v))) disabledRouterVersions.push(v);
    }
    return { version, headHash, certifications, disabledLedgers, disabledEdges, disabledRouterVersions, edgeTrustTiers };
  }
}

async function readHead(client: PublicClient, address: Address, version: bigint): Promise<Hex | undefined> {
  try {
    return await client.readContract({ address, abi: REGISTRY_ABI, functionName: "headAt", args: [version] });
  } catch {
    return undefined; // a registry without a decision chain
  }
}

/** Result of {@link checkRegistryHeads}. */
export interface RegistryHeadCheck {
  /** True if every registry has reached `version` and reports the same head there. */
  consistent: boolean;
  /** Head per ledger (zero hash = that registry has not reached `version` yet). */
  heads: Record<Caip2, Hex>;
}

const ZERO_HEAD: Hex = `0x${"0".repeat(64)}`;

/**
 * Checks that the registries of every ledger a route touches agree on the registry history up to the version the
 * route pins. Routers compare certifications by version only; this makes sure that version names one state on all
 * hops (a ledger whose registry has not reached the version, or forked from the others, fails the check).
 */
export async function checkRegistryHeads(
  registries: Record<Caip2, { client: PublicClient; address: Address }>,
  version: bigint,
): Promise<RegistryHeadCheck> {
  const entries = await Promise.all(
    Object.entries(registries).map(async ([id, r]) => [id, (await readHead(r.client, r.address, version)) ?? ZERO_HEAD] as const),
  );
  const heads = Object.fromEntries(entries) as Record<Caip2, Hex>;
  const values = entries.map(([, h]) => h.toLowerCase());
  const consistent = values.length > 0 && values[0] !== ZERO_HEAD && values.every((h) => h === values[0]);
  return { consistent, heads };
}
