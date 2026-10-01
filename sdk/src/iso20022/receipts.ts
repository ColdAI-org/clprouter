/**
 * Router receipts ↔ pacs.002 (spec "ISO 20022 filter" → status codes, "Failure handling", and the blacklist
 * `QUARANTINED` receipt in "The provider's role").
 *
 * | Router event / receipt | pacs.002 `TxSts` | `StsRsnInf/Rsn/Cd` |
 * | --- | --- | --- |
 * | `RouteForwarded` at hop i (per hop) | ACSP | — (AddtlInf names the hop) |
 * | `DELIVERED` (destination) | ACCC | — |
 * | `EXPIRED` / `DEADLINE` | RJCT | AB05 |
 * | `QUARANTINED` / `BLACKLIST` | RJCT | RR04, AddtlInf = case id + provider contact |
 * | `FAILED` | RJCT | see `REJECT_REASON_CODES` |
 *
 * pacs.002 messages built here carry no personal data: the UETR, the original references, status codes, the
 * reporting ledger's CAIP-2 id, and for quarantine the case id and the provider's (institutional) contact.
 */
import type { Hex } from "viem";
import { bytesToHex, hexToBytes, isHex } from "viem";
import type { RouteHop } from "../envelope.js";
import { ProtoWriter, fieldString, readFields } from "../proto.js";
import type { FinancialInstitution, IsoMessage, Pacs002, ReasonInfo } from "./model.js";
import { MESSAGE_DEFINITIONS } from "./model.js";
import { routeIdToUetr, uetrToRouteId } from "./uetr.js";
import { assertValidMessage, isoDateTime } from "./validate.js";

export const RECEIPT_STATUSES = ["UNSPECIFIED", "DELIVERED", "FAILED", "EXPIRED", "QUARANTINED"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** `RouteTypes.Reason` / proto `ReceiptReason`, in enum order. */
export const RECEIPT_REASONS = [
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
] as const;
export type ReceiptReason = (typeof RECEIPT_REASONS)[number];

/**
 * ExternalStatusReason1Code for each Router reason when a route is rejected.
 *
 * - AB05 TimeoutCreditorAgent: the route deadline passed (the spec's expiry code).
 * - AB07 OfflineAgent: the provider disabled the edge, ledger or Router version, or the inbound edge.
 * - AB09 ErrorCreditorAgent: the destination application rejected the delivery.
 * - AB10 ErrorInstructedAgent: the next hop could not be sent or failed.
 * - AGNT IncorrectAgent: the next ledger is not eligible under the route's filters (not ISO 20022 certified).
 * - AM04 InsufficientFunds: the fee budget ran out.
 * - FF02 SyntaxError: the envelope or route is malformed.
 * - RR04 RegulatoryReason: blacklist quarantine (and screening hits).
 * - NARR: a failure with no specific reason.
 */
export const REJECT_REASON_CODES: Record<ReceiptReason, string> = {
  NONE: "NARR",
  APPLICATION_ERROR: "AB09",
  DEADLINE: "AB05",
  DISABLED_EDGE: "AB07",
  DISABLED_LEDGER: "AB07",
  DISABLED_ROUTER: "AB07",
  DISABLED_INBOUND: "AB07",
  FILTER: "AGNT",
  FEE_BUDGET: "AM04",
  BLACKLIST: "RR04",
  NEXT_HOP_ERROR: "AB10",
  SEND_FAILED: "AB10",
  BAD_ROUTE: "FF02",
};

/** proto `ClprRouteReceipt`: the payload of a `receipt` envelope travelling back to the origin. */
export interface RouteReceipt {
  route_id: Hex;
  status: ReceiptStatus;
  hop_index: number;
  ledger_id: string;
  reason: ReceiptReason;
  /** 32 bytes, or `0x`. */
  case_id: Hex;
  contact: string;
  /** 32 bytes, or `0x`. */
  response_hash: Hex;
  route_hops: RouteHop[];
}

function hopWriter(h: RouteHop): ProtoWriter {
  return new ProtoWriter().string(1, h.ledger_id).bytes(2, h.router).bytes(3, h.channel_id).bytes(4, h.connector_id).uint(5, h.fee).bytes(6, h.fee_payee);
}

export function encodeRouteReceipt(r: RouteReceipt): Hex {
  const w = new ProtoWriter()
    .bytes(1, r.route_id)
    .uint(2, RECEIPT_STATUSES.indexOf(r.status))
    .uint(3, r.hop_index)
    .string(4, r.ledger_id)
    .uint(5, RECEIPT_REASONS.indexOf(r.reason))
    .bytes(6, r.case_id)
    .string(7, r.contact)
    .bytes(8, r.response_hash);
  for (const h of r.route_hops) w.element(9, hopWriter(h));
  return w.hex();
}

export function decodeRouteReceipt(data: Hex | Uint8Array): RouteReceipt {
  const bytes = typeof data === "string" ? (isHex(data) ? hexToBytes(data) : null) : data;
  if (!bytes) throw new Error("receipt: not hex");
  const r: RouteReceipt = {
    route_id: "0x",
    status: "UNSPECIFIED",
    hop_index: 0,
    ledger_id: "",
    reason: "NONE",
    case_id: "0x",
    contact: "",
    response_hash: "0x",
    route_hops: [],
  };
  for (const f of readFields(bytes)) {
    const b = f.bytes;
    switch (f.field) {
      case 1: if (b) r.route_id = bytesToHex(b); break;
      case 2: r.status = RECEIPT_STATUSES[Number(f.int ?? 0n)] ?? "UNSPECIFIED"; break;
      case 3: r.hop_index = Number(f.int ?? 0n); break;
      case 4: r.ledger_id = fieldString(f); break;
      case 5: r.reason = RECEIPT_REASONS[Number(f.int ?? 0n)] ?? "NONE"; break;
      case 6: if (b) r.case_id = bytesToHex(b); break;
      case 7: r.contact = fieldString(f); break;
      case 8: if (b) r.response_hash = bytesToHex(b); break;
      case 9: {
        if (!b) break;
        const h: RouteHop = { ledger_id: "", router: "0x", channel_id: "0x", connector_id: "0x", fee: 0n, fee_payee: "0x" };
        for (const x of readFields(b)) {
          if (x.field === 1) h.ledger_id = fieldString(x);
          else if (x.field === 2) h.router = bytesToHex(x.bytes!);
          else if (x.field === 3) h.channel_id = bytesToHex(x.bytes!);
          else if (x.field === 4) h.connector_id = bytesToHex(x.bytes!);
          else if (x.field === 5) h.fee = x.int!;
          else if (x.field === 6) h.fee_payee = bytesToHex(x.bytes!);
        }
        r.route_hops.push(h);
        break;
      }
    }
  }
  return r;
}

// ── pacs.002 builders ───────────────────────────────────────────────────────

/** The original payment a status report refers to. */
export interface PaymentReference {
  uetr: string;
  messageId: string;
  messageNameId: string;
  creationDateTime?: string;
  instructionId?: string;
  endToEndId?: string;
  transactionId?: string;
}

export function paymentReference(m: Extract<IsoMessage, { kind: "pacs.008" | "pacs.009" }>): PaymentReference {
  const ref: PaymentReference = {
    uetr: m.tx.paymentId.uetr,
    messageId: m.groupHeader.messageId,
    messageNameId: MESSAGE_DEFINITIONS[m.kind],
    creationDateTime: m.groupHeader.creationDateTime,
    endToEndId: m.tx.paymentId.endToEndId,
  };
  if (m.tx.paymentId.instructionId) ref.instructionId = m.tx.paymentId.instructionId;
  if (m.tx.paymentId.transactionId) ref.transactionId = m.tx.paymentId.transactionId;
  return ref;
}

export interface StatusReportOptions {
  /** pacs.002 `GrpHdr/MsgId`. */
  messageId: string;
  creationDateTime?: Date;
  /** Agent reporting the status (BIC required by CBPR+ when present). */
  instructingAgent?: FinancialInstitution;
  instructedAgent?: FinancialInstitution;
}

function report(ref: PaymentReference, status: Pacs002["tx"]["status"], reasons: ReasonInfo[] | undefined, o: StatusReportOptions): Pacs002 {
  const at = isoDateTime(o.creationDateTime ?? new Date());
  const tx: Pacs002["tx"] = {
    originalGroupInfo: { messageId: ref.messageId, messageNameId: ref.messageNameId, ...(ref.creationDateTime ? { creationDateTime: ref.creationDateTime } : {}) },
    originalUetr: ref.uetr,
    status,
  };
  if (ref.instructionId) tx.originalInstructionId = ref.instructionId;
  if (ref.endToEndId) tx.originalEndToEndId = ref.endToEndId;
  if (ref.transactionId) tx.originalTxId = ref.transactionId;
  if (reasons?.length) tx.statusReasons = reasons;
  if (status === "ACSP" || status === "ACCC") tx.acceptanceDateTime = at;
  if (o.instructingAgent) tx.instructingAgent = o.instructingAgent;
  if (o.instructedAgent) tx.instructedAgent = o.instructedAgent;
  const m: Pacs002 = { kind: "pacs.002", groupHeader: { messageId: o.messageId, creationDateTime: at }, tx };
  assertValidMessage(m);
  return m;
}

/** Split a line into ≤105-character `AddtlInf` chunks. */
function chunks(s: string, n = 105): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** ACSP for one hop: the Router on `ledgerId` accepted the payment and forwarded it (`RouteForwarded`). */
export function hopAcceptedStatus(ref: PaymentReference, hop: { hopIndex: number; ledgerId: string }, o: StatusReportOptions): Pacs002 {
  // ACSP needs no reason; the proprietary reason carries which hop reported, so the sender can follow the route.
  return report(ref, "ACSP", [{ proprietary: "CLPR/FORWARDED", additionalInfo: [`HOP/${hop.hopIndex}/${hop.ledgerId}`.slice(0, 105)] }], o);
}

/**
 * pacs.002 for a Router receipt: ACCC on delivery, RJCT with a reason code otherwise. A `QUARANTINED` receipt gives
 * RJCT / RR04 with the case id and the provider's contact address in `AddtlInf`, and says only that the transfer is
 * held and whom to contact.
 */
export function receiptToPacs002(receipt: RouteReceipt, ref: PaymentReference, o: StatusReportOptions): Pacs002 {
  if (routeIdToUetr(receipt.route_id) !== ref.uetr) throw new Error("receipt route_id is not the payment's UETR");
  switch (receipt.status) {
    case "DELIVERED":
      return report(ref, "ACCC", undefined, o);
    case "EXPIRED":
      return report(ref, "RJCT", [{ code: "AB05", additionalInfo: [`CLPR/DEADLINE/HOP/${receipt.hop_index}/${receipt.ledger_id}`.slice(0, 105)] }], o);
    case "QUARANTINED": {
      if (!/^0x[0-9a-f]{64}$/i.test(receipt.case_id)) throw new Error("QUARANTINED receipt needs a 32-byte case id");
      if (!receipt.contact) throw new Error("QUARANTINED receipt needs the provider contact address");
      // CBPR+ allows two AddtlInf lines: the case id, then the contact (a URL or address that fits in 105 chars).
      const contact = chunks(`CONTACT/${receipt.contact}`);
      if (contact.length > 1) throw new Error("provider contact is longer than 97 characters");
      return report(ref, "RJCT", [{ code: "RR04", additionalInfo: [`CASE/${receipt.case_id.toLowerCase()}`, contact[0]!] }], o);
    }
    case "FAILED": {
      const code = REJECT_REASON_CODES[receipt.reason];
      return report(ref, "RJCT", [{ code, additionalInfo: [`CLPR/${receipt.reason}/HOP/${receipt.hop_index}/${receipt.ledger_id}`.slice(0, 105)] }], o);
    }
    default:
      throw new Error(`receipt status ${receipt.status} has no pacs.002 mapping`);
  }
}

export interface Pacs002Outcome {
  uetr: string;
  status: "IN_PROGRESS" | "DELIVERED" | "FAILED" | "EXPIRED" | "QUARANTINED";
  reasonCode?: string;
  hop?: { hopIndex: number; ledgerId: string };
  caseId?: Hex;
  contact?: string;
}

/** Read a pacs.002 back into a Router outcome (the inverse of `receiptToPacs002` / `hopAcceptedStatus`). */
export function pacs002Outcome(p: Pacs002): Pacs002Outcome {
  const out: Pacs002Outcome = { uetr: p.tx.originalUetr, status: "IN_PROGRESS" };
  const r = p.tx.statusReasons?.[0];
  const lines = r?.additionalInfo ?? [];
  const hop = lines.map((l) => /(?:^|\/)HOP\/(\d+)\/(.+)$/.exec(l)).find((m) => m);
  if (hop) out.hop = { hopIndex: Number(hop[1]), ledgerId: hop[2]! };
  switch (p.tx.status) {
    case "ACSP":
    case "ACTC":
    case "ACCP":
    case "PDNG":
    case "RCVD":
      return out;
    case "ACCC":
    case "ACSC":
      return { ...out, status: "DELIVERED" };
    case "RJCT": {
      out.reasonCode = r?.code ?? r?.proprietary;
      if (r?.code === "RR04") {
        const caseLine = lines.find((l) => l.startsWith("CASE/"));
        const contactLine = lines.find((l) => l.startsWith("CONTACT/"));
        if (caseLine) out.caseId = caseLine.slice(5) as Hex;
        if (contactLine) out.contact = contactLine.slice(8);
        return { ...out, status: "QUARANTINED" };
      }
      return { ...out, status: r?.code === "AB05" ? "EXPIRED" : "FAILED" };
    }
    default:
      return { ...out, status: "FAILED" };
  }
}

/** Helper for tests and tooling: a receipt for a route id (the UETR), with defaults for the unset fields. */
export function makeReceipt(uetr: string, r: Partial<Omit<RouteReceipt, "route_id">>): RouteReceipt {
  return {
    route_id: uetrToRouteId(uetr),
    status: "UNSPECIFIED",
    hop_index: 0,
    ledger_id: "",
    reason: "NONE",
    case_id: "0x",
    contact: "",
    response_hash: "0x",
    route_hops: [],
    ...r,
  };
}
