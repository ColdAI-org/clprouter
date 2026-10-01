import { describe, expect, it } from "vitest";
import type { RouteHop } from "../../src/index.js";
import {
  RECEIPT_REASONS,
  REJECT_REASON_CODES,
  cancellationRequest,
  decodeRouteReceipt,
  edgeDigest,
  encodeRouteReceipt,
  hopsCommitment,
  receiptCommitment,
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

/** Reference values from RouteCodec.encodeReceipt / RouteLogic.hopsCommitment (forge, same hops as below). */
const SOL = {
  c0: "0x3ee4d2b8b3fc5981c39622832606e69e02e8181fe652f9e71065db58f997cb1a",
  c2: "0xf68a86534fe1209a7f386d5b1ca41dc697e1cfcebe0f5101917ce5621d7a6dfa",
  edge1: "0x38b40e72cbe7ce753bbc493821fd4307271082e719bf9798f11d90973be6fb21",
  receipt:
    "0x0a108a562c67ca1648bab07465581be6f00110041801220e6865646572613a6d61696e6e6574280d322000000000000000000000000000000000000000000000000000000000000000c43a1868747470733a2f2f70726f76696465722e6578616d706c654a82010a0e7374656c6c61723a7075626e6574121400000000000000000000000000000000000000a11a200000000000000000000000000000000000000000000000000000000000000011222000000000000000000000000000000000000000000000000000000000000000222805321400000000000000000000000000000000000000f1522038b40e72cbe7ce753bbc493821fd4307271082e719bf9798f11d90973be6fb215a20f68a86534fe1209a7f386d5b1ca41dc697e1cfcebe0f5101917ce5621d7a6dfa",
} as const;

const b32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const HOPS: RouteHop[] = [
  { ledger_id: "stellar:pubnet", router: "0x00000000000000000000000000000000000000a1", channel_id: b32(0x11), connector_id: b32(0x22), fee: 5n, fee_payee: "0x00000000000000000000000000000000000000f1" },
  { ledger_id: "hedera:mainnet", router: "0x00000000000000000000000000000000000000a2", channel_id: b32(0x33), connector_id: b32(0x44), fee: 7n, fee_payee: "0x" },
  { ledger_id: "eip155:1", router: "0x00000000000000000000000000000000000000a3", channel_id: "0x", connector_id: "0x", fee: 0n, fee_payee: "0x" },
];

describe("ClprRouteReceipt codec and hop-list commitment", () => {
  const r = makeReceipt(UETR, {
    status: "QUARANTINED",
    hop_index: 1,
    ledger_id: "hedera:mainnet",
    reason: "TRUST_FLOOR",
    case_id: b32(0xc4),
    contact: "https://provider.example",
    route_prefix: [HOPS[0]!],
    route_edge: edgeDigest(HOPS[1]!),
    route_rest: hopsCommitment(HOPS, 2),
  });

  it("matches the Solidity commitment and receipt encoding byte for byte", () => {
    expect(hopsCommitment(HOPS)).toBe(SOL.c0);
    expect(hopsCommitment(HOPS, 2)).toBe(SOL.c2);
    expect(hopsCommitment(HOPS, 3)).toBe(b32(0));
    expect(edgeDigest(HOPS[1]!)).toBe(SOL.edge1);
    expect(encodeRouteReceipt(r)).toBe(SOL.receipt);
    expect(decodeRouteReceipt(SOL.receipt)).toEqual(r);
  });

  it("omits zero bytes32 fields like the Solidity codec and round trips", () => {
    const d = makeReceipt(UETR, { status: "DELIVERED", hop_index: 2, ledger_id: "eip155:1", route_edge: edgeDigest(HOPS[2]!), route_rest: b32(0) });
    const back = decodeRouteReceipt(encodeRouteReceipt(d));
    expect(back.route_rest).toBe("0x");
    expect(back.route_edge).toBe(d.route_edge);
    expect(back.route_prefix).toEqual([]);
  });

  it("the origin recomputes C_0 from the prefix, the reporter and the receipt", () => {
    const reporter = { ledger_id: "hedera:mainnet", application: HOPS[1]!.router };
    expect(receiptCommitment(r, reporter)).toBe(SOL.c0);
    // a forged edge, rest, reporter or prefix no longer matches
    expect(receiptCommitment({ ...r, route_edge: edgeDigest(HOPS[0]!) }, reporter)).not.toBe(SOL.c0);
    expect(receiptCommitment({ ...r, route_rest: b32(1) }, reporter)).not.toBe(SOL.c0);
    expect(receiptCommitment(r, { ...reporter, application: HOPS[0]!.router })).not.toBe(SOL.c0);
    expect(receiptCommitment(r, reporter, [{ ...HOPS[0]!, fee: 6n }])).not.toBe(SOL.c0);
    expect(() => receiptCommitment(r, reporter, [])).toThrow(/prefix hops/);
    // the destination's DELIVERED receipt: zero rest
    const d = makeReceipt(UETR, { status: "DELIVERED", hop_index: 2, route_edge: edgeDigest(HOPS[2]!), route_rest: "0x" });
    expect(receiptCommitment(d, { ledger_id: "eip155:1", application: HOPS[2]!.router }, HOPS.slice(0, 2))).toBe(SOL.c0);
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

  it("ACCC only from the destination (zero route_rest)", () => {
    expect(() => receiptToPacs002(makeReceipt(UETR, { status: "DELIVERED", route_rest: b32(9) }), ref, opts)).toThrow(/destination/);
  });

  it("TRUST_FLOOR → RJCT / AGNT", () => {
    const p = receiptToPacs002(makeReceipt(UETR, { status: "FAILED", reason: "TRUST_FLOOR", hop_index: 0, ledger_id: "stellar:pubnet" }), ref, opts);
    expect(p.tx.statusReasons?.[0]?.code).toBe("AGNT");
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
