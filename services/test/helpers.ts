import type { Abi, Address, Hex, Log } from "viem";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import { encodeEnvelope } from "@clprouter/sdk";
import { REGISTRY_ABI, ROUTER_ABI, VAULT_ABI } from "../src/abi.js";
import type { ContractKind, IndexedEvent } from "../src/events.js";
import { decodeLog } from "../src/events.js";
import type { ChainReader } from "../src/indexer.js";

export const ROUTER: Address = "0x1000000000000000000000000000000000000001";
export const REGISTRY: Address = "0x2000000000000000000000000000000000000002";
export const VAULT: Address = "0x3000000000000000000000000000000000000003";
export const ADDR: Record<ContractKind, Address> = { router: ROUTER, registry: REGISTRY, vault: VAULT };
const ABI: Record<ContractKind, Abi> = { router: ROUTER_ABI, registry: REGISTRY_ABI, vault: VAULT_ABI };

export const ZERO32: Hex = `0x${"0".repeat(64)}`;
export const h32 = (s: string): Hex => keccak256(toHex(s));
export const rid = (n: number): Hex => `0x${n.toString(16).padStart(32, "0")}`;

/** A real encoded A → B → C envelope with route id `rid(n)` at `hopIndex` (Routers key hop state by its hops[0]). */
export function testEnvelope(n: number, hopIndex = 1): Hex {
  const hop = (ledger_id: string, router: Hex, ch: Hex) => ({
    ledger_id,
    router,
    channel_id: ch,
    connector_id: ch === "0x" ? ("0x" as Hex) : h32("conn"),
    fee: 0n,
    fee_payee: "0x" as Hex,
  });
  return encodeEnvelope({
    route_id: rid(n),
    origin: { ledger_id: "eip155:31001", application: "0x00000000000000000000000000000000000000aa" },
    destination: { ledger_id: "eip155:31003", application: "0x00000000000000000000000000000000000000cc" },
    sender: "eip155:31001:0x00000000000000000000000000000000000000aa",
    recipient: "eip155:31003:0x00000000000000000000000000000000000000cc",
    hops: [
      hop("eip155:31001", "0x00000000000000000000000000000000000000a1", h32("AB")),
      hop("eip155:31002", "0x00000000000000000000000000000000000000b1", h32("BC")),
      hop("eip155:31003", "0x00000000000000000000000000000000000000c1", "0x"),
    ],
    hop_index: hopIndex,
    mode: "balanced",
    constraints: {
      filters: [],
      deadline: 1_800_003_600n,
      max_fee: 0n,
      remaining_fee_budget: 0n,
      trust_floor: "attested",
      max_hops: 0,
      loose: false,
      energy_cap: 0n,
    },
    payload_type: "raw",
    payload: "0x01",
    receipt_path: [],
    origin_signature: "0x",
    filter_registry_versions: [],
    router_version: 1,
    iso_uetr: "0x",
  });
}

export interface LogSpec {
  contract: ContractKind;
  event: string;
  args: Record<string, unknown>;
  /** Emit from another address (default: the watched contract of this kind). */
  address?: Address;
}

/** Encode an event the way the EVM would log it (topics for indexed args, ABI data for the rest). */
export function encodeLog(spec: LogSpec, address = spec.address ?? ADDR[spec.contract]): Pick<Log, "address" | "topics" | "data"> {
  const abi = ABI[spec.contract];
  const ev = abi.find((x) => x.type === "event" && x.name === spec.event) as
    | { inputs: { name: string; type: string; indexed?: boolean; components?: unknown }[] }
    | undefined;
  if (!ev) throw new Error(`no event ${spec.event}`);
  const topics = encodeEventTopics({ abi, eventName: spec.event, args: spec.args } as never) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => spec.args[i.name]) as never);
  return { address, topics: topics as [Hex, ...Hex[]], data };
}

/** Build an IndexedEvent directly (status / registry unit tests). */
export function ev(
  ledger: string,
  spec: LogSpec,
  pos: { block: number; log?: number; ts?: number; tx?: Hex },
): IndexedEvent {
  const l = encodeLog(spec);
  const e = decodeLog(
    ledger,
    spec.contract,
    {
      ...l,
      blockNumber: BigInt(pos.block),
      blockHash: h32(`${ledger}:${pos.block}`),
      transactionHash: pos.tx ?? h32(`${ledger}:${pos.block}:${pos.log ?? 0}:tx`),
      logIndex: pos.log ?? 0,
    },
    pos.ts ?? 1_800_000_000 + pos.block,
  );
  if (!e) throw new Error(`failed to decode ${spec.event}`);
  return e;
}

/**
 * In-memory chain for indexer tests. Blocks carry a fork tag in their hash, so a reorg changes the hashes of the
 * replaced blocks.
 */
export class MockChain implements ChainReader {
  blocks: { hash: Hex; timestamp: number; logs: LogSpec[] }[] = [];
  getLogsCalls: { from: number; to: number }[] = [];

  constructor(public genesisTs = 1_800_000_000) {
    this.mine([]);
  }

  get head(): number {
    return this.blocks.length - 1;
  }

  mine(logs: LogSpec[] = [], fork = "main"): number {
    const n = this.blocks.length;
    this.blocks.push({ hash: h32(`${fork}:${n}`), timestamp: this.genesisTs + n * 2, logs });
    return n;
  }

  mineEmpty(count: number): void {
    for (let i = 0; i < count; i++) this.mine([]);
  }

  /** Replace every block from `from` with new ones on fork `fork`. */
  reorg(from: number, replacement: LogSpec[][], fork: string): void {
    this.blocks = this.blocks.slice(0, from);
    for (const logs of replacement) this.mine(logs, fork);
  }

  async getBlockNumber(): Promise<bigint> {
    return BigInt(this.head);
  }

  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    const b = this.blocks[Number(blockNumber)];
    if (!b) throw new Error(`no block ${blockNumber}`);
    return { number: blockNumber, hash: b.hash, timestamp: BigInt(b.timestamp) };
  }

  async getLogs({ address, fromBlock, toBlock }: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]> {
    this.getLogsCalls.push({ from: Number(fromBlock), to: Number(toBlock) });
    const want = new Set(address.map((a) => a.toLowerCase()));
    const out: Log[] = [];
    for (let n = Number(fromBlock); n <= Number(toBlock); n++) {
      const b = this.blocks[n];
      if (!b) continue;
      b.logs.forEach((spec, i) => {
        const enc = encodeLog(spec);
        if (!want.has(enc.address.toLowerCase())) return;
        out.push({
          ...enc,
          blockNumber: BigInt(n),
          blockHash: b.hash,
          transactionHash: h32(`${b.hash}:${i}`),
          logIndex: i,
          transactionIndex: 0,
          removed: false,
        } as Log);
      });
    }
    return out;
  }
}

// ── Event builders ─────────────────────────────────────────────────────────

export const R = {
  sent: (routeId: Hex, o: Partial<{ sender: Address; dest: string; escrow: bigint; budget: bigint; deadline: bigint; messageId: bigint }> = {}): LogSpec => ({
    contract: "router",
    event: "RouteSent",
    args: {
      routeId,
      sender: o.sender ?? "0xa11ce00000000000000000000000000000000001",
      destinationLedger: o.dest ?? "eip155:31003",
      escrow: o.escrow ?? 0n,
      feeBudget: o.budget ?? 30_000_000_000_000_000n,
      deadline: o.deadline ?? 1_800_003_600n,
      messageId: o.messageId ?? 1n,
    },
  }),
  /** Routes: `key` = keccak256(envelope). Receipts: pass the outbox `key` with the receipt data. */
  forwarded: (routeId: Hex, hopIndex: number, channelId: Hex = h32("BC"), messageId = 7n, envelope: Hex = "0x", key: Hex = keccak256(envelope)): LogSpec => ({
    contract: "router",
    event: "RouteForwarded",
    args: { routeId, hopIndex, channelId, messageId, key, data: envelope },
  }),
  requeued: (key: Hex, clprStatus: number): LogSpec => ({
    contract: "router",
    event: "ReceiptRequeued",
    args: { key, clprStatus },
  }),
  pending: (routeId: Hex, hopIndex: number, envelope: Hex): LogSpec => ({
    contract: "router",
    event: "ForwardPending",
    args: { routeId, hopIndex, envelope },
  }),
  /** `envelopeHash` defaults to keccak256(envelope); pass it for a NACK that carries no envelope. */
  rejected: (routeId: Hex, clprStatus: number, envelope: Hex = "0x", hopIndex = 1, envelopeHash: Hex = keccak256(envelope)): LogSpec => ({
    contract: "router",
    event: "ForwardRejected",
    // reason: SEND_FAILED (11) when the local send failed, else NEXT_HOP_ERROR (10)
    args: { routeId, hopIndex, envelopeHash, clprStatus, reason: clprStatus === 0 ? 11 : 10, envelope },
  }),
  outbox: (key: Hex, data: Hex = "0x1234"): LogSpec => ({
    contract: "router",
    event: "OutboxQueued",
    args: { key, channelId: h32("BC"), connectorId: h32("conn"), target: "0x1000000000000000000000000000000000000009", data },
  }),
  delivered: (routeId: Hex, application: Address = "0xc0ffee0000000000000000000000000000000003"): LogSpec => ({
    contract: "router",
    event: "RouteDelivered",
    args: { routeId, application, responseHash: h32("ack") },
  }),
  stopped: (routeId: Hex, hopIndex: number, status: number, reason: number): LogSpec => ({
    contract: "router",
    event: "RouteStopped",
    args: { routeId, hopIndex, status, reason },
  }),
  receiptSent: (receiptId: Hex, routeId: Hex, status: number, reason = 0): LogSpec => ({
    contract: "router",
    event: "ReceiptSent",
    args: { receiptId, routeId, status, reason },
  }),
  hopResponse: (routeId: Hex, status: number): LogSpec => ({
    contract: "router",
    event: "HopResponse",
    args: { routeId, channelId: h32("AB"), messageId: 1n, status },
  }),
  notice: (routeId: Hex, recipient: string, recipientKey: Hex, caseId: Hex): LogSpec => ({
    contract: "router",
    event: "QuarantineNotice",
    args: { recipientKey, routeId, recipient, caseId, contact: "mailto:incident@provider.example" },
  }),
  settled: (routeId: Hex, status: number, reason = 0, hopIndex = 2, caseId: Hex = ZERO32, feesPaid = 30n): LogSpec => ({
    contract: "router",
    event: "RouteSettled",
    args: { routeId, status, reason, hopIndex, caseId, contact: caseId === ZERO32 ? "" : "mailto:incident@provider.example", feesPaid },
  }),
};

export const G = {
  applied: (version: number, action: number): LogSpec => ({
    contract: "registry",
    event: "DecisionApplied",
    args: { version: BigInt(version), action, digest: h32(`d${version}`), evidenceHash: h32("evidence") },
  }),
  cert: (o: { certKey: Hex; ledgerId: string; label: number; certified: boolean; effectiveFrom: number; expiry: number; emissionsUg?: number; version: number }): LogSpec => ({
    contract: "registry",
    event: "CertificationScheduled",
    args: {
      certKey: o.certKey,
      ledgerId: o.ledgerId,
      label: o.label,
      certified: o.certified,
      effectiveFrom: BigInt(o.effectiveFrom),
      expiry: BigInt(o.expiry),
      emissionsUg: BigInt(o.emissionsUg ?? 0),
      emissionsSource: o.emissionsUg ? "MiCA white paper" : "",
      version: BigInt(o.version),
      evidenceHash: h32("evidence"),
      digest: h32(`cert${o.version}`),
    },
  }),
  disabled: (kind: number, subject: Hex, lapseAt: number, renewed = false): LogSpec => ({
    contract: "registry",
    event: "RouteDisabled",
    args: { kind, subject, lapseAt: BigInt(lapseAt), renewed, reason: "verifier bug", evidenceHash: h32("evidence"), digest: h32(`dis${lapseAt}`) },
  }),
  reenable: (kind: number, subject: Hex, reenableAt: number): LogSpec => ({
    contract: "registry",
    event: "RouteReenableScheduled",
    args: { kind, subject, reenableAt: BigInt(reenableAt), evidenceHash: h32("evidence"), digest: h32(`en${reenableAt}`) },
  }),
  listed: (accountKey: Hex, caip10: string, caseId: Hex, lapseAt: number, renewed = false): LogSpec => ({
    contract: "registry",
    event: "AccountBlacklisted",
    args: { accountKey, caip10, caseId, lapseAt: BigInt(lapseAt), renewed, reason: "exploit", evidenceHash: h32("evidence"), digest: h32(`bl${lapseAt}`) },
  }),
  delisted: (accountKey: Hex, caip10: string, caseId: Hex, applied = true): LogSpec => ({
    contract: "registry",
    event: "AccountDelisted",
    args: { accountKey, caip10, caseId, applied, evidenceHash: h32("evidence"), digest: h32("delist") },
  }),
  committee: (epoch: number, members: Address[], threshold: number): LogSpec => ({
    contract: "registry",
    event: "CommitteeChanged",
    args: { epoch: BigInt(epoch), members, threshold, evidenceHash: h32("evidence"), digest: h32(`c${epoch}`) },
  }),
  contact: (contact: string): LogSpec => ({
    contract: "registry",
    event: "ContactChanged",
    args: { contact, evidenceHash: h32("evidence"), digest: h32(contact) },
  }),
};

export const V = {
  deposited: (depositId: number, routeId: Hex, caseId: Hex, amount: bigint): LogSpec => ({
    contract: "vault",
    event: "Deposited",
    args: {
      depositId: BigInt(depositId),
      routeId,
      caseId,
      depositor: ROUTER,
      sender: "0xa11ce00000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000000",
      amount,
    },
  }),
  released: (depositId: number, caseId: Hex, to: Address, kind: number): LogSpec => ({
    contract: "vault",
    event: "Released",
    args: { depositId: BigInt(depositId), caseId, to, kind, amount: 1n, evidenceHash: h32("evidence"), digest: h32("rel") },
  }),
};
