import type { Hex, LocalAccount } from "viem";
import { bytesToHex, hexToBytes, isHex, keccak256, recoverMessageAddress, stringToBytes } from "viem";
import { kgToUg } from "./filters.js";
import type { PlanSuccess } from "./planner.js";
import { ProtoWriter, fieldString, readFields } from "./proto.js";
import type { RouteQuote } from "./quote.js";
import type { Caip10, Caip2, FilterLabel, Mode, TrustTier } from "./types.js";
import { TRUST_TIER_ORDER, trustRank } from "./types.js";

/**
 * `ClprRouteEnvelope` as defined in proto/clprouter/v1/route_envelope.proto (spec "Route envelope").
 * Field names follow the proto. Numbers that the proto carries as integers are `bigint` here.
 */
export type PayloadType = "raw" | "iso20022" | "asset" | "receipt";
/** How the payload bytes relate to the application message. ISO 20022 and MiCA filters forbid `plaintext`. */
export type PayloadProtection = "plaintext" | "ciphertext" | "hash";

export interface RouteEndpoint {
  /** CAIP-2. */
  ledger_id: Caip2;
  /** Application address bytes (20 bytes on EVM). */
  application: Hex;
}

/** hops[i] is the i-th ledger the route touches and the edge leaving it; the destination hop has no channel. */
export interface RouteHop {
  ledger_id: Caip2;
  /** CLPRouter deployment on this ledger (`0x` if not pinned). */
  router: Hex;
  /** 32 bytes, or `0x` on the destination hop. */
  channel_id: Hex;
  /** 32 bytes, or `0x` on the destination hop. */
  connector_id: Hex;
  /** Fee (origin native smallest units) this hop takes for the next hop. */
  fee: bigint;
  /** Origin-ledger account paid `fee` when the route settles (`0x` if none). */
  fee_payee: Hex;
}

export interface RouteConstraints {
  filters: FilterLabel[];
  /** Unix seconds; any hop past it drops the message. */
  deadline: bigint;
  /** Cap on the sum of hop fees, origin native smallest units (0 = budget only). */
  max_fee: bigint;
  remaining_fee_budget: bigint;
  trust_floor: TrustTier;
  max_hops: number;
  /** false = strict source routing; true = hops may re-route. */
  loose: boolean;
  /** Energy filter cap in µgCO2e (micrograms) per transaction, the registry's unit (0 = no cap). */
  energy_cap: bigint;
}

export interface FilterRegistryVersion {
  filter: FilterLabel;
  /**
   * `ProviderRegistry.version()` the route was checked against: the registry's decision counter (one per applied
   * committee decision, identical on every ledger), not a timestamp. The origin Router stamps it at `send`.
   */
  version: bigint;
}

export interface ClprRouteEnvelope {
  /** 16 bytes; the UETR under the ISO 20022 filter. */
  route_id: Hex;
  origin: RouteEndpoint;
  destination: RouteEndpoint;
  sender: Caip10;
  recipient: Caip10;
  hops: RouteHop[];
  hop_index: number;
  mode: Mode;
  constraints: RouteConstraints;
  payload_type: PayloadType;
  payload: Hex;
  /** Explicit way back for the receipt; empty = reverse hops (`auto`). */
  receipt_path: RouteHop[];
  /** Optional end-to-end signature by the origin application (`0x` if none). */
  origin_signature: Hex;
  filter_registry_versions: FilterRegistryVersion[];
  router_version: number;
}

export interface AssetInfo {
  symbol: string;
  /** MiCA classification; only `EMT` and `ART` stablecoins may move under the MiCA filter. */
  micaClass: "EMT" | "ART" | "other";
}

export interface BuildEnvelopeInput {
  plan: PlanSuccess;
  /** Defaults to `plan.route`; pass `plan.fallback.route` to send on the fallback. */
  route?: RouteQuote;
  originApp: Hex;
  destinationApp: Hex;
  sender: Caip10;
  recipient: Caip10;
  payload: Hex | Uint8Array;
  payloadType?: Exclude<PayloadType, "receipt">;
  payloadProtection?: PayloadProtection;
  asset?: AssetInfo;
  /** Origin native token: USD price and decimals, to turn USD quotes into on-chain fee budgets. */
  feeUnit: { nativeUsd: number; decimals: number };
  /** Deadline as seconds from `now`; defaults to the route's p90 time × 2 (at least 10 minutes). */
  deadlineS?: number;
  maxFeeUsd?: number;
  trustFloor?: TrustTier;
  maxHops?: number;
  /** Default: strict for asset payloads, loose for data (spec recommendation). */
  loose?: boolean;
  /** Energy cap in kgCO2e per transaction (encoded as µgCO2e, rounded up). Defaults to the plan's filter cap. */
  energyCapKgPerTx?: number;
  /**
   * `ProviderRegistry.version()` on the origin ledger (e.g. `RegistryState.version` from `ViemOnChainReader`).
   * Required when a filter is active: it is pinned into `filter_registry_versions`, mirroring what the origin
   * Router stamps at `send`.
   */
  registryVersion?: bigint;
  /** `reverse` writes the reversed hops; `auto` (default) leaves the path empty, which Routers read as reverse hops. */
  receiptPath?: "auto" | "reverse";
  /** CLPRouter deployment per ledger, pinned into the hops. */
  routers?: Partial<Record<Caip2, Hex>>;
  /** Origin-ledger fee payee per hop index. */
  feePayees?: Partial<Record<number, Hex>>;
  routerVersion?: number;
  /** 16 bytes; random UUIDv4 bytes when omitted. */
  routeId?: Hex;
  now?: Date;
}

const CAIP10 = /^([-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}):([-.%a-zA-Z0-9]{1,128})$/;

export function parseCaip10(id: string): { chain: Caip2; address: string } {
  const m = CAIP10.exec(id);
  if (!m) throw new Error(`not a CAIP-10 account id: ${id}`);
  return { chain: m[1]!, address: m[2]! };
}

export function randomRouteId(): Hex {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; // UUID version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToHex(b);
}

/** The route id formatted as a UUID (the UETR under the ISO 20022 filter). */
export function routeIdToUuid(id: Hex): string {
  const h = id.slice(2).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function isUuidV4(id: Hex): boolean {
  const b = hexToBytes(id);
  return b.length === 16 && b[6]! >> 4 === 4 && (b[8]! & 0xc0) === 0x80;
}

/**
 * On-chain 32-byte id for a Channel or Connector. Graph ids that are already 32-byte hex pass through; readable
 * placeholder ids (sample and test graphs) are hashed, which only makes sense off-chain.
 */
export function toBytes32Id(id: string): Hex {
  if (isHex(id) && hexToBytes(id).length === 32) return id;
  return keccak256(stringToBytes(id));
}

function usdToUnits(usd: number, unit: { nativeUsd: number; decimals: number }): bigint {
  if (!(unit.nativeUsd > 0)) throw new Error("feeUnit.nativeUsd must be > 0");
  // Round up so the budget always covers the quote.
  const scaled = (usd / unit.nativeUsd) * 10 ** unit.decimals;
  return BigInt(Math.ceil(scaled - 1e-9 * Math.max(1, scaled)));
}

export function buildEnvelope(input: BuildEnvelopeInput): ClprRouteEnvelope {
  const { plan } = input;
  const route = input.route ?? plan.route;
  const filters = plan.filters;
  const iso = filters.includes("ISO20022");
  const mica = filters.includes("MICA");
  const origin = route.ledgers[0]!;
  const destination = route.ledgers[route.ledgers.length - 1]!;

  const sender = parseCaip10(input.sender);
  const recipient = parseCaip10(input.recipient);
  if (sender.chain !== origin) throw new Error(`sender ${input.sender} is not on the origin ledger ${origin}`);
  if (recipient.chain !== destination) {
    throw new Error(`recipient ${input.recipient} is not on the destination ledger ${destination}`);
  }

  const payload: Hex = typeof input.payload === "string" ? input.payload : bytesToHex(input.payload);
  if (!isHex(payload)) throw new Error("payload must be hex or bytes");
  const payloadType: PayloadType = input.payloadType ?? (iso ? "iso20022" : input.asset ? "asset" : "raw");
  const protection: PayloadProtection = input.payloadProtection ?? "plaintext";

  if (iso && payloadType !== "iso20022") throw new Error("ISO 20022 filter: payload_type must be iso20022");
  if ((iso || mica) && protection === "plaintext") {
    throw new Error("ISO 20022 / MiCA filter: payload must be ciphertext or a hash, never plaintext");
  }
  if (protection === "hash" && hexToBytes(payload).length !== 32) throw new Error("hash payload must be 32 bytes");
  if (payloadType === "asset" && !input.asset) throw new Error("asset payload needs asset info");
  if (mica && input.asset && input.asset.micaClass !== "EMT" && input.asset.micaClass !== "ART") {
    throw new Error(`MiCA filter: ${input.asset.symbol} is not a MiCA-authorised EMT or ART`);
  }

  const maxHops = input.maxHops ?? Math.max(3, route.hops.length);
  if (route.hops.length > maxHops) throw new Error(`route has ${route.hops.length} hops, above maxHops ${maxHops}`);
  const trustFloor = input.trustFloor ?? route.effectiveTrustTier;
  if (trustRank(route.effectiveTrustTier) < trustRank(trustFloor)) {
    throw new Error(`route trust tier ${route.effectiveTrustTier} is below the floor ${trustFloor}`);
  }
  const maxFeeUsd = input.maxFeeUsd ?? route.totals.costUsd;
  if (route.totals.costUsd > maxFeeUsd + 1e-12) throw new Error("route cost exceeds maxFeeUsd");

  const routeId = input.routeId ?? randomRouteId();
  if (hexToBytes(routeId).length !== 16) throw new Error("route_id must be 16 bytes");
  if (iso && !isUuidV4(routeId)) throw new Error("ISO 20022 filter: route_id must be a UUIDv4 (the UETR)");

  const now = input.now ?? new Date();
  const deadlineS = input.deadlineS ?? Math.max(600, Math.ceil(route.totals.timeP90S * 2));
  const routers = input.routers ?? {};
  const hops: RouteHop[] = route.ledgers.map((ledger, i) => {
    const q = route.hops[i];
    return {
      ledger_id: ledger,
      router: routers[ledger] ?? "0x",
      channel_id: q ? toBytes32Id(q.channelId) : "0x",
      connector_id: q ? toBytes32Id(q.connectorId) : "0x",
      fee: q ? usdToUnits(q.cost.totalUsd, input.feeUnit) : 0n,
      fee_payee: input.feePayees?.[i] ?? "0x",
    };
  });
  const sumFees = hops.reduce((s, h) => s + h.fee, 0n);
  const maxFee = usdToUnits(maxFeeUsd, input.feeUnit);
  const budget = maxFee > sumFees ? maxFee : sumFees;

  const capKg = input.energyCapKgPerTx ?? plan.energyCapKgPerTx;
  const energyCap = filters.includes("ENERGY") && capKg !== undefined ? kgToUg(capKg, "up") : 0n;
  if (filters.includes("ENERGY") && capKg !== undefined && energyCap === 0n) {
    throw new Error("ENERGY cap rounds to 0 µgCO2e, which the Router reads as no cap");
  }
  if (filters.length > 0 && input.registryVersion === undefined) {
    throw new Error("filters are active: pass registryVersion (ProviderRegistry.version() on the origin ledger)");
  }
  if (input.registryVersion !== undefined && input.registryVersion < 0n) throw new Error("registryVersion must be >= 0");

  return {
    route_id: routeId,
    origin: { ledger_id: origin, application: input.originApp },
    destination: { ledger_id: destination, application: input.destinationApp },
    sender: input.sender,
    recipient: input.recipient,
    hops,
    hop_index: 0,
    mode: plan.mode,
    constraints: {
      filters: [...filters],
      deadline: BigInt(Math.floor(now.getTime() / 1000) + deadlineS),
      max_fee: budget,
      remaining_fee_budget: budget,
      trust_floor: trustFloor,
      max_hops: maxHops,
      loose: input.loose ?? payloadType !== "asset",
      energy_cap: energyCap,
    },
    payload_type: payloadType,
    payload,
    receipt_path:
      input.receiptPath === "reverse"
        ? // Same Channels, opposite direction: the hop leaving ledger i+1 on the way back uses the Channel of edge i.
          // Connectors and fees are chosen when the receipt is sent.
          [...hops].reverse().map((h, j, rev) => ({
            ledger_id: h.ledger_id,
            router: h.router,
            channel_id: j + 1 < rev.length ? rev[j + 1]!.channel_id : "0x",
            connector_id: "0x",
            fee: 0n,
            fee_payee: "0x",
          }))
        : [],
    origin_signature: "0x",
    filter_registry_versions: filters.map((f) => ({ filter: f, version: input.registryVersion! })),
    router_version: input.routerVersion ?? 1,
  };
}

/** `uetr` view of an ISO 20022 envelope's route id. */
export function envelopeUetr(env: ClprRouteEnvelope): string | undefined {
  return env.constraints.filters.includes("ISO20022") ? routeIdToUuid(env.route_id) : undefined;
}

// ── protobuf codec ─────────────────────────────────────────────────────────

const MODE_NUM: Record<Mode, number> = { balanced: 0, cheapest: 1, fastest: 2, reliable: 3, greenest: 4 };
const FILTER_BIT: Record<FilterLabel, number> = { ISO20022: 1, MICA: 2, ENERGY: 4 };
const PAYLOAD_NUM: Record<PayloadType, number> = { raw: 0, iso20022: 1, asset: 2, receipt: 3 };

function invert<K extends string>(m: Record<K, number>): Map<number, K> {
  return new Map(Object.entries(m).map(([k, v]) => [v as number, k as K]));
}
const MODE_OF = invert(MODE_NUM);
const PAYLOAD_OF = invert(PAYLOAD_NUM);
const FILTER_OF = invert(FILTER_BIT);

function filterBits(fs: FilterLabel[]): number {
  return fs.reduce((b, f) => b | FILTER_BIT[f], 0);
}

function bitsToFilters(bits: number): FilterLabel[] {
  return (["ISO20022", "MICA", "ENERGY"] as FilterLabel[]).filter((f) => bits & FILTER_BIT[f]);
}

/**
 * Fixed-length ids (route_id, channel_id, connector_id) are `bytes16` / `bytes32` in Solidity, where all zeros means
 * "absent" and is omitted on the wire. Treat an all-zero id the same way so both codecs emit identical bytes.
 */
function idField(v: Hex): Hex {
  return /^0x0*$/.test(v) ? "0x" : v;
}

function hopWriter(h: RouteHop): ProtoWriter {
  return new ProtoWriter()
    .string(1, h.ledger_id)
    .bytes(2, h.router)
    .bytes(3, idField(h.channel_id))
    .bytes(4, idField(h.connector_id))
    .uint(5, h.fee)
    .bytes(6, h.fee_payee);
}

/** Encode to protobuf bytes, byte-compatible with the Solidity `RouteCodec.encodeEnvelope`. */
export function encodeEnvelope(env: ClprRouteEnvelope): Hex {
  const c = env.constraints;
  const w = new ProtoWriter()
    .bytes(1, idField(env.route_id))
    .message(2, new ProtoWriter().string(1, env.origin.ledger_id).bytes(2, env.origin.application))
    .message(3, new ProtoWriter().string(1, env.destination.ledger_id).bytes(2, env.destination.application))
    .string(4, env.sender)
    .string(5, env.recipient);
  for (const h of env.hops) w.element(6, hopWriter(h));
  w.uint(7, env.hop_index)
    .uint(8, MODE_NUM[env.mode])
    .message(
      9,
      new ProtoWriter()
        .uint(1, filterBits(c.filters))
        .uint(2, c.deadline)
        .uint(3, c.max_fee)
        .uint(4, c.remaining_fee_budget)
        .uint(5, trustRank(c.trust_floor))
        .uint(6, c.max_hops)
        .uint(7, c.loose)
        .uint(8, c.energy_cap),
    )
    .uint(10, PAYLOAD_NUM[env.payload_type])
    .bytes(11, env.payload);
  for (const h of env.receipt_path) w.element(12, hopWriter(h));
  w.bytes(13, env.origin_signature);
  for (const v of env.filter_registry_versions) {
    w.element(14, new ProtoWriter().uint(1, FILTER_BIT[v.filter]).uint(2, v.version));
  }
  w.uint(15, env.router_version);
  return w.hex();
}

function decodeHop(b: Uint8Array): RouteHop {
  const h: RouteHop = { ledger_id: "", router: "0x", channel_id: "0x", connector_id: "0x", fee: 0n, fee_payee: "0x" };
  for (const f of readFields(b)) {
    if (f.field === 1) h.ledger_id = fieldString(f);
    else if (f.field === 2) h.router = bytesToHex(f.bytes!);
    else if (f.field === 3) h.channel_id = bytesToHex(f.bytes!);
    else if (f.field === 4) h.connector_id = bytesToHex(f.bytes!);
    else if (f.field === 5) h.fee = f.int!;
    else if (f.field === 6) h.fee_payee = bytesToHex(f.bytes!);
  }
  return h;
}

function decodeEndpoint(b: Uint8Array): RouteEndpoint {
  const e: RouteEndpoint = { ledger_id: "", application: "0x" };
  for (const f of readFields(b)) {
    if (f.field === 1) e.ledger_id = fieldString(f);
    else if (f.field === 2) e.application = bytesToHex(f.bytes!);
  }
  return e;
}

/** Decode protobuf bytes; unknown fields are skipped. */
export function decodeEnvelope(data: Hex): ClprRouteEnvelope {
  const env: ClprRouteEnvelope = {
    route_id: "0x",
    origin: { ledger_id: "", application: "0x" },
    destination: { ledger_id: "", application: "0x" },
    sender: "",
    recipient: "",
    hops: [],
    hop_index: 0,
    mode: "balanced",
    constraints: {
      filters: [],
      deadline: 0n,
      max_fee: 0n,
      remaining_fee_budget: 0n,
      trust_floor: TRUST_TIER_ORDER[0]!,
      max_hops: 0,
      loose: false,
      energy_cap: 0n,
    },
    payload_type: "raw",
    payload: "0x",
    receipt_path: [],
    origin_signature: "0x",
    filter_registry_versions: [],
    router_version: 0,
  };
  const len = (f: { wt: number; bytes?: Uint8Array }) => f.wt === 2 && f.bytes !== undefined;
  for (const f of readFields(hexToBytes(data))) {
    const b = f.bytes!;
    switch (f.field) {
      case 1: if (len(f)) env.route_id = bytesToHex(b); break;
      case 2: if (len(f)) env.origin = decodeEndpoint(b); break;
      case 3: if (len(f)) env.destination = decodeEndpoint(b); break;
      case 4: if (len(f)) env.sender = fieldString(f); break;
      case 5: if (len(f)) env.recipient = fieldString(f); break;
      case 6: if (len(f)) env.hops.push(decodeHop(b)); break;
      case 7: env.hop_index = Number(f.int ?? 0n); break;
      case 8: env.mode = MODE_OF.get(Number(f.int ?? 0n)) ?? "balanced"; break;
      case 9:
        if (!len(f)) break;
        for (const c of readFields(b)) {
          const v = c.int ?? 0n;
          if (c.field === 1) env.constraints.filters = bitsToFilters(Number(v));
          else if (c.field === 2) env.constraints.deadline = v;
          else if (c.field === 3) env.constraints.max_fee = v;
          else if (c.field === 4) env.constraints.remaining_fee_budget = v;
          else if (c.field === 5) env.constraints.trust_floor = TRUST_TIER_ORDER[Number(v)] ?? TRUST_TIER_ORDER[0]!;
          else if (c.field === 6) env.constraints.max_hops = Number(v);
          else if (c.field === 7) env.constraints.loose = v !== 0n;
          else if (c.field === 8) env.constraints.energy_cap = v;
        }
        break;
      case 10: env.payload_type = PAYLOAD_OF.get(Number(f.int ?? 0n)) ?? "raw"; break;
      case 11: if (len(f)) env.payload = bytesToHex(b); break;
      case 12: if (len(f)) env.receipt_path.push(decodeHop(b)); break;
      case 13: if (len(f)) env.origin_signature = bytesToHex(b); break;
      case 14: {
        if (!len(f)) break;
        let filter: FilterLabel | undefined;
        let version = 0n;
        for (const c of readFields(b)) {
          if (c.field === 1) filter = FILTER_OF.get(Number(c.int ?? 0n));
          else if (c.field === 2) version = c.int ?? 0n;
        }
        if (filter) env.filter_registry_versions.push({ filter, version });
        break;
      }
      case 15: env.router_version = Number(f.int ?? 0n); break;
    }
  }
  return env;
}

export function envelopeHash(env: ClprRouteEnvelope): Hex {
  return keccak256(encodeEnvelope(env));
}

/**
 * Hash the origin signs: the envelope as it leaves the origin (hop 0, full fee budget) with no signature, so the
 * signature stays valid while `hop_index` and the remaining budget change along the route.
 */
export function envelopeSigningHash(env: ClprRouteEnvelope): Hex {
  return envelopeHash({
    ...env,
    hop_index: 0,
    origin_signature: "0x",
    constraints: { ...env.constraints, remaining_fee_budget: env.constraints.max_fee },
  });
}

/** Add the optional end-to-end origin signature (EIP-191 over the signing hash). */
export async function signEnvelope(env: ClprRouteEnvelope, account: LocalAccount): Promise<ClprRouteEnvelope> {
  const signature = await account.signMessage({ message: { raw: envelopeSigningHash(env) } });
  return { ...env, origin_signature: signature };
}

export async function recoverEnvelopeSigner(env: ClprRouteEnvelope): Promise<Hex> {
  if (env.origin_signature === "0x") throw new Error("envelope is not signed");
  return recoverMessageAddress({ message: { raw: envelopeSigningHash(env) }, signature: env.origin_signature });
}

/** Copy of the envelope for the next hop: hop_index + 1, fee budget reduced by this hop's fee. */
export function advanceEnvelope(env: ClprRouteEnvelope): ClprRouteEnvelope {
  if (env.hop_index + 1 >= env.hops.length) throw new Error("envelope is already at its destination");
  const fee = env.hops[env.hop_index]!.fee;
  const remaining = env.constraints.remaining_fee_budget - fee;
  if (remaining < 0n) throw new Error("fee budget exhausted");
  return {
    ...env,
    hop_index: env.hop_index + 1,
    constraints: { ...env.constraints, remaining_fee_budget: remaining },
  };
}
