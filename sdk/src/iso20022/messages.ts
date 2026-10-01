/**
 * XML (de)serialisation for the six ISO 20022 messages of the filter. Writers emit elements in XSD sequence order;
 * readers are strict (unknown elements fail) and every message is validated on the way out and on the way in.
 */
import type {
  CancellationReason,
  ChargeBearer,
  InvestigationConfirmation,
  ReturnReason,
  SettlementMethod,
  TxCancellationStatus,
  TxStatus,
} from "./codes.js";
import type {
  Amount,
  Assignment,
  Camt029,
  Camt056,
  CashAccount,
  FinancialInstitution,
  GenericIdentification,
  GroupHeader,
  InvestigationCase,
  IsoMessage,
  MessageKind,
  OriginalGroupInfo,
  Pacs002,
  Pacs004,
  Pacs008,
  Pacs009,
  Party,
  PartyOrAgent,
  PaymentId,
  PaymentTypeInfo,
  PostalAddress,
  ReasonInfo,
} from "./model.js";
import { MESSAGE_DEFINITIONS, ROOT_ELEMENTS, namespaceOf } from "./model.js";
import { IsoValidationError, Issues, validateMessage } from "./validate.js";
import type { XmlObj, XmlValue } from "./xml.js";
import { Node, buildDocument, parseDocument } from "./xml.js";

// ── Writers ─────────────────────────────────────────────────────────────────

const amt = (a: Amount | undefined): XmlValue => (a ? { "@_Ccy": a.currency, "#text": a.value } : undefined);

function wAddress(a: PostalAddress | undefined): XmlValue {
  if (!a) return undefined;
  return {
    Dept: a.department,
    SubDept: a.subDepartment,
    StrtNm: a.streetName,
    BldgNb: a.buildingNumber,
    BldgNm: a.buildingName,
    Flr: a.floor,
    PstBx: a.postBox,
    Room: a.room,
    PstCd: a.postCode,
    TwnNm: a.townName,
    TwnLctnNm: a.townLocationName,
    DstrctNm: a.districtName,
    CtrySubDvsn: a.countrySubDivision,
    Ctry: a.country,
  };
}

function wFinInstnId(f: FinancialInstitution): XmlObj {
  return {
    BICFI: f.bicfi,
    ClrSysMmbId: f.clearingSystemMemberId
      ? { ClrSysId: { Cd: f.clearingSystemMemberId.code }, MmbId: f.clearingSystemMemberId.memberId }
      : undefined,
    LEI: f.lei,
    Nm: f.name,
    PstlAdr: wAddress(f.postalAddress),
  };
}

/** `BranchAndFinancialInstitutionIdentification6`. */
const wAgent = (f: FinancialInstitution | undefined): XmlValue => (f ? { FinInstnId: wFinInstnId(f) } : undefined);

function wGeneric(g: GenericIdentification): XmlObj {
  return {
    Id: g.id,
    SchmeNm: g.schemeCode || g.schemeProprietary ? { Cd: g.schemeCode, Prtry: g.schemeProprietary } : undefined,
    Issr: g.issuer,
  };
}

function wParty(p: Party | undefined): XmlValue {
  if (!p) return undefined;
  const b = p.privateId?.dateAndPlaceOfBirth;
  return {
    Nm: p.name,
    PstlAdr: wAddress(p.postalAddress),
    Id: p.organisationId
      ? { OrgId: { AnyBIC: p.organisationId.anyBic, LEI: p.organisationId.lei, Othr: p.organisationId.other?.map(wGeneric) } }
      : p.privateId
        ? {
            PrvtId: {
              DtAndPlcOfBirth: b
                ? { BirthDt: b.birthDate, PrvcOfBirth: b.provinceOfBirth, CityOfBirth: b.cityOfBirth, CtryOfBirth: b.countryOfBirth }
                : undefined,
              Othr: p.privateId.other?.map(wGeneric),
            },
          }
        : undefined,
    CtryOfRes: p.countryOfResidence,
  };
}

function wAccount(a: CashAccount | undefined): XmlValue {
  if (!a) return undefined;
  return { Id: a.iban ? { IBAN: a.iban } : a.other ? { Othr: wGeneric(a.other) } : undefined, Ccy: a.currency, Nm: a.name };
}

const wPmtId = (p: PaymentId): XmlObj => ({ InstrId: p.instructionId, EndToEndId: p.endToEndId, TxId: p.transactionId, UETR: p.uetr });

function wPmtTpInf(p: PaymentTypeInfo | undefined): XmlValue {
  if (!p) return undefined;
  return {
    InstrPrty: p.instructionPriority,
    SvcLvl: p.serviceLevel?.map((Cd) => ({ Cd })),
    LclInstrm: p.localInstrument ? { Prtry: p.localInstrument } : undefined,
    CtgyPurp: p.categoryPurpose ? { Cd: p.categoryPurpose } : undefined,
  };
}

const wGrpHdr = (g: GroupHeader): XmlObj => ({
  MsgId: g.messageId,
  CreDtTm: g.creationDateTime,
  NbOfTxs: "1",
  SttlmInf: { SttlmMtd: g.settlementMethod },
});

const wOrgnlGrp = (g: OriginalGroupInfo): XmlObj => ({ OrgnlMsgId: g.messageId, OrgnlMsgNmId: g.messageNameId, OrgnlCreDtTm: g.creationDateTime });

function wReason(r: ReasonInfo | undefined): XmlValue {
  if (!r) return undefined;
  return {
    Orgtr: r.originator ? { Nm: r.originator.name, Id: r.originator.anyBic ? { OrgId: { AnyBIC: r.originator.anyBic } } : undefined } : undefined,
    Rsn: { Cd: r.code, Prtry: r.proprietary },
    AddtlInf: r.additionalInfo,
  };
}

const wAssignment = (a: Assignment): XmlObj => ({
  Id: a.id,
  Assgnr: { Agt: wAgent(a.assigner) },
  Assgne: { Agt: wAgent(a.assignee) },
  CreDtTm: a.creationDateTime,
});

const wCase = (c: InvestigationCase | undefined): XmlValue => (c ? { Id: c.id, Cretr: { Agt: wAgent(c.creator) } } : undefined);

const wPartyOrAgent = (p: PartyOrAgent): XmlObj => (p.party ? { Pty: wParty(p.party) } : { Agt: wAgent(p.agent) });

function body(m: IsoMessage): XmlObj {
  switch (m.kind) {
    case "pacs.008": {
      const t = m.tx;
      const r = t.remittanceInformation;
      return {
        GrpHdr: wGrpHdr(m.groupHeader),
        CdtTrfTxInf: {
          PmtId: wPmtId(t.paymentId),
          PmtTpInf: wPmtTpInf(t.paymentTypeInfo),
          IntrBkSttlmAmt: amt(t.interbankSettlementAmount),
          IntrBkSttlmDt: t.interbankSettlementDate,
          InstdAmt: amt(t.instructedAmount),
          XchgRate: t.exchangeRate,
          ChrgBr: t.chargeBearer,
          InstgAgt: wAgent(t.instructingAgent),
          InstdAgt: wAgent(t.instructedAgent),
          IntrmyAgt1: wAgent(t.intermediaryAgent1),
          UltmtDbtr: wParty(t.ultimateDebtor),
          Dbtr: wParty(t.debtor),
          DbtrAcct: wAccount(t.debtorAccount),
          DbtrAgt: wAgent(t.debtorAgent),
          CdtrAgt: wAgent(t.creditorAgent),
          Cdtr: wParty(t.creditor),
          CdtrAcct: wAccount(t.creditorAccount),
          UltmtCdtr: wParty(t.ultimateCreditor),
          Purp: t.purpose ? { Cd: t.purpose } : undefined,
          RmtInf: r
            ? {
                Ustrd: r.unstructured,
                Strd: r.creditorReference ? { CdtrRefInf: { Tp: { CdOrPrtry: { Cd: "SCOR" } }, Ref: r.creditorReference } } : undefined,
              }
            : undefined,
        },
      };
    }
    case "pacs.009": {
      const t = m.tx;
      return {
        GrpHdr: wGrpHdr(m.groupHeader),
        CdtTrfTxInf: {
          PmtId: wPmtId(t.paymentId),
          PmtTpInf: wPmtTpInf(t.paymentTypeInfo),
          IntrBkSttlmAmt: amt(t.interbankSettlementAmount),
          IntrBkSttlmDt: t.interbankSettlementDate,
          InstgAgt: wAgent(t.instructingAgent),
          InstdAgt: wAgent(t.instructedAgent),
          IntrmyAgt1: wAgent(t.intermediaryAgent1),
          Dbtr: wAgent(t.debtor),
          DbtrAcct: wAccount(t.debtorAccount),
          DbtrAgt: wAgent(t.debtorAgent),
          CdtrAgt: wAgent(t.creditorAgent),
          Cdtr: wAgent(t.creditor),
          CdtrAcct: wAccount(t.creditorAccount),
          RmtInf: t.remittanceInformation ? { Ustrd: t.remittanceInformation.unstructured } : undefined,
        },
      };
    }
    case "pacs.002": {
      const t = m.tx;
      return {
        GrpHdr: { MsgId: m.groupHeader.messageId, CreDtTm: m.groupHeader.creationDateTime },
        TxInfAndSts: {
          StsId: t.statusId,
          OrgnlGrpInf: wOrgnlGrp(t.originalGroupInfo),
          OrgnlInstrId: t.originalInstructionId,
          OrgnlEndToEndId: t.originalEndToEndId,
          OrgnlTxId: t.originalTxId,
          OrgnlUETR: t.originalUetr,
          TxSts: t.status,
          StsRsnInf: t.statusReasons?.map((r) => wReason(r)),
          AccptncDtTm: t.acceptanceDateTime,
          InstgAgt: wAgent(t.instructingAgent),
          InstdAgt: wAgent(t.instructedAgent),
        },
      };
    }
    case "camt.056": {
      const t = m.tx;
      return {
        Assgnmt: wAssignment(m.assignment),
        Undrlyg: {
          TxInf: {
            CxlId: t.cancellationId,
            Case: wCase(t.case),
            OrgnlGrpInf: wOrgnlGrp(t.originalGroupInfo),
            OrgnlInstrId: t.originalInstructionId,
            OrgnlEndToEndId: t.originalEndToEndId,
            OrgnlTxId: t.originalTxId,
            OrgnlUETR: t.originalUetr,
            OrgnlIntrBkSttlmAmt: amt(t.originalInterbankSettlementAmount),
            OrgnlIntrBkSttlmDt: t.originalInterbankSettlementDate,
            CxlRsnInf: wReason(t.reason),
          },
        },
      };
    }
    case "pacs.004": {
      const t = m.tx;
      return {
        GrpHdr: wGrpHdr(m.groupHeader),
        TxInf: {
          RtrId: t.returnId,
          OrgnlGrpInf: wOrgnlGrp(t.originalGroupInfo),
          OrgnlInstrId: t.originalInstructionId,
          OrgnlEndToEndId: t.originalEndToEndId,
          OrgnlTxId: t.originalTxId,
          OrgnlUETR: t.originalUetr,
          OrgnlIntrBkSttlmAmt: amt(t.originalInterbankSettlementAmount),
          OrgnlIntrBkSttlmDt: t.originalInterbankSettlementDate,
          RtrdIntrBkSttlmAmt: amt(t.returnedInterbankSettlementAmount),
          IntrBkSttlmDt: t.interbankSettlementDate,
          ChrgBr: t.chargeBearer,
          InstgAgt: wAgent(t.instructingAgent),
          InstdAgt: wAgent(t.instructedAgent),
          RtrChain: {
            Dbtr: wPartyOrAgent(t.returnChain.debtor),
            DbtrAgt: wAgent(t.returnChain.debtorAgent),
            CdtrAgt: wAgent(t.returnChain.creditorAgent),
            Cdtr: wPartyOrAgent(t.returnChain.creditor),
          },
          RtrRsnInf: wReason(t.reason),
        },
      };
    }
    case "camt.029": {
      const t = m.tx;
      return {
        Assgnmt: wAssignment(m.assignment),
        RslvdCase: wCase(m.resolvedCase),
        Sts: { Conf: m.confirmation },
        CxlDtls: {
          TxInfAndSts: {
            CxlStsId: t.cancellationStatusId,
            OrgnlGrpInf: wOrgnlGrp(t.originalGroupInfo),
            OrgnlInstrId: t.originalInstructionId,
            OrgnlEndToEndId: t.originalEndToEndId,
            OrgnlTxId: t.originalTxId,
            OrgnlUETR: t.originalUetr,
            TxCxlSts: t.cancellationStatus,
            CxlStsRsnInf: wReason(t.reason),
          },
        },
      };
    }
  }
}

/** Validate and serialise a message to ISO 20022 XML (`Document` root, message namespace as default). */
export function toXml(m: IsoMessage): string {
  const issues = validateMessage(m);
  if (issues.length) throw new IsoValidationError(MESSAGE_DEFINITIONS[m.kind], issues);
  return buildDocument(namespaceOf(m.kind), ROOT_ELEMENTS[m.kind], body(m));
}

// ── Readers ─────────────────────────────────────────────────────────────────

const req = (n: Node | undefined, name: string, parent: Node): Node => {
  if (n) return n;
  parent.issues.add(`${parent.path}/${name}`, "is required");
  return new Node({}, `${parent.path}/${name}`, parent.issues);
};

function rAddress(n: Node | undefined): PostalAddress | undefined {
  if (!n) return undefined;
  n.only("Dept", "SubDept", "StrtNm", "BldgNb", "BldgNm", "Flr", "PstBx", "Room", "PstCd", "TwnNm", "TwnLctnNm", "DstrctNm", "CtrySubDvsn", "Ctry");
  return clean({
    department: n.text("Dept"),
    subDepartment: n.text("SubDept"),
    streetName: n.text("StrtNm"),
    buildingNumber: n.text("BldgNb"),
    buildingName: n.text("BldgNm"),
    floor: n.text("Flr"),
    postBox: n.text("PstBx"),
    room: n.text("Room"),
    postCode: n.text("PstCd"),
    townName: n.text("TwnNm")!,
    townLocationName: n.text("TwnLctnNm"),
    districtName: n.text("DstrctNm"),
    countrySubDivision: n.text("CtrySubDvsn"),
    country: n.text("Ctry")!,
  });
}

function rAgent(n: Node | undefined): FinancialInstitution | undefined {
  if (!n) return undefined;
  n.only("FinInstnId");
  const f = req(n.child("FinInstnId"), "FinInstnId", n).only("BICFI", "ClrSysMmbId", "LEI", "Nm", "PstlAdr");
  const c = f.child("ClrSysMmbId")?.only("ClrSysId", "MmbId");
  return clean({
    bicfi: f.text("BICFI"),
    clearingSystemMemberId: c ? { code: c.child("ClrSysId")?.only("Cd").text("Cd") ?? "", memberId: c.text("MmbId") ?? "" } : undefined,
    lei: f.text("LEI"),
    name: f.text("Nm"),
    postalAddress: rAddress(f.child("PstlAdr")),
  });
}

function rGeneric(n: Node): GenericIdentification {
  n.only("Id", "SchmeNm", "Issr");
  const s = n.child("SchmeNm")?.only("Cd", "Prtry");
  return clean({ id: n.text("Id")!, schemeCode: s?.text("Cd"), schemeProprietary: s?.text("Prtry"), issuer: n.text("Issr") });
}

function rParty(n: Node | undefined): Party | undefined {
  if (!n) return undefined;
  n.only("Nm", "PstlAdr", "Id", "CtryOfRes");
  const id = n.child("Id")?.only("OrgId", "PrvtId");
  const org = id?.child("OrgId")?.only("AnyBIC", "LEI", "Othr");
  const prv = id?.child("PrvtId")?.only("DtAndPlcOfBirth", "Othr");
  const b = prv?.child("DtAndPlcOfBirth")?.only("BirthDt", "PrvcOfBirth", "CityOfBirth", "CtryOfBirth");
  const orgOther = org?.children("Othr").map(rGeneric);
  const prvOther = prv?.children("Othr").map(rGeneric);
  return clean({
    name: n.text("Nm"),
    postalAddress: rAddress(n.child("PstlAdr")),
    organisationId: org
      ? clean({ anyBic: org.text("AnyBIC"), lei: org.text("LEI"), other: orgOther?.length ? orgOther : undefined })
      : undefined,
    privateId: prv
      ? clean({
          dateAndPlaceOfBirth: b
            ? clean({ birthDate: b.text("BirthDt")!, provinceOfBirth: b.text("PrvcOfBirth"), cityOfBirth: b.text("CityOfBirth")!, countryOfBirth: b.text("CtryOfBirth")! })
            : undefined,
          other: prvOther?.length ? prvOther : undefined,
        })
      : undefined,
    countryOfResidence: n.text("CtryOfRes"),
  });
}

function rAccount(n: Node | undefined): CashAccount | undefined {
  if (!n) return undefined;
  n.only("Id", "Ccy", "Nm");
  const id = req(n.child("Id"), "Id", n).only("IBAN", "Othr");
  const othr = id.child("Othr");
  return clean({ iban: id.text("IBAN"), other: othr ? rGeneric(othr) : undefined, currency: n.text("Ccy"), name: n.text("Nm") });
}

function rPmtId(n: Node): PaymentId {
  n.only("InstrId", "EndToEndId", "TxId", "UETR");
  return clean({ instructionId: n.text("InstrId"), endToEndId: n.text("EndToEndId")!, transactionId: n.text("TxId"), uetr: n.text("UETR")! });
}

function rPmtTpInf(n: Node | undefined): PaymentTypeInfo | undefined {
  if (!n) return undefined;
  n.only("InstrPrty", "SvcLvl", "LclInstrm", "CtgyPurp");
  const svc = n.children("SvcLvl").map((s) => s.only("Cd").text("Cd") ?? "");
  return clean({
    instructionPriority: n.text("InstrPrty") as PaymentTypeInfo["instructionPriority"],
    serviceLevel: svc.length ? svc : undefined,
    localInstrument: n.child("LclInstrm")?.only("Prtry").text("Prtry"),
    categoryPurpose: n.child("CtgyPurp")?.only("Cd").text("Cd"),
  });
}

function rGrpHdr(n: Node): GroupHeader {
  n.only("MsgId", "CreDtTm", "NbOfTxs", "SttlmInf");
  if (n.text("NbOfTxs") !== "1") n.issues.add(`${n.path}/NbOfTxs`, "must be 1 (one transaction per message)");
  const s = req(n.child("SttlmInf"), "SttlmInf", n).only("SttlmMtd");
  return { messageId: n.text("MsgId")!, creationDateTime: n.text("CreDtTm")!, settlementMethod: s.text("SttlmMtd") as SettlementMethod };
}

function rOrgnlGrp(n: Node): OriginalGroupInfo {
  n.only("OrgnlMsgId", "OrgnlMsgNmId", "OrgnlCreDtTm");
  return clean({ messageId: n.text("OrgnlMsgId")!, messageNameId: n.text("OrgnlMsgNmId")!, creationDateTime: n.text("OrgnlCreDtTm") });
}

function rReason<C extends string>(n: Node | undefined): ReasonInfo<C> | undefined {
  if (!n) return undefined;
  n.only("Orgtr", "Rsn", "AddtlInf");
  const o = n.child("Orgtr")?.only("Nm", "Id");
  const rsn = n.child("Rsn")?.only("Cd", "Prtry");
  const add = n.texts("AddtlInf");
  return clean({
    originator: o ? clean({ name: o.text("Nm"), anyBic: o.child("Id")?.only("OrgId").child("OrgId")?.only("AnyBIC").text("AnyBIC") }) : undefined,
    code: rsn?.text("Cd") as C | undefined,
    proprietary: rsn?.text("Prtry"),
    additionalInfo: add.length ? add : undefined,
  });
}

function rAssignment(n: Node): Assignment {
  n.only("Id", "Assgnr", "Assgne", "CreDtTm");
  return {
    id: n.text("Id")!,
    assigner: rAgent(req(n.child("Assgnr"), "Assgnr", n).only("Agt").child("Agt"))!,
    assignee: rAgent(req(n.child("Assgne"), "Assgne", n).only("Agt").child("Agt"))!,
    creationDateTime: n.text("CreDtTm")!,
  };
}

function rCase(n: Node | undefined): InvestigationCase | undefined {
  if (!n) return undefined;
  n.only("Id", "Cretr");
  return { id: n.text("Id")!, creator: rAgent(req(n.child("Cretr"), "Cretr", n).only("Agt").child("Agt"))! };
}

function rPartyOrAgent(n: Node): PartyOrAgent {
  n.only("Pty", "Agt");
  const pty = n.child("Pty");
  return pty ? { party: rParty(pty)! } : { agent: rAgent(n.child("Agt"))! };
}

/** Drop keys whose value is undefined, so parsed models compare equal to the ones that were written. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function readBody(kind: MessageKind, root: Node): IsoMessage {
  switch (kind) {
    case "pacs.008": {
      root.only("GrpHdr", "CdtTrfTxInf");
      const t = req(root.child("CdtTrfTxInf"), "CdtTrfTxInf", root);
      t.only(
        "PmtId", "PmtTpInf", "IntrBkSttlmAmt", "IntrBkSttlmDt", "InstdAmt", "XchgRate", "ChrgBr", "InstgAgt", "InstdAgt",
        "IntrmyAgt1", "UltmtDbtr", "Dbtr", "DbtrAcct", "DbtrAgt", "CdtrAgt", "Cdtr", "CdtrAcct", "UltmtCdtr", "Purp", "RmtInf",
      );
      const rmt = t.child("RmtInf")?.only("Ustrd", "Strd");
      const strd = rmt?.child("Strd")?.only("CdtrRefInf");
      const cri = strd?.child("CdtrRefInf")?.only("Tp", "Ref");
      if (cri && cri.child("Tp")?.only("CdOrPrtry").child("CdOrPrtry")?.only("Cd").text("Cd") !== "SCOR") {
        root.issues.add(`${cri.path}/Tp`, "must be CdOrPrtry/Cd SCOR");
      }
      return {
        kind,
        groupHeader: rGrpHdr(req(root.child("GrpHdr"), "GrpHdr", root)),
        tx: clean({
          paymentId: rPmtId(req(t.child("PmtId"), "PmtId", t)),
          paymentTypeInfo: rPmtTpInf(t.child("PmtTpInf")),
          interbankSettlementAmount: t.amount("IntrBkSttlmAmt")!,
          interbankSettlementDate: t.text("IntrBkSttlmDt")!,
          instructedAmount: t.amount("InstdAmt"),
          exchangeRate: t.text("XchgRate"),
          chargeBearer: t.text("ChrgBr") as ChargeBearer,
          instructingAgent: rAgent(t.child("InstgAgt"))!,
          instructedAgent: rAgent(t.child("InstdAgt"))!,
          intermediaryAgent1: rAgent(t.child("IntrmyAgt1")),
          ultimateDebtor: rParty(t.child("UltmtDbtr")),
          debtor: rParty(t.child("Dbtr"))!,
          debtorAccount: rAccount(t.child("DbtrAcct"))!,
          debtorAgent: rAgent(t.child("DbtrAgt"))!,
          creditorAgent: rAgent(t.child("CdtrAgt"))!,
          creditor: rParty(t.child("Cdtr"))!,
          creditorAccount: rAccount(t.child("CdtrAcct")),
          ultimateCreditor: rParty(t.child("UltmtCdtr")),
          purpose: t.child("Purp")?.only("Cd").text("Cd"),
          remittanceInformation: rmt ? clean({ unstructured: rmt.text("Ustrd"), creditorReference: cri?.text("Ref") }) : undefined,
        }),
      };
    }
    case "pacs.009": {
      root.only("GrpHdr", "CdtTrfTxInf");
      const t = req(root.child("CdtTrfTxInf"), "CdtTrfTxInf", root);
      t.only(
        "PmtId", "PmtTpInf", "IntrBkSttlmAmt", "IntrBkSttlmDt", "InstgAgt", "InstdAgt", "IntrmyAgt1", "Dbtr", "DbtrAcct",
        "DbtrAgt", "CdtrAgt", "Cdtr", "CdtrAcct", "RmtInf",
      );
      const rmt = t.child("RmtInf")?.only("Ustrd");
      return {
        kind,
        groupHeader: rGrpHdr(req(root.child("GrpHdr"), "GrpHdr", root)),
        tx: clean({
          paymentId: rPmtId(req(t.child("PmtId"), "PmtId", t)),
          paymentTypeInfo: rPmtTpInf(t.child("PmtTpInf")),
          interbankSettlementAmount: t.amount("IntrBkSttlmAmt")!,
          interbankSettlementDate: t.text("IntrBkSttlmDt")!,
          instructingAgent: rAgent(t.child("InstgAgt"))!,
          instructedAgent: rAgent(t.child("InstdAgt"))!,
          intermediaryAgent1: rAgent(t.child("IntrmyAgt1")),
          debtor: rAgent(t.child("Dbtr"))!,
          debtorAccount: rAccount(t.child("DbtrAcct")),
          debtorAgent: rAgent(t.child("DbtrAgt")),
          creditorAgent: rAgent(t.child("CdtrAgt")),
          creditor: rAgent(t.child("Cdtr"))!,
          creditorAccount: rAccount(t.child("CdtrAcct")),
          remittanceInformation: rmt ? { unstructured: rmt.text("Ustrd") } : undefined,
        }),
      };
    }
    case "pacs.002": {
      root.only("GrpHdr", "TxInfAndSts");
      const g = req(root.child("GrpHdr"), "GrpHdr", root).only("MsgId", "CreDtTm");
      const t = req(root.child("TxInfAndSts"), "TxInfAndSts", root);
      t.only(
        "StsId", "OrgnlGrpInf", "OrgnlInstrId", "OrgnlEndToEndId", "OrgnlTxId", "OrgnlUETR", "TxSts", "StsRsnInf",
        "AccptncDtTm", "InstgAgt", "InstdAgt",
      );
      const reasons = t.children("StsRsnInf").map((n) => rReason(n)!);
      return {
        kind,
        groupHeader: { messageId: g.text("MsgId")!, creationDateTime: g.text("CreDtTm")! },
        tx: clean({
          statusId: t.text("StsId"),
          originalGroupInfo: rOrgnlGrp(req(t.child("OrgnlGrpInf"), "OrgnlGrpInf", t)),
          originalInstructionId: t.text("OrgnlInstrId"),
          originalEndToEndId: t.text("OrgnlEndToEndId"),
          originalTxId: t.text("OrgnlTxId"),
          originalUetr: t.text("OrgnlUETR")!,
          status: t.text("TxSts") as TxStatus,
          statusReasons: reasons.length ? reasons : undefined,
          acceptanceDateTime: t.text("AccptncDtTm"),
          instructingAgent: rAgent(t.child("InstgAgt")),
          instructedAgent: rAgent(t.child("InstdAgt")),
        }),
      };
    }
    case "camt.056": {
      root.only("Assgnmt", "Undrlyg");
      const u = req(root.child("Undrlyg"), "Undrlyg", root).only("TxInf");
      const t = req(u.child("TxInf"), "TxInf", u);
      t.only(
        "CxlId", "Case", "OrgnlGrpInf", "OrgnlInstrId", "OrgnlEndToEndId", "OrgnlTxId", "OrgnlUETR", "OrgnlIntrBkSttlmAmt",
        "OrgnlIntrBkSttlmDt", "CxlRsnInf",
      );
      return {
        kind,
        assignment: rAssignment(req(root.child("Assgnmt"), "Assgnmt", root)),
        tx: clean({
          cancellationId: t.text("CxlId"),
          case: rCase(t.child("Case"))!,
          originalGroupInfo: rOrgnlGrp(req(t.child("OrgnlGrpInf"), "OrgnlGrpInf", t)),
          originalInstructionId: t.text("OrgnlInstrId"),
          originalEndToEndId: t.text("OrgnlEndToEndId"),
          originalTxId: t.text("OrgnlTxId"),
          originalUetr: t.text("OrgnlUETR")!,
          originalInterbankSettlementAmount: t.amount("OrgnlIntrBkSttlmAmt")!,
          originalInterbankSettlementDate: t.text("OrgnlIntrBkSttlmDt")!,
          reason: rReason<CancellationReason>(t.child("CxlRsnInf"))!,
        }),
      };
    }
    case "pacs.004": {
      root.only("GrpHdr", "TxInf");
      const t = req(root.child("TxInf"), "TxInf", root);
      t.only(
        "RtrId", "OrgnlGrpInf", "OrgnlInstrId", "OrgnlEndToEndId", "OrgnlTxId", "OrgnlUETR", "OrgnlIntrBkSttlmAmt",
        "OrgnlIntrBkSttlmDt", "RtrdIntrBkSttlmAmt", "IntrBkSttlmDt", "ChrgBr", "InstgAgt", "InstdAgt", "RtrChain", "RtrRsnInf",
      );
      const ch = req(t.child("RtrChain"), "RtrChain", t).only("Dbtr", "DbtrAgt", "CdtrAgt", "Cdtr");
      return {
        kind,
        groupHeader: rGrpHdr(req(root.child("GrpHdr"), "GrpHdr", root)),
        tx: clean({
          returnId: t.text("RtrId"),
          originalGroupInfo: rOrgnlGrp(req(t.child("OrgnlGrpInf"), "OrgnlGrpInf", t)),
          originalInstructionId: t.text("OrgnlInstrId"),
          originalEndToEndId: t.text("OrgnlEndToEndId"),
          originalTxId: t.text("OrgnlTxId"),
          originalUetr: t.text("OrgnlUETR")!,
          originalInterbankSettlementAmount: t.amount("OrgnlIntrBkSttlmAmt"),
          originalInterbankSettlementDate: t.text("OrgnlIntrBkSttlmDt"),
          returnedInterbankSettlementAmount: t.amount("RtrdIntrBkSttlmAmt")!,
          interbankSettlementDate: t.text("IntrBkSttlmDt")!,
          chargeBearer: t.text("ChrgBr") as ChargeBearer | undefined,
          instructingAgent: rAgent(t.child("InstgAgt"))!,
          instructedAgent: rAgent(t.child("InstdAgt"))!,
          returnChain: clean({
            debtor: rPartyOrAgent(req(ch.child("Dbtr"), "Dbtr", ch)),
            debtorAgent: rAgent(ch.child("DbtrAgt")),
            creditorAgent: rAgent(ch.child("CdtrAgt")),
            creditor: rPartyOrAgent(req(ch.child("Cdtr"), "Cdtr", ch)),
          }),
          reason: rReason<ReturnReason>(t.child("RtrRsnInf"))!,
        }),
      };
    }
    case "camt.029": {
      root.only("Assgnmt", "RslvdCase", "Sts", "CxlDtls");
      const d = req(root.child("CxlDtls"), "CxlDtls", root).only("TxInfAndSts");
      const t = req(d.child("TxInfAndSts"), "TxInfAndSts", d);
      t.only("CxlStsId", "OrgnlGrpInf", "OrgnlInstrId", "OrgnlEndToEndId", "OrgnlTxId", "OrgnlUETR", "TxCxlSts", "CxlStsRsnInf");
      return clean({
        kind,
        assignment: rAssignment(req(root.child("Assgnmt"), "Assgnmt", root)),
        resolvedCase: rCase(root.child("RslvdCase")),
        confirmation: req(root.child("Sts"), "Sts", root).only("Conf").text("Conf") as InvestigationConfirmation,
        tx: clean({
          cancellationStatusId: t.text("CxlStsId"),
          originalGroupInfo: rOrgnlGrp(req(t.child("OrgnlGrpInf"), "OrgnlGrpInf", t)),
          originalInstructionId: t.text("OrgnlInstrId"),
          originalEndToEndId: t.text("OrgnlEndToEndId"),
          originalTxId: t.text("OrgnlTxId"),
          originalUetr: t.text("OrgnlUETR")!,
          cancellationStatus: t.text("TxCxlSts") as TxCancellationStatus,
          reason: rReason(t.child("CxlStsRsnInf")),
        }),
      });
    }
  }
}

const KIND_BY_NAMESPACE = new Map<string, MessageKind>(
  (Object.keys(MESSAGE_DEFINITIONS) as MessageKind[]).map((k) => [namespaceOf(k), k]),
);

/**
 * Parse and validate an ISO 20022 message. The kind comes from the `Document` namespace; pass `expect` to require a
 * specific message. Throws `IsoValidationError` listing every problem found.
 */
export function fromXml(xml: string): IsoMessage;
export function fromXml<K extends MessageKind>(xml: string, expect: K): Extract<IsoMessage, { kind: K }>;
export function fromXml(xml: string, expect?: MessageKind): IsoMessage {
  const doc = parseDocument(xml);
  const kind = KIND_BY_NAMESPACE.get(doc.namespace);
  if (!kind) throw new IsoValidationError("XML", [`unsupported message definition ${doc.namespace}`]);
  if (expect && kind !== expect) throw new IsoValidationError("XML", [`expected ${MESSAGE_DEFINITIONS[expect]}, got ${MESSAGE_DEFINITIONS[kind]}`]);
  if (doc.root !== ROOT_ELEMENTS[kind]) {
    throw new IsoValidationError(MESSAGE_DEFINITIONS[kind], [`root element must be <${ROOT_ELEMENTS[kind]}>, got <${doc.root}>`]);
  }
  const issues = new Issues();
  const msg = readBody(kind, new Node(doc.body, ROOT_ELEMENTS[kind], issues));
  // Structural problems first; field validation only makes sense on a complete tree.
  issues.throwIfAny(MESSAGE_DEFINITIONS[kind]);
  const v = validateMessage(msg);
  if (v.length) throw new IsoValidationError(MESSAGE_DEFINITIONS[kind], v);
  return msg;
}
