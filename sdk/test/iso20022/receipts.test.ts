import { describe, expect, it } from "vitest";
import {
  RECEIPT_REASONS,
  REJECT_REASON_CODES,
  cancellationRequest,
  decodeRouteReceipt,
  encodeRouteReceipt,
  fromXml,
  hopAcceptedStatus,
  makeReceipt,
  pacs002Outcome,
  paymentReference,
  quarantineReturn,
  receiptToPacs002,
  resolveCancellation,
  returnPayment,
  toXml,
  uetrToRouteId,
} from "../../src/iso20022/index.js";
import { CREDITOR_AGENT, DEBTOR_AGENT, HIERO_AGENT, PII, UETR, UETR_009, pacs008, pacs009 } from "./fixtures.js";

const AT = new Date("2026-10-01T09:31:00Z");
const ref = paymentReference(pacs008());
const opts = { messageId: "STS-1", creationDateTime: AT };
const CASE = `0x${"c4".repeat(32)}` as const;
const CONTACT = "https://provider.example/clprouter/cases";

describe("ClprRouteReceipt codec", () => {
  it("round trips, including the route hops", () => {
    const r = makeReceipt(UETR, {
      status: "QUARANTINED",
      hop_index: 1,
      ledger_id: "hedera:mainnet",
      reason: "BLACKLIST",
      case_id: CASE,
      contact: CONTACT,
      route_hops: [
        { ledger_id: "stellar:pubnet", router: "0x", channel_id: `0x${"11".repeat(32)}`, connector_id: `0x${"22".repeat(32)}`, fee: 5n, fee_payee: "0x" },
        { ledger_id: "hedera:mainnet", router: "0x", channel_id: "0x", connector_id: "0x", fee: 0n, fee_payee: "0x" },
      ],
    });
    expect(decodeRouteReceipt(encodeRouteReceipt(r))).toEqual(r);
  });
});

describe("receipts → pacs.002", () => {
  it("ACSP per hop, naming the hop", () => {
    const p = hopAcceptedStatus(ref, { hopIndex: 1, ledgerId: "hedera:mainnet" }, opts);
    expect(p.tx).toMatchObject({ status: "ACSP", originalUetr: UETR, originalEndToEndId: "E2E-INV-4711", acceptanceDateTime: "2026-10-01T09:31:00.000Z" });
    expect(p.tx.originalGroupInfo).toEqual({ messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08", creationDateTime: "2026-10-01T09:30:00.000Z" });
    expect(fromXml(toXml(p))).toEqual(p);
    expect(pacs002Outcome(p)).toEqual({ uetr: UETR, status: "IN_PROGRESS", hop: { hopIndex: 1, ledgerId: "hedera:mainnet" } });
  });

  it("ACCC at the destination", () => {
    const p = receiptToPacs002(makeReceipt(UETR, { status: "DELIVERED", hop_index: 2, ledger_id: "test:b" }), ref, opts);
    expect(p.tx.status).toBe("ACCC");
    expect(p.tx.statusReasons).toBeUndefined();
    expect(pacs002Outcome(fromXml(toXml(p), "pacs.002")).status).toBe("DELIVERED");
  });

  it("QUARANTINED → RJCT / RR04 with case id and provider contact in AddtlInf", () => {
    const r = makeReceipt(UETR, { status: "QUARANTINED", reason: "BLACKLIST", hop_index: 1, ledger_id: "hedera:mainnet", case_id: CASE, contact: CONTACT });
    const p = receiptToPacs002(r, ref, opts);
    expect(p.tx.status).toBe("RJCT");
    expect(p.tx.statusReasons).toEqual([{ code: "RR04", additionalInfo: [`CASE/${CASE}`, `CONTACT/${CONTACT}`] }]);
    const xml = toXml(p);
    expect(xml).toContain("<Cd>RR04</Cd>");
    expect(xml).toContain(`<AddtlInf>CASE/${CASE}</AddtlInf>`);
    expect(xml).toContain(`<AddtlInf>CONTACT/${CONTACT}</AddtlInf>`);
    // No accusation and no personal data: only the case, the contact and references.
    for (const s of Object.values(PII)) expect(xml).not.toContain(s);
    expect(pacs002Outcome(fromXml(xml, "pacs.002"))).toMatchObject({ status: "QUARANTINED", reasonCode: "RR04", caseId: CASE, contact: CONTACT });
  });

  it("quarantine needs a case id and a contact", () => {
    expect(() => receiptToPacs002(makeReceipt(UETR, { status: "QUARANTINED", contact: CONTACT }), ref, opts)).toThrow(/case id/);
    expect(() => receiptToPacs002(makeReceipt(UETR, { status: "QUARANTINED", case_id: CASE }), ref, opts)).toThrow(/contact/);
    expect(() => receiptToPacs002(makeReceipt(UETR, { status: "QUARANTINED", case_id: CASE, contact: `https://${"x".repeat(100)}` }), ref, opts)).toThrow(/longer/);
  });

  it("EXPIRED → RJCT / AB05", () => {
    const p = receiptToPacs002(makeReceipt(UETR, { status: "EXPIRED", reason: "DEADLINE", hop_index: 1, ledger_id: "hedera:mainnet" }), ref, opts);
    expect(p.tx.statusReasons?.[0]?.code).toBe("AB05");
    expect(pacs002Outcome(p).status).toBe("EXPIRED");
  });

  it.each(RECEIPT_REASONS.filter((r) => r !== "BLACKLIST" && r !== "DEADLINE"))("FAILED / %s → RJCT with an ISO reason code", (reason) => {
    const p = receiptToPacs002(makeReceipt(UETR, { status: "FAILED", reason, hop_index: 1, ledger_id: "hedera:mainnet" }), ref, opts);
    expect(p.tx.status).toBe("RJCT");
    expect(p.tx.statusReasons?.[0]?.code).toBe(REJECT_REASON_CODES[reason]);
    expect(p.tx.statusReasons?.[0]?.additionalInfo).toEqual([`CLPR/${reason}/HOP/1/hedera:mainnet`]);
    expect(fromXml(toXml(p))).toEqual(p);
    expect(pacs002Outcome(p)).toMatchObject({ status: "FAILED", reasonCode: REJECT_REASON_CODES[reason], hop: { hopIndex: 1 } });
  });

  it("refuses a receipt for another route and UNSPECIFIED receipts", () => {
    expect(() => receiptToPacs002(makeReceipt(UETR_009, { status: "DELIVERED" }), ref, opts)).toThrow(/UETR/);
    expect(() => receiptToPacs002(makeReceipt(UETR, {}), ref, opts)).toThrow(/no pacs.002 mapping/);
  });

  it("works for pacs.009 and with reporting agents", () => {
    const r = paymentReference(pacs009());
    expect(r.messageNameId).toBe("pacs.009.001.08");
    const p = receiptToPacs002({ ...makeReceipt(UETR_009, { status: "DELIVERED" }), route_id: uetrToRouteId(UETR_009) }, r, {
      ...opts,
      instructingAgent: HIERO_AGENT,
      instructedAgent: DEBTOR_AGENT,
    });
    expect(fromXml(toXml(p))).toEqual(p);
  });
});

describe("cancellation and return flows", () => {
  const original = pacs008();
  const req = cancellationRequest(original, { assignmentId: "ASSGN-1", caseId: "CASE-1", reason: "DUPL", creationDateTime: AT });

  it("camt.056 refers to the original payment by UETR, references and amount", () => {
    expect(req.assignment.assigner).toEqual(original.tx.instructingAgent);
    expect(req.assignment.assignee).toEqual(original.tx.instructedAgent);
    expect(req.tx).toMatchObject({
      originalUetr: UETR,
      originalEndToEndId: "E2E-INV-4711",
      originalInstructionId: "INSTR-1",
      originalTxId: "TX-1",
      originalInterbankSettlementAmount: { value: "1250.00", currency: "EUR" },
      reason: { code: "DUPL" },
      case: { id: "CASE-1" },
    });
    expect(fromXml(toXml(req))).toEqual(req);
  });

  it("accepted: pacs.004 (FOCR) back along the reverse chain, then camt.029 CNCL", () => {
    const ret = returnPayment(original, { messageId: "RTR-1", reason: "FOCR", cancellation: req, creationDateTime: AT });
    expect(ret.tx.instructingAgent).toEqual(original.tx.instructedAgent);
    expect(ret.tx.instructedAgent).toEqual(original.tx.instructingAgent);
    expect(ret.tx.returnChain.debtor.party?.name).toBe(PII.creditorName);
    expect(ret.tx.returnChain.creditor.party?.name).toBe(PII.debtorName);
    expect(ret.tx.returnChain.debtorAgent).toEqual(CREDITOR_AGENT);
    expect(ret.tx.returnedInterbankSettlementAmount).toEqual({ value: "1250.00", currency: "EUR" });
    expect(ret.tx.interbankSettlementDate).toBe("2026-10-01");
    expect(fromXml(toXml(ret))).toEqual(ret);

    const res = resolveCancellation(req, { assignmentId: "ASSGN-2", accepted: true, creationDateTime: AT });
    expect(res).toMatchObject({ confirmation: "CNCL", tx: { cancellationStatus: "ACCR", originalUetr: UETR } });
    expect(res.assignment.assigner).toEqual(req.assignment.assignee);
    expect(fromXml(toXml(res))).toEqual(res);
  });

  it("refused: camt.029 RJCR with a reason", () => {
    const res = resolveCancellation(req, { assignmentId: "ASSGN-3", accepted: false, rejectionReason: "NOAS", creationDateTime: AT });
    expect(res).toMatchObject({ confirmation: "RJCR", tx: { cancellationStatus: "RJCR", reason: { code: "NOAS" } } });
    expect(fromXml(toXml(res))).toEqual(res);
    expect(() => resolveCancellation(req, { assignmentId: "X", accepted: false })).toThrow(/rejection reason/);
  });

  it("guards the return against the wrong payment, reason or amount", () => {
    expect(() => returnPayment(original, { messageId: "R", reason: "AC04", cancellation: req })).toThrow(/FOCR/);
    const other = cancellationRequest(pacs009(), { assignmentId: "A", caseId: "C", reason: "DUPL" });
    expect(() => returnPayment(original, { messageId: "R", reason: "FOCR", cancellation: other })).toThrow(/different payment/);
    expect(() => returnPayment(original, { messageId: "R", reason: "AC04", returnedAmount: { value: "5000.00", currency: "EUR" } })).toThrow(/exceeds/);
    expect(() => cancellationRequest(original, { assignmentId: "A", caseId: "C", reason: "WHIM" as never })).toThrow(/CxlRsnInf/);
  });

  it("pacs.009 returns use the agent form of the return chain", () => {
    const ret = returnPayment(pacs009(), { messageId: "RTR-9", reason: "AC04", creationDateTime: AT });
    expect(ret.tx.returnChain.debtor.agent?.bicfi).toBe("CLPRGB2LTRS");
    expect(fromXml(toXml(ret))).toEqual(ret);
  });

  it("quarantine release to the sender: pacs.004 RR04 with the case id", () => {
    const ret = quarantineReturn(original, { messageId: "RTR-Q", caseId: CASE, creationDateTime: AT });
    expect(ret.tx.reason).toEqual({ code: "RR04", additionalInfo: [`CASE/${CASE}`] });
    expect(fromXml(toXml(ret))).toEqual(ret);
    expect(() => quarantineReturn(original, { messageId: "R", caseId: "0x12" })).toThrow(/32 bytes/);
  });
});
