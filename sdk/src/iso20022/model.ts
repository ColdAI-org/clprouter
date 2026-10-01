/**
 * Message models for the ISO 20022 filter. Field names are readable English; each one documents the ISO 20022
 * element it maps to. Versions follow the CBPR+ usage guidelines (SWIFT cross-border payments, SR2025/SR2026):
 *
 * | Message | Definition | Root element |
 * | --- | --- | --- |
 * | FI-to-FI customer credit transfer | pacs.008.001.08 | `FIToFICstmrCdtTrf` |
 * | FI credit transfer | pacs.009.001.08 | `FICdtTrf` |
 * | Payment status report | pacs.002.001.10 | `FIToFIPmtStsRpt` |
 * | FI-to-FI payment cancellation request | camt.056.001.08 | `FIToFIPmtCxlReq` |
 * | Payment return | pacs.004.001.09 | `PmtRtr` |
 * | Resolution of investigation | camt.029.001.09 | `RsltnOfInvstgtn` |
 *
 * All messages carry exactly one transaction (CBPR+ `NbOfTxs` = 1). Amounts are decimal strings, never floats.
 */
import type {
  CancellationReason,
  CancellationRejection,
  ChargeBearer,
  InvestigationConfirmation,
  ReturnReason,
  SettlementMethod,
  TxCancellationStatus,
  TxStatus,
} from "./codes.js";

export const MESSAGE_DEFINITIONS = {
  "pacs.008": "pacs.008.001.08",
  "pacs.009": "pacs.009.001.08",
  "pacs.002": "pacs.002.001.10",
  "camt.056": "camt.056.001.08",
  "pacs.004": "pacs.004.001.09",
  "camt.029": "camt.029.001.09",
} as const;
export type MessageKind = keyof typeof MESSAGE_DEFINITIONS;
export type MessageDefinition = (typeof MESSAGE_DEFINITIONS)[MessageKind];

export const ROOT_ELEMENTS: Record<MessageKind, string> = {
  "pacs.008": "FIToFICstmrCdtTrf",
  "pacs.009": "FICdtTrf",
  "pacs.002": "FIToFIPmtStsRpt",
  "camt.056": "FIToFIPmtCxlReq",
  "pacs.004": "PmtRtr",
  "camt.029": "RsltnOfInvstgtn",
};

export function namespaceOf(kind: MessageKind): string {
  return `urn:iso:std:iso:20022:tech:xsd:${MESSAGE_DEFINITIONS[kind]}`;
}

/** `ActiveCurrencyAndAmount`: `<X Ccy="EUR">1234.56</X>`. */
export interface Amount {
  value: string;
  currency: string;
}

/** `PostalAddress24`, structured only (no `AdrLine`). `TwnNm` and `Ctry` are required. */
export interface PostalAddress {
  department?: string; // Dept
  subDepartment?: string; // SubDept
  streetName?: string; // StrtNm
  buildingNumber?: string; // BldgNb
  buildingName?: string; // BldgNm
  floor?: string; // Flr
  postBox?: string; // PstBx
  room?: string; // Room
  postCode?: string; // PstCd
  townName: string; // TwnNm
  townLocationName?: string; // TwnLctnNm
  districtName?: string; // DstrctNm
  countrySubDivision?: string; // CtrySubDvsn
  country: string; // Ctry
}

/** `BranchAndFinancialInstitutionIdentification6/FinInstnId`. */
export interface FinancialInstitution {
  bicfi?: string; // BICFI
  clearingSystemMemberId?: { code: string; memberId: string }; // ClrSysMmbId/ClrSysId/Cd, MmbId
  lei?: string; // LEI
  name?: string; // Nm
  postalAddress?: PostalAddress; // PstlAdr
}

/** `GenericOrganisationIdentification1` / `GenericPersonIdentification1` / `GenericAccountIdentification1`. */
export interface GenericIdentification {
  id: string; // Id
  schemeCode?: string; // SchmeNm/Cd
  schemeProprietary?: string; // SchmeNm/Prtry
  issuer?: string; // Issr
}

/** `PartyIdentification135`. */
export interface Party {
  name?: string; // Nm
  postalAddress?: PostalAddress; // PstlAdr
  organisationId?: { anyBic?: string; lei?: string; other?: GenericIdentification[] }; // Id/OrgId
  privateId?: {
    dateAndPlaceOfBirth?: { birthDate: string; provinceOfBirth?: string; cityOfBirth: string; countryOfBirth: string };
    other?: GenericIdentification[];
  }; // Id/PrvtId
  countryOfResidence?: string; // CtryOfRes
}

/** `CashAccount38`: exactly one of `iban` and `other`. */
export interface CashAccount {
  iban?: string; // Id/IBAN
  other?: GenericIdentification; // Id/Othr
  currency?: string; // Ccy
  name?: string; // Nm
}

/** `PaymentIdentification7`. UETR is mandatory under CBPR+. */
export interface PaymentId {
  instructionId?: string; // InstrId
  endToEndId: string; // EndToEndId
  transactionId?: string; // TxId
  uetr: string; // UETR
}

/** `PaymentTypeInformation28` (subset). */
export interface PaymentTypeInfo {
  instructionPriority?: "HIGH" | "NORM"; // InstrPrty
  serviceLevel?: string[]; // SvcLvl/Cd
  localInstrument?: string; // LclInstrm/Prtry
  categoryPurpose?: string; // CtgyPurp/Cd
}

/** `GroupHeader93` for value messages (pacs.008, pacs.009, pacs.004). */
export interface GroupHeader {
  messageId: string; // MsgId
  creationDateTime: string; // CreDtTm
  settlementMethod: SettlementMethod; // SttlmInf/SttlmMtd
}

/** `OriginalGroupInformation29`. */
export interface OriginalGroupInfo {
  messageId: string; // OrgnlMsgId
  messageNameId: string; // OrgnlMsgNmId, e.g. "pacs.008.001.08"
  creationDateTime?: string; // OrgnlCreDtTm
}

/** Status / cancellation / return reason block (`StsRsnInf`, `CxlRsnInf`, `RtrRsnInf`, `CxlStsRsnInf`). */
export interface ReasonInfo<C extends string = string> {
  originator?: { name?: string; anyBic?: string }; // Orgtr
  code?: C; // Rsn/Cd
  proprietary?: string; // Rsn/Prtry
  additionalInfo?: string[]; // AddtlInf, Max105Text each
}

export interface Pacs008 {
  kind: "pacs.008";
  groupHeader: GroupHeader;
  tx: {
    paymentId: PaymentId; // PmtId
    paymentTypeInfo?: PaymentTypeInfo; // PmtTpInf
    interbankSettlementAmount: Amount; // IntrBkSttlmAmt
    interbankSettlementDate: string; // IntrBkSttlmDt
    instructedAmount?: Amount; // InstdAmt
    exchangeRate?: string; // XchgRate
    chargeBearer: ChargeBearer; // ChrgBr
    instructingAgent: FinancialInstitution; // InstgAgt
    instructedAgent: FinancialInstitution; // InstdAgt
    intermediaryAgent1?: FinancialInstitution; // IntrmyAgt1
    ultimateDebtor?: Party; // UltmtDbtr
    debtor: Party; // Dbtr
    debtorAccount: CashAccount; // DbtrAcct (required here: travel rule)
    debtorAgent: FinancialInstitution; // DbtrAgt
    creditorAgent: FinancialInstitution; // CdtrAgt
    creditor: Party; // Cdtr
    creditorAccount?: CashAccount; // CdtrAcct
    ultimateCreditor?: Party; // UltmtCdtr
    purpose?: string; // Purp/Cd
    remittanceInformation?: { unstructured?: string; creditorReference?: string }; // RmtInf
  };
}

export interface Pacs009 {
  kind: "pacs.009";
  groupHeader: GroupHeader;
  tx: {
    paymentId: PaymentId;
    paymentTypeInfo?: PaymentTypeInfo;
    interbankSettlementAmount: Amount;
    interbankSettlementDate: string;
    instructingAgent: FinancialInstitution;
    instructedAgent: FinancialInstitution;
    intermediaryAgent1?: FinancialInstitution;
    debtor: FinancialInstitution; // Dbtr/FinInstnId
    debtorAccount?: CashAccount;
    debtorAgent?: FinancialInstitution;
    creditorAgent?: FinancialInstitution;
    creditor: FinancialInstitution; // Cdtr/FinInstnId
    creditorAccount?: CashAccount;
    remittanceInformation?: { unstructured?: string }; // RmtInf/Ustrd
  };
}

export interface Pacs002 {
  kind: "pacs.002";
  groupHeader: { messageId: string; creationDateTime: string }; // GroupHeader91
  tx: {
    statusId?: string; // StsId
    originalGroupInfo: OriginalGroupInfo; // OrgnlGrpInf
    originalInstructionId?: string; // OrgnlInstrId
    originalEndToEndId?: string; // OrgnlEndToEndId
    originalTxId?: string; // OrgnlTxId
    originalUetr: string; // OrgnlUETR
    status: TxStatus; // TxSts
    statusReasons?: ReasonInfo[]; // StsRsnInf
    acceptanceDateTime?: string; // AccptncDtTm
    instructingAgent?: FinancialInstitution; // InstgAgt
    instructedAgent?: FinancialInstitution; // InstdAgt
  };
}

/** `Assgnmt` of camt.056 and camt.029 (CaseAssignment5). */
export interface Assignment {
  id: string; // Id
  assigner: FinancialInstitution; // Assgnr/Agt
  assignee: FinancialInstitution; // Assgne/Agt
  creationDateTime: string; // CreDtTm
}

/** `Case5`: CBPR+ requires the case and its creator agent. */
export interface InvestigationCase {
  id: string; // Id
  creator: FinancialInstitution; // Cretr/Agt
}

export interface Camt056 {
  kind: "camt.056";
  assignment: Assignment;
  tx: {
    cancellationId?: string; // CxlId
    case: InvestigationCase; // Case
    originalGroupInfo: OriginalGroupInfo;
    originalInstructionId?: string;
    originalEndToEndId?: string;
    originalTxId?: string;
    originalUetr: string;
    originalInterbankSettlementAmount: Amount; // OrgnlIntrBkSttlmAmt
    originalInterbankSettlementDate: string; // OrgnlIntrBkSttlmDt
    reason: ReasonInfo<CancellationReason>; // CxlRsnInf
  };
}

export type PartyOrAgent = { party: Party; agent?: undefined } | { agent: FinancialInstitution; party?: undefined };

export interface Pacs004 {
  kind: "pacs.004";
  groupHeader: GroupHeader;
  tx: {
    returnId?: string; // RtrId
    originalGroupInfo: OriginalGroupInfo;
    originalInstructionId?: string;
    originalEndToEndId?: string;
    originalTxId?: string;
    originalUetr: string;
    originalInterbankSettlementAmount?: Amount;
    originalInterbankSettlementDate?: string;
    returnedInterbankSettlementAmount: Amount; // RtrdIntrBkSttlmAmt
    interbankSettlementDate: string; // IntrBkSttlmDt
    chargeBearer?: ChargeBearer;
    instructingAgent: FinancialInstitution;
    instructedAgent: FinancialInstitution;
    returnChain: {
      debtor: PartyOrAgent; // RtrChain/Dbtr (the original creditor)
      debtorAgent?: FinancialInstitution; // RtrChain/DbtrAgt
      creditorAgent?: FinancialInstitution; // RtrChain/CdtrAgt
      creditor: PartyOrAgent; // RtrChain/Cdtr (the original debtor)
    };
    reason: ReasonInfo<ReturnReason>; // RtrRsnInf
  };
}

export interface Camt029 {
  kind: "camt.029";
  assignment: Assignment;
  resolvedCase?: InvestigationCase; // RslvdCase
  confirmation: InvestigationConfirmation; // Sts/Conf
  tx: {
    cancellationStatusId?: string; // CxlStsId
    originalGroupInfo: OriginalGroupInfo;
    originalInstructionId?: string;
    originalEndToEndId?: string;
    originalTxId?: string;
    originalUetr: string;
    cancellationStatus: TxCancellationStatus; // TxCxlSts
    reason?: ReasonInfo<CancellationRejection | string>; // CxlStsRsnInf
  };
}

export type IsoMessage = Pacs008 | Pacs009 | Pacs002 | Camt056 | Pacs004 | Camt029;
