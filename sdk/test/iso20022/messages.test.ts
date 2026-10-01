import { describe, expect, it } from "vitest";
import type { Camt029, Camt056, IsoMessage, Pacs002, Pacs004 } from "../../src/iso20022/index.js";
import {
  IsoValidationError,
  amountProblems,
  fromXml,
  isBic,
  isIban,
  isIsoDateTime,
  isLei,
  toXml,
  validateMessage,
} from "../../src/iso20022/index.js";
import { CREDITOR_AGENT, DEBTOR_AGENT, HIERO_AGENT, UETR, pacs008, pacs009 } from "./fixtures.js";

const camt056: Camt056 = {
  kind: "camt.056",
  assignment: { id: "ASSGN-1", assigner: DEBTOR_AGENT, assignee: CREDITOR_AGENT, creationDateTime: "2026-10-02T08:00:00Z" },
  tx: {
    cancellationId: "CXL-1",
    case: { id: "CASE-DUPL-1", creator: DEBTOR_AGENT },
    originalGroupInfo: { messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08", creationDateTime: "2026-10-01T09:30:00.000Z" },
    originalEndToEndId: "E2E-INV-4711",
    originalUetr: UETR,
    originalInterbankSettlementAmount: { value: "1250.00", currency: "EUR" },
    originalInterbankSettlementDate: "2026-10-01",
    reason: { code: "DUPL", additionalInfo: ["Sent twice"] },
  },
};

const pacs002: Pacs002 = {
  kind: "pacs.002",
  groupHeader: { messageId: "STS-1", creationDateTime: "2026-10-01T09:31:00Z" },
  tx: {
    originalGroupInfo: { messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08" },
    originalEndToEndId: "E2E-INV-4711",
    originalUetr: UETR,
    status: "RJCT",
    statusReasons: [{ originator: { anyBic: "HIERCHZZ" }, code: "RR04", additionalInfo: ["CASE/0xab", "CONTACT/https://provider.example/cases"] }],
    instructingAgent: HIERO_AGENT,
  },
};

const pacs004: Pacs004 = {
  kind: "pacs.004",
  groupHeader: { messageId: "RTR-1", creationDateTime: "2026-10-02T09:00:00Z", settlementMethod: "INDA" },
  tx: {
    returnId: "RTR-ID-1",
    originalGroupInfo: { messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08" },
    originalUetr: UETR,
    originalInterbankSettlementAmount: { value: "1250.00", currency: "EUR" },
    returnedInterbankSettlementAmount: { value: "1250.00", currency: "EUR" },
    interbankSettlementDate: "2026-10-02",
    instructingAgent: CREDITOR_AGENT,
    instructedAgent: DEBTOR_AGENT,
    returnChain: {
      debtor: { party: { name: "John Smith", postalAddress: { townName: "London", country: "GB" } } },
      creditor: { agent: DEBTOR_AGENT },
    },
    reason: { code: "FOCR" },
  },
};

const camt029: Camt029 = {
  kind: "camt.029",
  assignment: { id: "ASSGN-2", assigner: CREDITOR_AGENT, assignee: DEBTOR_AGENT, creationDateTime: "2026-10-02T10:00:00Z" },
  resolvedCase: { id: "CASE-DUPL-1", creator: DEBTOR_AGENT },
  confirmation: "RJCR",
  tx: {
    originalGroupInfo: { messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08" },
    originalUetr: UETR,
    cancellationStatus: "RJCR",
    reason: { code: "NOAS" },
  },
};

const ALL: [string, IsoMessage][] = [
  ["pacs.008", pacs008()],
  ["pacs.009", pacs009()],
  ["pacs.002", pacs002],
  ["camt.056", camt056],
  ["pacs.004", pacs004],
  ["camt.029", camt029],
];

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof IsoValidationError) return [...e.issues];
    throw e;
  }
  throw new Error("expected an IsoValidationError");
}

describe("XML round trips", () => {
  it.each(ALL)("%s: model → XML → model is lossless", (_, m) => {
    const xml = toXml(m);
    expect(fromXml(xml)).toEqual(m);
    // and stable: serialising the parsed model gives the same bytes
    expect(toXml(fromXml(xml))).toBe(xml);
  });

  it("uses the CBPR+ message definitions and root elements", () => {
    const xml = toXml(pacs008());
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
    expect(xml).toContain("<FIToFICstmrCdtTrf>");
    expect(xml).toContain('<IntrBkSttlmAmt Ccy="EUR">1250.00</IntrBkSttlmAmt>');
    expect(xml).toContain("<UETR>8a562c67-ca16-48ba-b074-65581be6f001</UETR>");
    expect(xml).toContain("<NbOfTxs>1</NbOfTxs>");
    expect(toXml(pacs009())).toContain("<FICdtTrf>");
    expect(toXml(pacs002)).toContain("pacs.002.001.10");
    expect(toXml(camt056)).toContain("camt.056.001.08");
    expect(toXml(pacs004)).toContain("pacs.004.001.09");
    expect(toXml(camt029)).toContain("camt.029.001.09");
  });

  it("emits elements in XSD sequence order", () => {
    const xml = toXml(pacs008());
    const order = ["<PmtId>", "<PmtTpInf>", "<IntrBkSttlmAmt", "<IntrBkSttlmDt>", "<InstdAmt", "<ChrgBr>", "<InstgAgt>", "<InstdAgt>", "<IntrmyAgt1>", "<Dbtr>", "<DbtrAcct>", "<DbtrAgt>", "<CdtrAgt>", "<Cdtr>", "<CdtrAcct>", "<Purp>", "<RmtInf>"];
    const at = order.map((t) => xml.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const addr = ["<StrtNm>", "<BldgNb>", "<PstCd>", "<TwnNm>", "<Ctry>"].map((t) => xml.indexOf(t));
    expect([...addr].sort((a, b) => a - b)).toEqual(addr);
  });

  it("escapes markup in text and reads it back", () => {
    const xml = toXml(pacs008());
    expect(xml).toContain("Invoice 4711 &amp; 4712 &lt;paid&gt;");
    expect((fromXml(xml, "pacs.008")).tx.remittanceInformation?.unstructured).toBe("Invoice 4711 & 4712 <paid>");
  });

  it("reads a namespace-prefixed document", () => {
    const xml = toXml(pacs002)
      .replace('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">', '<doc:Document xmlns:doc="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">')
      .replace(/<(\/?)([A-Za-z]+)(\s|>)/g, (all, slash, name, end) => (name === "Document" ? all : `<${slash}doc:${name}${end}`))
      .replace("</Document>", "</doc:Document>");
    expect(xml).toContain("<doc:TxSts>RJCT</doc:TxSts>");
    expect(fromXml(xml)).toEqual(pacs002);
  });
});

describe("schema failures on parse", () => {
  const good = toXml(pacs008());

  it("rejects DOCTYPE / entity declarations (no XXE)", () => {
    const evil = good.replace("<Document", '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<Document');
    expect(issuesOf(() => fromXml(evil)).join()).toMatch(/DOCTYPE/);
  });

  it("rejects malformed XML", () => {
    expect(issuesOf(() => fromXml(good.replace("</Dbtr>", "</Dbtor>"))).join()).toMatch(/not well-formed/);
  });

  it("rejects unknown namespaces and the wrong expected kind", () => {
    expect(issuesOf(() => fromXml(good.replace("pacs.008.001.08", "pacs.008.001.99"))).join()).toMatch(/unsupported/);
    expect(issuesOf(() => fromXml(good, "pacs.009")).join()).toMatch(/expected pacs.009/);
    expect(issuesOf(() => fromXml(good.replaceAll("FIToFICstmrCdtTrf", "FICdtTrf"))).join()).toMatch(/root element/);
  });

  it("rejects unknown and repeated elements", () => {
    expect(issuesOf(() => fromXml(good.replace("<ChrgBr>SHAR</ChrgBr>", "<ChrgBr>SHAR</ChrgBr><Gossip>x</Gossip>"))).join()).toMatch(/unexpected element <Gossip>/);
    expect(issuesOf(() => fromXml(good.replace("<ChrgBr>SHAR</ChrgBr>", "<ChrgBr>SHAR</ChrgBr><ChrgBr>DEBT</ChrgBr>"))).join()).toMatch(/must not repeat/);
  });

  it("rejects a missing required element", () => {
    const xml = good.replace(/<UETR>[^<]*<\/UETR>/, "");
    expect(issuesOf(() => fromXml(xml)).join()).toMatch(/PmtId\/UETR: is required/);
  });

  it("rejects an unstructured address line", () => {
    const xml = good.replace("<TwnNm>London</TwnNm>", "<TwnNm>London</TwnNm><AdrLine>221B Baker Street</AdrLine>");
    expect(issuesOf(() => fromXml(xml)).join()).toMatch(/unexpected element <AdrLine>/);
  });

  it("rejects an amount without a currency", () => {
    const xml = good.replace('<IntrBkSttlmAmt Ccy="EUR">1250.00</IntrBkSttlmAmt>', "<IntrBkSttlmAmt>1250.00</IntrBkSttlmAmt>");
    expect(issuesOf(() => fromXml(xml)).join()).toMatch(/IntrBkSttlmAmt/);
  });
});

describe("field rules", () => {
  it("BIC, LEI, IBAN formats and check digits", () => {
    expect(isBic("CLPRDEFFXXX")).toBe(true);
    expect(isBic("CLPRDEFF")).toBe(true);
    expect(isBic("CLPRQQFF")).toBe(false); // QQ is not a country
    expect(isBic("clprdeff")).toBe(false);
    expect(isBic("CLPRDEFFXX")).toBe(false);
    expect(isLei("529900CLPRDEBTOR0014")).toBe(true);
    expect(isLei("529900CLPRDEBTOR0015")).toBe(false);
    expect(isLei("529900G3SW56SHYNPR95")).toBe(true);
    expect(isIban("DE89370400440532013000")).toBe(true);
    expect(isIban("DE89370400440532013001")).toBe(false);
    expect(isIsoDateTime("2026-10-01T09:30:00Z")).toBe(true);
    expect(isIsoDateTime("2026-10-01T09:30:00")).toBe(false); // CBPR+ needs an offset
    expect(isIsoDateTime("2026-02-30T09:30:00Z")).toBe(false);
  });

  it("amount and currency rules", () => {
    expect(amountProblems({ value: "1250.00", currency: "EUR" })).toEqual([]);
    expect(amountProblems({ value: "1000000", currency: "JPY" })).toEqual([]);
    expect(amountProblems({ value: "1.234", currency: "KWD" })).toEqual([]);
    expect(amountProblems({ value: "10.5", currency: "JPY" }).join()).toMatch(/JPY allows 0 decimal places/);
    expect(amountProblems({ value: "10.001", currency: "EUR" }).join()).toMatch(/EUR allows 2/);
    expect(amountProblems({ value: "0.00", currency: "EUR" }).join()).toMatch(/greater than zero/);
    expect(amountProblems({ value: "-5", currency: "EUR" }).join()).toMatch(/plain decimal/);
    expect(amountProblems({ value: "1e5", currency: "EUR" }).join()).toMatch(/plain decimal/);
    expect(amountProblems({ value: "123456789012345", currency: "JPY" }).join()).toMatch(/14 digits/);
    expect(amountProblems({ value: "1.00", currency: "HRK" }).join()).toMatch(/withdrawn/);
    expect(amountProblems({ value: "1.00", currency: "EURO" }).join()).toMatch(/unknown/);
  });

  it("reports every problem at once", () => {
    const m = pacs008({
      interbankSettlementAmount: { value: "12.345", currency: "EUR" },
      instructingAgent: { bicfi: "BADBIC" },
      debtorAccount: { iban: "DE00370400440532013000" },
      paymentId: { endToEndId: "/E2E", uetr: "8a562c67-ca16-18ba-b074-65581be6f001" },
    });
    const issues = validateMessage(m).join("\n");
    expect(issues).toMatch(/IntrBkSttlmAmt: EUR allows 2/);
    expect(issues).toMatch(/InstgAgt\/FinInstnId\/BICFI: "BADBIC" is not a valid BIC/);
    expect(issues).toMatch(/DbtrAcct\/Id\/IBAN/);
    expect(issues).toMatch(/EndToEndId: must not start or end with \//);
    expect(issues).toMatch(/UETR: .* is not a UUIDv4/);
    expect(() => toXml(m)).toThrow(IsoValidationError);
  });

  it("requires structured addresses with town and country", () => {
    const m = pacs008();
    m.tx.creditor = { name: "John Smith", postalAddress: { streetName: "Baker Street" } as never };
    const issues = validateMessage(m).join("\n");
    expect(issues).toMatch(/Cdtr\/PstlAdr\/TwnNm: is required/);
    expect(issues).toMatch(/Cdtr\/PstlAdr\/Ctry: is required/);
  });

  it("travel rule: the debtor needs a name and an address or identification", () => {
    const issues = validateMessage(pacs008({ debtor: { name: "Erika Mustermann" } })).join("\n");
    expect(issues).toMatch(/Dbtr: needs a structured postal address or an identification/);
    expect(validateMessage(pacs008({ debtor: { name: "Erika Mustermann", organisationId: { lei: "529900CLPRDEBTOR0014" } } }))).toEqual([]);
  });

  it("agents: BICFI where CBPR+ requires it, else name + structured address", () => {
    expect(validateMessage(pacs008({ instructedAgent: { name: "Hiero Bank" } })).join()).toMatch(/InstdAgt\/FinInstnId\/BICFI: is required/);
    expect(validateMessage(pacs008({ creditorAgent: { name: "Small Bank" } })).join()).toMatch(/CdtrAgt\/FinInstnId: needs a BICFI/);
    expect(
      validateMessage(pacs008({ creditorAgent: { name: "Small Bank", postalAddress: { townName: "Zug", country: "CH" } } })),
    ).toEqual([]);
    expect(validateMessage(pacs009({ creditor: { name: "No BIC Bank", postalAddress: { townName: "Zug", country: "CH" } } })).join()).toMatch(
      /Cdtr\/FinInstnId\/BICFI: is required/,
    );
  });

  it("charge bearer, settlement method and exchange rate", () => {
    expect(validateMessage(pacs008({ chargeBearer: "SLEV" as never })).join()).toMatch(/ChrgBr/);
    const fx = pacs008({ instructedAmount: { value: "1300.00", currency: "USD" } });
    expect(validateMessage(fx).join()).toMatch(/XchgRate: is required/);
    expect(validateMessage({ ...fx, tx: { ...fx.tx, exchangeRate: "1.04" } })).toEqual([]);
  });

  it("status and investigation messages", () => {
    expect(validateMessage({ ...pacs002, tx: { ...pacs002.tx, statusReasons: undefined } }).join()).toMatch(/StsRsnInf: is required when TxSts is RJCT/);
    expect(validateMessage({ ...camt056, tx: { ...camt056.tx, reason: { code: "WHIM" as never } } }).join()).toMatch(/CxlRsnInf\/Rsn\/Cd/);
    expect(validateMessage({ ...camt029, confirmation: "CNCL" }).join()).toMatch(/must be ACCR/);
    expect(
      validateMessage({ ...pacs004, tx: { ...pacs004.tx, returnedInterbankSettlementAmount: { value: "2000.00", currency: "EUR" } } }).join(),
    ).toMatch(/exceeds the original/);
    expect(
      validateMessage({ ...pacs002, tx: { ...pacs002.tx, statusReasons: [{ code: "RR04", additionalInfo: ["a", "b", "c"] }] } }).join(),
    ).toMatch(/at most 2/);
  });
});
