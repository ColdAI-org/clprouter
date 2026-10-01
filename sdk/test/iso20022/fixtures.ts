import type { FinancialInstitution, Pacs008, Pacs009 } from "../../src/iso20022/index.js";

export const UETR = "8a562c67-ca16-48ba-b074-65581be6f001";
export const UETR_009 = "0f4d3b2a-1c5e-4d6f-9a7b-8c9d0e1f2a3b";
export const DEBTOR_LEI = "529900CLPRDEBTOR0014";
export const CREDITOR_LEI = "529900CLPRCREDIT0031";
export const HIERO_LEI = "549300HIEROBANK00087";

export const DEBTOR_AGENT: FinancialInstitution = { bicfi: "CLPRDEFFXXX", lei: DEBTOR_LEI };
export const CREDITOR_AGENT: FinancialInstitution = { bicfi: "CLPRGB2L" };
export const HIERO_AGENT: FinancialInstitution = { bicfi: "HIERCHZZ", lei: HIERO_LEI };

/** Personal data that must never appear on-chain in clear. */
export const PII = {
  debtorName: "Erika Mustermann",
  debtorStreet: "Heidestrasse",
  debtorIban: "DE89370400440532013000",
  creditorName: "John Smith",
  creditorIban: "GB29NWBK60161331926819",
};

export function pacs008(over: Partial<Pacs008["tx"]> = {}): Pacs008 {
  return {
    kind: "pacs.008",
    groupHeader: { messageId: "MSG-2026-10-01-0001", creationDateTime: "2026-10-01T09:30:00.000Z", settlementMethod: "INDA" },
    tx: {
      paymentId: { instructionId: "INSTR-1", endToEndId: "E2E-INV-4711", transactionId: "TX-1", uetr: UETR },
      paymentTypeInfo: { serviceLevel: ["G001"] },
      interbankSettlementAmount: { value: "1250.00", currency: "EUR" },
      interbankSettlementDate: "2026-10-01",
      instructedAmount: { value: "1250.00", currency: "EUR" },
      chargeBearer: "SHAR",
      instructingAgent: DEBTOR_AGENT,
      instructedAgent: HIERO_AGENT,
      intermediaryAgent1: HIERO_AGENT,
      debtor: {
        name: PII.debtorName,
        postalAddress: { streetName: PII.debtorStreet, buildingNumber: "17", postCode: "80331", townName: "Muenchen", country: "DE" },
        privateId: { dateAndPlaceOfBirth: { birthDate: "1964-08-12", cityOfBirth: "Koeln", countryOfBirth: "DE" } },
        countryOfResidence: "DE",
      },
      debtorAccount: { iban: PII.debtorIban },
      debtorAgent: DEBTOR_AGENT,
      creditorAgent: CREDITOR_AGENT,
      creditor: {
        name: PII.creditorName,
        postalAddress: { streetName: "Baker Street", buildingNumber: "221B", postCode: "NW1 6XE", townName: "London", country: "GB" },
        organisationId: { lei: CREDITOR_LEI },
      },
      creditorAccount: { iban: PII.creditorIban },
      purpose: "GDDS",
      remittanceInformation: { unstructured: "Invoice 4711 & 4712 <paid>" },
      ...over,
    },
  };
}

export function pacs009(over: Partial<Pacs009["tx"]> = {}): Pacs009 {
  return {
    kind: "pacs.009",
    groupHeader: { messageId: "FI-MSG-1", creationDateTime: "2026-10-01T10:00:00+02:00", settlementMethod: "INDA" },
    tx: {
      paymentId: { endToEndId: "FI-E2E-1", uetr: UETR_009 },
      interbankSettlementAmount: { value: "1000000", currency: "JPY" },
      interbankSettlementDate: "2026-10-01",
      instructingAgent: DEBTOR_AGENT,
      instructedAgent: CREDITOR_AGENT,
      debtor: DEBTOR_AGENT,
      creditor: { bicfi: "CLPRGB2LTRS", lei: CREDITOR_LEI },
      creditorAccount: { other: { id: "NOSTRO-JPY-001", schemeCode: "BBAN" }, currency: "JPY" },
      remittanceInformation: { unstructured: "/BNF/Treasury funding" },
      ...over,
    },
  };
}
