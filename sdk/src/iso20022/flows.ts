/**
 * Cancellation and return flows (spec "ISO 20022 filter": camt.056, pacs.004, camt.029).
 *
 * How they meet the Router:
 *
 * - **Before settlement** (the route is still in flight or rejected): the Router itself refunds the origin escrow on a
 *   failure or expiry receipt (spec "Failure handling"), so no pacs.004 is needed; the pacs.002 RJCT is the answer.
 * - **After settlement** (ACCC): the debtor agent sends a camt.056 to the creditor agent as a new ISO 20022 route. The
 *   creditor agent answers with a camt.029 (`RJCR` to refuse) or returns the funds with a pacs.004 (`FOCR`) plus a
 *   camt.029 (`CNCL`). Each follow-up is its own route with a fresh UETR as `route_id` and the payment's UETR as
 *   `original_uetr` in the envelope header, because Routers never accept a route id twice.
 * - **Quarantine release** to the original sender: the provider's vault release is reported to the debtor agent as a
 *   pacs.004 with reason RR04 and the case id, so the sender's books close against the same UETR.
 */
import type { CancellationReason, CancellationRejection, ChargeBearer, ReturnReason, SettlementMethod } from "./codes.js";
import type { Amount, Camt029, Camt056, FinancialInstitution, Pacs004, Pacs008, Pacs009, PartyOrAgent } from "./model.js";
import { MESSAGE_DEFINITIONS } from "./model.js";
import { assertValidMessage, isoDate, isoDateTime } from "./validate.js";

type Payment = Pacs008 | Pacs009;

function originalRefs(p: Payment) {
  const id = p.tx.paymentId;
  return {
    originalGroupInfo: { messageId: p.groupHeader.messageId, messageNameId: MESSAGE_DEFINITIONS[p.kind], creationDateTime: p.groupHeader.creationDateTime },
    ...(id.instructionId ? { originalInstructionId: id.instructionId } : {}),
    originalEndToEndId: id.endToEndId,
    ...(id.transactionId ? { originalTxId: id.transactionId } : {}),
    originalUetr: id.uetr,
  };
}

export interface CancellationRequestOptions {
  assignmentId: string;
  caseId: string;
  reason: CancellationReason;
  additionalInfo?: string[];
  /** Defaults: the original instructing agent asks the original instructed agent; the assigner opens the case. */
  assigner?: FinancialInstitution;
  assignee?: FinancialInstitution;
  cancellationId?: string;
  creationDateTime?: Date;
}

/** camt.056 asking the creditor side to cancel (and return) a settled payment. */
export function cancellationRequest(original: Payment, o: CancellationRequestOptions): Camt056 {
  const assigner = o.assigner ?? original.tx.instructingAgent;
  const m: Camt056 = {
    kind: "camt.056",
    assignment: {
      id: o.assignmentId,
      assigner,
      assignee: o.assignee ?? original.tx.instructedAgent,
      creationDateTime: isoDateTime(o.creationDateTime ?? new Date()),
    },
    tx: {
      ...(o.cancellationId ? { cancellationId: o.cancellationId } : {}),
      case: { id: o.caseId, creator: assigner },
      ...originalRefs(original),
      originalInterbankSettlementAmount: { ...original.tx.interbankSettlementAmount },
      originalInterbankSettlementDate: original.tx.interbankSettlementDate,
      reason: { code: o.reason, ...(o.additionalInfo?.length ? { additionalInfo: o.additionalInfo } : {}) },
    },
  };
  assertValidMessage(m);
  return m;
}

export interface ResolutionOptions {
  assignmentId: string;
  accepted: boolean;
  /** Required when `accepted` is false. */
  rejectionReason?: CancellationRejection;
  additionalInfo?: string[];
  cancellationStatusId?: string;
  creationDateTime?: Date;
}

/** camt.029 answering a camt.056: `CNCL` / `ACCR` when accepted, `RJCR` with a reason when refused. */
export function resolveCancellation(request: Camt056, o: ResolutionOptions): Camt029 {
  if (!o.accepted && !o.rejectionReason) throw new Error("a refused cancellation needs a rejection reason");
  const t = request.tx;
  const m: Camt029 = {
    kind: "camt.029",
    assignment: {
      id: o.assignmentId,
      assigner: request.assignment.assignee,
      assignee: request.assignment.assigner,
      creationDateTime: isoDateTime(o.creationDateTime ?? new Date()),
    },
    resolvedCase: t.case,
    confirmation: o.accepted ? "CNCL" : "RJCR",
    tx: {
      ...(o.cancellationStatusId ? { cancellationStatusId: o.cancellationStatusId } : {}),
      originalGroupInfo: t.originalGroupInfo,
      ...(t.originalInstructionId ? { originalInstructionId: t.originalInstructionId } : {}),
      ...(t.originalEndToEndId ? { originalEndToEndId: t.originalEndToEndId } : {}),
      ...(t.originalTxId ? { originalTxId: t.originalTxId } : {}),
      originalUetr: t.originalUetr,
      cancellationStatus: o.accepted ? "ACCR" : "RJCR",
      ...(o.accepted
        ? {}
        : { reason: { code: o.rejectionReason!, ...(o.additionalInfo?.length ? { additionalInfo: o.additionalInfo } : {}) } }),
    },
  };
  assertValidMessage(m);
  return m;
}

export interface ReturnOptions {
  messageId: string;
  reason: ReturnReason;
  additionalInfo?: string[];
  /** When the return answers a camt.056, the reason must be FOCR and the UETRs must match. */
  cancellation?: Camt056;
  /** Defaults to the full original amount. */
  returnedAmount?: Amount;
  settlementDate?: Date;
  settlementMethod?: SettlementMethod;
  chargeBearer?: ChargeBearer;
  returnId?: string;
  creationDateTime?: Date;
}

/**
 * pacs.004 returning a settled payment. The return runs the other way: the original instructed agent instructs, and
 * the return chain swaps debtor and creditor (the original creditor pays back the original debtor).
 */
export function returnPayment(original: Payment, o: ReturnOptions): Pacs004 {
  if (o.cancellation) {
    if (o.cancellation.tx.originalUetr !== original.tx.paymentId.uetr) throw new Error("camt.056 refers to a different payment");
    if (o.reason !== "FOCR") throw new Error("a return following a cancellation request uses reason FOCR");
  }
  const t = original.tx;
  const debtor: PartyOrAgent = original.kind === "pacs.008" ? { party: original.tx.creditor } : { agent: original.tx.creditor };
  const creditor: PartyOrAgent = original.kind === "pacs.008" ? { party: original.tx.debtor } : { agent: original.tx.debtor };
  const now = o.creationDateTime ?? new Date();
  const m: Pacs004 = {
    kind: "pacs.004",
    groupHeader: { messageId: o.messageId, creationDateTime: isoDateTime(now), settlementMethod: o.settlementMethod ?? original.groupHeader.settlementMethod },
    tx: {
      ...(o.returnId ? { returnId: o.returnId } : {}),
      ...originalRefs(original),
      originalInterbankSettlementAmount: { ...t.interbankSettlementAmount },
      originalInterbankSettlementDate: t.interbankSettlementDate,
      returnedInterbankSettlementAmount: o.returnedAmount ?? { ...t.interbankSettlementAmount },
      interbankSettlementDate: isoDate(o.settlementDate ?? now),
      ...(o.chargeBearer ? { chargeBearer: o.chargeBearer } : {}),
      instructingAgent: t.instructedAgent,
      instructedAgent: t.instructingAgent,
      returnChain: {
        debtor,
        ...(t.creditorAgent ? { debtorAgent: t.creditorAgent } : {}),
        ...(t.debtorAgent ? { creditorAgent: t.debtorAgent } : {}),
        creditor,
      },
      reason: { code: o.reason, ...(o.additionalInfo?.length ? { additionalInfo: o.additionalInfo } : {}) },
    },
  };
  assertValidMessage(m);
  return m;
}

/**
 * pacs.004 for funds released from the quarantine vault back to the original sender: reason RR04 with the case id.
 * The vault releases only with a case id (spec "The quarantine vault"), so the case id is mandatory here too.
 */
export function quarantineReturn(original: Payment, o: Omit<ReturnOptions, "reason" | "cancellation" | "additionalInfo"> & { caseId: `0x${string}` }): Pacs004 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.caseId)) throw new Error("case id must be 32 bytes");
  return returnPayment(original, { ...o, reason: "RR04", additionalInfo: [`CASE/${o.caseId.toLowerCase()}`] });
}
