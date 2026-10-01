import type { Abi, Address, Hex, Log } from "viem";
import { decodeEventLog } from "viem";
import { REGISTRY_ABI, ROUTER_ABI, VAULT_ABI } from "./abi.js";

export type ContractKind = "router" | "registry" | "vault";

/** JSON-safe argument values (bigints become decimal strings). */
export type ArgValue = string | number | boolean | null | ArgValue[] | { [k: string]: ArgValue };

/** A decoded, confirmed contract event as stored by the indexer. */
export interface IndexedEvent {
  ledger: string;
  contract: ContractKind;
  address: Address;
  name: string;
  blockNumber: number;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  /** Route (or receipt) id the event is about, if any. Router-derived, unique per origin Router. */
  routeId?: Hex;
  caseId?: Hex;
  /** Blacklist account key (`keccak256("account" ‖ lower(caip10))`). */
  accountKey?: Hex;
  args: Record<string, ArgValue>;
}

// ── Enum names (values equal the Solidity enum order) ─────────────────────

export const ROUTE_STATUS = ["NONE", "PENDING", "DELIVERED", "FAILED", "EXPIRED", "QUARANTINED"] as const;
export const RECEIPT_STATUS = ["UNSPECIFIED", "DELIVERED", "FAILED", "EXPIRED", "QUARANTINED"] as const;
export const REASON = [
  "NONE",
  "APPLICATION_ERROR",
  "DEADLINE",
  "DISABLED_EDGE",
  "DISABLED_LEDGER",
  "DISABLED_ROUTER",
  "DISABLED_INBOUND",
  "FILTER",
  "FEE_BUDGET",
  "BLACKLIST",
  "NEXT_HOP_ERROR",
  "SEND_FAILED",
  "BAD_ROUTE",
  "TRUST_FLOOR",
] as const;
export const ACTION = [
  "NONE",
  "CERTIFY",
  "UNCERTIFY",
  "DISABLE",
  "ENABLE",
  "BLACKLIST",
  "DELIST",
  "COMMITTEE",
  "CONTACT",
  "VAULT_RELEASE",
  "VAULT_NAME_RECOVERY",
  "TRUST_TIER",
] as const;
export const LABEL: Record<number, "ISO20022" | "MICA" | "ENERGY"> = { 1: "ISO20022", 2: "MICA", 3: "ENERGY" };
export const TARGET: Record<number, "EDGE" | "LEDGER" | "ROUTER" | "ROUTER_VERSION"> = {
  1: "EDGE",
  2: "LEDGER",
  3: "ROUTER",
  4: "ROUTER_VERSION",
};
export const BENEFICIARY = ["SENDER", "RECIPIENT", "RECOVERY"] as const;
/** CLPR `ReplyStatus` (ClprTypes.sol). */
export const CLPR_REPLY = [
  "SUCCESS",
  "APPLICATION_ERROR",
  "CONNECTOR_NOT_FOUND",
  "CONNECTOR_UNDERFUNDED",
  "REDACTED",
  "CHANNEL_CLOSED",
  "NOT_HANDLED",
] as const;

const ABIS: Record<ContractKind, Abi> = { router: ROUTER_ABI, registry: REGISTRY_ABI, vault: VAULT_ABI };

function jsonSafe(v: unknown): ArgValue {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o: Record<string, ArgValue> = {};
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x);
    return o;
  }
  return (v ?? null) as ArgValue;
}

function enumName(names: readonly string[], v: unknown): string {
  const n = Number(v);
  return names[n] ?? `UNKNOWN_${n}`;
}

/**
 * Decode one raw log from a watched contract. Returns undefined for logs that are not CLPRouter events (for
 * example events the ABI does not know). `timestamp` is the block's timestamp.
 */
export function decodeLog(
  ledger: string,
  contract: ContractKind,
  log: Pick<Log, "address" | "topics" | "data" | "blockNumber" | "blockHash" | "transactionHash" | "logIndex">,
  timestamp: number,
): IndexedEvent | undefined {
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: ABIS[contract], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }) as {
      eventName: string;
      args: unknown;
    };
  } catch {
    return undefined;
  }
  const raw = (decoded.args ?? {}) as Record<string, unknown>;
  const args = jsonSafe(raw) as Record<string, ArgValue>;
  const ev: IndexedEvent = {
    ledger,
    contract,
    address: log.address,
    name: decoded.eventName,
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash as Hex,
    txHash: log.transactionHash as Hex,
    logIndex: Number(log.logIndex),
    timestamp,
    args,
  };

  if (typeof raw.routeId === "string") ev.routeId = raw.routeId as Hex;
  if (typeof raw.caseId === "string" && raw.caseId !== `0x${"0".repeat(64)}`) ev.caseId = raw.caseId as Hex;

  // Readable enum names next to the raw numbers.
  switch (ev.name) {
    case "RouteSettled":
      args.statusName = enumName(ROUTE_STATUS, raw.status);
      args.reasonName = enumName(REASON, raw.reason);
      break;
    case "RouteStopped":
    case "ReceiptSent":
      args.statusName = enumName(RECEIPT_STATUS, raw.status);
      args.reasonName = enumName(REASON, raw.reason);
      break;
    case "LateReceipt":
      args.statusName = enumName(RECEIPT_STATUS, raw.status);
      break;
    case "DecisionApplied":
      args.actionName = enumName(ACTION, raw.action);
      break;
    case "CertificationScheduled":
      args.labelName = LABEL[Number(raw.label)] ?? `UNKNOWN_${String(raw.label)}`;
      break;
    case "RouteDisabled":
    case "RouteReenableScheduled":
      args.kindName = TARGET[Number(raw.kind)] ?? `UNKNOWN_${String(raw.kind)}`;
      break;
    case "AccountBlacklisted":
    case "AccountDelisted":
      ev.accountKey = raw.accountKey as Hex;
      break;
    case "QuarantineNotice":
      ev.accountKey = raw.recipientKey as Hex;
      break;
    case "HopResponse":
      args.statusName = enumName(CLPR_REPLY, raw.status);
      break;
    case "ForwardRejected":
      // 0 here means the local `sendMessage` failed (no CLPR Response was involved).
      args.statusName = Number(raw.clprStatus) === 0 ? "SEND_FAILED" : enumName(CLPR_REPLY, raw.clprStatus);
      args.reasonName = enumName(REASON, raw.reason);
      break;
    case "Released":
      args.kindName = enumName(BENEFICIARY, raw.kind);
      break;
  }
  return ev;
}

/** Stable identity of an event (ledger, tx, log index). */
export function eventKey(e: Pick<IndexedEvent, "ledger" | "txHash" | "logIndex">): string {
  return `${e.ledger}:${e.txHash}:${e.logIndex}`;
}

/** Canonical order of events on one ledger. */
export function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}
