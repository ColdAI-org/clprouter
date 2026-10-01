/**
 * Field and message validation for the ISO 20022 filter: the schema rules (required elements, lengths, patterns,
 * code lists) plus the CBPR+ rules the spec asks for (structured postal addresses, BIC / LEI where the payment rules
 * ask for them, amount precision per currency, UETR mandatory).
 */
import {
  CANCELLATION_REASONS,
  CHARGE_BEARERS,
  COUNTRIES,
  CURRENCY_MINOR_UNITS,
  INVESTIGATION_CONFIRMATIONS,
  RETURN_REASONS,
  SETTLEMENT_METHODS,
  TX_CANCELLATION_STATUS,
  TX_STATUS,
} from "./codes.js";
import type {
  Amount,
  Assignment,
  CashAccount,
  FinancialInstitution,
  GenericIdentification,
  InvestigationCase,
  IsoMessage,
  OriginalGroupInfo,
  Party,
  PartyOrAgent,
  PaymentId,
  PaymentTypeInfo,
  PostalAddress,
  ReasonInfo,
} from "./model.js";
import { MESSAGE_DEFINITIONS } from "./model.js";
import { isUetr } from "./uetr.js";

export class IsoValidationError extends Error {
  constructor(
    readonly subject: string,
    readonly issues: readonly string[],
  ) {
    super(`${subject} is not valid ISO 20022 / CBPR+:\n  - ${issues.join("\n  - ")}`);
    this.name = "IsoValidationError";
  }
}

/** Collects every problem instead of stopping at the first, so a caller sees all of them at once. */
export class Issues {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    this.list.push(`${path}: ${msg}`);
  }
  get ok(): boolean {
    return this.list.length === 0;
  }
  throwIfAny(subject: string): void {
    if (this.list.length > 0) throw new IsoValidationError(subject, this.list);
  }
}

// ── Patterns ────────────────────────────────────────────────────────────────

/** ISO 9362 BIC (`BICFIDec2014Identifier` / `AnyBICDec2014Identifier`). */
const BIC = /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
/** ISO 17442 LEI shape; the check digits are verified separately. */
const LEI = /^[A-Z0-9]{18}[0-9]{2}$/;
const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/;
/** CBPR+ ISODateTime: offset or Z required, at most milliseconds. */
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** SWIFT FIN-X character set used by CBPR+ for references (MsgId, InstrId, EndToEndId, ...). */
const FIN_X = /^[0-9A-Za-z/\-?:().,'+ ]+$/;
const CODE4 = /^[A-Z0-9]{1,4}$/;
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
/** Control characters and unpaired surrogates are never valid in ISO 20022 text. */
// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udfff]/u;

/** ISO 7064 MOD 97-10, shared by IBAN and LEI. */
function mod97(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

export function isBic(s: string): boolean {
  return BIC.test(s) && COUNTRIES.has(s.slice(4, 6));
}

export function isLei(s: string): boolean {
  return LEI.test(s) && mod97(s) === 1;
}

export function isIban(s: string): boolean {
  if (!IBAN.test(s) || !COUNTRIES.has(s.slice(0, 2))) return false;
  return mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

export function isCountry(s: string): boolean {
  return COUNTRIES.has(s);
}

export function isCurrency(s: string): boolean {
  return CURRENCY_MINOR_UNITS.has(s);
}

export function isIsoDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isIsoDateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  return m !== null && isIsoDate(m[1]!) && !Number.isNaN(new Date(s).getTime());
}

/** CBPR+ `CBPR_DateTime` from a JS date, in UTC with millisecond precision. */
export function isoDateTime(d: Date): string {
  return d.toISOString();
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Amount rules (`ActiveCurrencyAndAmount` + CBPR+): a positive decimal, at most 14 digits in total (CBPR+, so it
 * fits an MT 15d amount), at most 5 fraction digits (schema) and no more than the currency's minor units (CBPR+).
 */
export function amountProblems(a: Amount): string[] {
  const out: string[] = [];
  const minor = CURRENCY_MINOR_UNITS.get(a.currency);
  if (minor === undefined) out.push(`unknown or withdrawn currency "${a.currency}"`);
  if (typeof a.value !== "string" || !DECIMAL.test(a.value)) {
    out.push(`amount "${a.value}" is not a plain decimal`);
    return out;
  }
  const [int, frac = ""] = a.value.split(".");
  if (frac.length > 5) out.push("amount has more than 5 fraction digits");
  if (minor !== undefined && frac.length > minor) out.push(`${a.currency} allows ${minor} decimal places, got ${frac.length}`);
  if (int!.replace(/^0+/, "").length + frac.length > 14) out.push("amount has more than 14 digits");
  if (!/[1-9]/.test(a.value)) out.push("amount must be greater than zero");
  return out;
}

// ── Field checkers ──────────────────────────────────────────────────────────

type Opt = { required?: boolean };

export class Checker {
  constructor(readonly issues: Issues) {}

  private present(v: unknown, path: string, o: Opt): v is string {
    if (v === undefined || v === null) {
      if (o.required) this.issues.add(path, "is required");
      return false;
    }
    if (typeof v !== "string") {
      this.issues.add(path, "must be text");
      return false;
    }
    return true;
  }

  /** `MaxNText`: 1..n characters, no control characters, no leading or trailing blanks. */
  text(v: string | undefined, path: string, max: number, o: Opt = {}): void {
    if (!this.present(v, path, o)) return;
    if (v.length === 0) this.issues.add(path, "must not be empty");
    else if ([...v].length > max) this.issues.add(path, `longer than ${max} characters`);
    if (BAD_TEXT.test(v)) this.issues.add(path, "contains control characters");
    if (v !== v.trim()) this.issues.add(path, "has leading or trailing blanks");
  }

  /** CBPR+ reference (`CBPR_RestrictedFINXMax35Text`): FIN-X, no leading/trailing `/`, no `//`. */
  ref(v: string | undefined, path: string, o: Opt = {}): void {
    if (!this.present(v, path, o)) return;
    if (v.length === 0 || v.length > 35) this.issues.add(path, "must be 1 to 35 characters");
    if (!FIN_X.test(v)) this.issues.add(path, "has characters outside the FIN-X set");
    if (v.startsWith("/") || v.endsWith("/") || v.includes("//")) this.issues.add(path, "must not start or end with / or contain //");
  }

  code(v: string | undefined, path: string, allowed: readonly string[] | RegExp, o: Opt = {}): void {
    if (!this.present(v, path, o)) return;
    const ok = Array.isArray(allowed) ? allowed.includes(v) : (allowed as RegExp).test(v);
    if (!ok) this.issues.add(path, `"${v}" is not an allowed code`);
  }

  bic(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isBic(v)) this.issues.add(path, `"${v}" is not a valid BIC`);
  }

  lei(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isLei(v)) this.issues.add(path, `"${v}" is not a valid LEI (ISO 17442 check digits)`);
  }

  country(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isCountry(v)) this.issues.add(path, `"${v}" is not an ISO 3166 country code`);
  }

  currency(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isCurrency(v)) this.issues.add(path, `"${v}" is not an active ISO 4217 currency`);
  }

  date(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isIsoDate(v)) this.issues.add(path, `"${v}" is not an ISODate`);
  }

  dateTime(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isIsoDateTime(v)) {
      this.issues.add(path, `"${v}" is not an ISODateTime with a UTC offset`);
    }
  }

  uetr(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && !isUetr(v)) this.issues.add(path, `"${v}" is not a UUIDv4 UETR`);
  }

  amount(a: Amount | undefined, path: string, o: Opt = {}): void {
    if (!a) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    for (const p of amountProblems(a)) this.issues.add(path, p);
  }

  decimal(v: string | undefined, path: string, o: Opt = {}): void {
    if (this.present(v, path, o) && (!DECIMAL.test(v) || v.replace(".", "").length > 11)) {
      this.issues.add(path, `"${v}" is not a valid rate`);
    }
  }

  postalAddress(a: PostalAddress | undefined, path: string, o: Opt = {}): void {
    if (!a) {
      if (o.required) this.issues.add(path, "is required (structured address)");
      return;
    }
    const t = (v: string | undefined, name: string, max: number, required = false) =>
      this.text(v, `${path}/${name}`, max, { required });
    t(a.department, "Dept", 70);
    t(a.subDepartment, "SubDept", 70);
    t(a.streetName, "StrtNm", 70);
    t(a.buildingNumber, "BldgNb", 16);
    t(a.buildingName, "BldgNm", 35);
    t(a.floor, "Flr", 70);
    t(a.postBox, "PstBx", 16);
    t(a.room, "Room", 70);
    t(a.postCode, "PstCd", 16);
    t(a.townName, "TwnNm", 35, true);
    t(a.townLocationName, "TwnLctnNm", 35);
    t(a.districtName, "DstrctNm", 35);
    t(a.countrySubDivision, "CtrySubDvsn", 35);
    this.country(a.country, `${path}/Ctry`, { required: true });
  }

  /**
   * Agent identification. With `requireBic` the BICFI is mandatory (CBPR+ instructing / instructed agents and the FI
   * parties of pacs.009). Otherwise CBPR+ asks for a BICFI, a clearing system member id, or a name with a structured
   * address.
   */
  agent(fi: FinancialInstitution | undefined, path: string, o: Opt & { requireBic?: boolean } = {}): void {
    if (!fi) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    this.bic(fi.bicfi, `${path}/FinInstnId/BICFI`, { required: o.requireBic });
    if (fi.clearingSystemMemberId) {
      this.code(fi.clearingSystemMemberId.code, `${path}/FinInstnId/ClrSysMmbId/ClrSysId/Cd`, /^[A-Z]{5}$/, { required: true });
      this.text(fi.clearingSystemMemberId.memberId, `${path}/FinInstnId/ClrSysMmbId/MmbId`, 35, { required: true });
    }
    this.lei(fi.lei, `${path}/FinInstnId/LEI`);
    this.text(fi.name, `${path}/FinInstnId/Nm`, 140);
    this.postalAddress(fi.postalAddress, `${path}/FinInstnId/PstlAdr`);
    if (!fi.bicfi && !fi.clearingSystemMemberId && !(fi.name && fi.postalAddress)) {
      this.issues.add(`${path}/FinInstnId`, "needs a BICFI, a clearing system member id, or a name and structured address");
    }
    if (fi.name && !fi.bicfi && !fi.postalAddress) this.issues.add(`${path}/FinInstnId`, "a name without a BICFI needs a structured address");
  }

  private genericId(g: GenericIdentification, path: string): void {
    this.text(g.id, `${path}/Id`, 35, { required: true });
    this.code(g.schemeCode, `${path}/SchmeNm/Cd`, CODE4);
    this.text(g.schemeProprietary, `${path}/SchmeNm/Prtry`, 35);
    if (g.schemeCode && g.schemeProprietary) this.issues.add(`${path}/SchmeNm`, "Cd and Prtry are exclusive");
    this.text(g.issuer, `${path}/Issr`, 35);
  }

  /**
   * Party identification. `requireName` + `requireAddressOrId` together implement the travel-rule minimum for the
   * originator (name and an address or identifier).
   */
  party(p: Party | undefined, path: string, o: Opt & { requireName?: boolean; requireAddressOrId?: boolean } = {}): void {
    if (!p) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    this.text(p.name, `${path}/Nm`, 140, { required: o.requireName });
    this.postalAddress(p.postalAddress, `${path}/PstlAdr`);
    if (p.organisationId && p.privateId) this.issues.add(`${path}/Id`, "OrgId and PrvtId are exclusive");
    if (p.organisationId) {
      this.bic(p.organisationId.anyBic, `${path}/Id/OrgId/AnyBIC`);
      this.lei(p.organisationId.lei, `${path}/Id/OrgId/LEI`);
      (p.organisationId.other ?? []).forEach((g, i) => this.genericId(g, `${path}/Id/OrgId/Othr[${i}]`));
    }
    if (p.privateId) {
      const b = p.privateId.dateAndPlaceOfBirth;
      if (b) {
        this.date(b.birthDate, `${path}/Id/PrvtId/DtAndPlcOfBirth/BirthDt`, { required: true });
        this.text(b.provinceOfBirth, `${path}/Id/PrvtId/DtAndPlcOfBirth/PrvcOfBirth`, 35);
        this.text(b.cityOfBirth, `${path}/Id/PrvtId/DtAndPlcOfBirth/CityOfBirth`, 35, { required: true });
        this.country(b.countryOfBirth, `${path}/Id/PrvtId/DtAndPlcOfBirth/CtryOfBirth`, { required: true });
      }
      (p.privateId.other ?? []).forEach((g, i) => this.genericId(g, `${path}/Id/PrvtId/Othr[${i}]`));
    }
    this.country(p.countryOfResidence, `${path}/CtryOfRes`);
    const hasId =
      !!p.organisationId?.anyBic ||
      !!p.organisationId?.lei ||
      (p.organisationId?.other?.length ?? 0) > 0 ||
      !!p.privateId?.dateAndPlaceOfBirth ||
      (p.privateId?.other?.length ?? 0) > 0;
    if (!p.name && !hasId) this.issues.add(path, "needs a name or an identification");
    if (o.requireAddressOrId && !p.postalAddress && !hasId) {
      this.issues.add(path, "needs a structured postal address or an identification (travel rule)");
    }
  }

  account(a: CashAccount | undefined, path: string, o: Opt = {}): void {
    if (!a) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    if (!!a.iban === !!a.other) this.issues.add(`${path}/Id`, "needs exactly one of IBAN and Othr");
    if (a.iban !== undefined && !isIban(a.iban)) this.issues.add(`${path}/Id/IBAN`, `"${a.iban}" is not a valid IBAN`);
    if (a.other) this.genericId(a.other, `${path}/Id/Othr`);
    this.currency(a.currency, `${path}/Ccy`);
    this.text(a.name, `${path}/Nm`, 70);
  }

  paymentId(p: PaymentId | undefined, path: string): void {
    if (!p) return void this.issues.add(path, "is required");
    this.ref(p.instructionId, `${path}/InstrId`);
    this.ref(p.endToEndId, `${path}/EndToEndId`, { required: true });
    this.ref(p.transactionId, `${path}/TxId`);
    this.uetr(p.uetr, `${path}/UETR`, { required: true });
  }

  paymentTypeInfo(p: PaymentTypeInfo | undefined, path: string): void {
    if (!p) return;
    this.code(p.instructionPriority, `${path}/InstrPrty`, ["HIGH", "NORM"]);
    (p.serviceLevel ?? []).forEach((s, i) => this.code(s, `${path}/SvcLvl[${i}]/Cd`, CODE4));
    if ((p.serviceLevel?.length ?? 0) > 3) this.issues.add(`${path}/SvcLvl`, "at most 3 occurrences");
    this.text(p.localInstrument, `${path}/LclInstrm/Prtry`, 35);
    this.code(p.categoryPurpose, `${path}/CtgyPurp/Cd`, CODE4);
  }

  originalGroup(g: OriginalGroupInfo | undefined, path: string): void {
    if (!g) return void this.issues.add(path, "is required");
    this.ref(g.messageId, `${path}/OrgnlMsgId`, { required: true });
    this.code(g.messageNameId, `${path}/OrgnlMsgNmId`, /^[a-z]{4}\.\d{3}\.\d{3}\.\d{2}$/, { required: true });
    this.dateTime(g.creationDateTime, `${path}/OrgnlCreDtTm`);
  }

  reason(r: ReasonInfo | undefined, path: string, codes: readonly string[] | RegExp, o: Opt = {}): void {
    if (!r) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    if (r.originator) {
      this.text(r.originator.name, `${path}/Orgtr/Nm`, 140);
      this.bic(r.originator.anyBic, `${path}/Orgtr/Id/OrgId/AnyBIC`);
      if (!r.originator.name && !r.originator.anyBic) this.issues.add(`${path}/Orgtr`, "needs a name or AnyBIC");
    }
    if (!!r.code === !!r.proprietary) this.issues.add(`${path}/Rsn`, "needs exactly one of Cd and Prtry");
    this.code(r.code, `${path}/Rsn/Cd`, codes);
    this.text(r.proprietary, `${path}/Rsn/Prtry`, 35);
    (r.additionalInfo ?? []).forEach((s, i) => this.text(s, `${path}/AddtlInf[${i}]`, 105));
    if ((r.additionalInfo?.length ?? 0) > 2) this.issues.add(`${path}/AddtlInf`, "CBPR+ allows at most 2 occurrences");
  }

  assignment(a: Assignment | undefined, path: string): void {
    if (!a) return void this.issues.add(path, "is required");
    this.ref(a.id, `${path}/Id`, { required: true });
    this.agent(a.assigner, `${path}/Assgnr/Agt`, { required: true, requireBic: true });
    this.agent(a.assignee, `${path}/Assgne/Agt`, { required: true, requireBic: true });
    this.dateTime(a.creationDateTime, `${path}/CreDtTm`, { required: true });
  }

  investigationCase(c: InvestigationCase | undefined, path: string, o: Opt = {}): void {
    if (!c) {
      if (o.required) this.issues.add(path, "is required");
      return;
    }
    this.ref(c.id, `${path}/Id`, { required: true });
    this.agent(c.creator, `${path}/Cretr/Agt`, { required: true, requireBic: true });
  }

  partyOrAgent(p: PartyOrAgent | undefined, path: string): void {
    if (!p) return void this.issues.add(path, "is required");
    if (!!p.party === !!p.agent) return void this.issues.add(path, "needs exactly one of Pty and Agt");
    if (p.party) this.party(p.party, `${path}/Pty`, { required: true, requireName: true });
    else this.agent(p.agent, `${path}/Agt`, { required: true });
  }
}

const RJCT_CODE = /^[A-Z0-9]{4}$/;

/** Validate a message model. Returns the issues; `assertValidMessage` throws instead. */
export function validateMessage(m: IsoMessage): string[] {
  const issues = new Issues();
  const c = new Checker(issues);
  switch (m.kind) {
    case "pacs.008": {
      const g = m.groupHeader;
      c.ref(g?.messageId, "GrpHdr/MsgId", { required: true });
      c.dateTime(g?.creationDateTime, "GrpHdr/CreDtTm", { required: true });
      c.code(g?.settlementMethod, "GrpHdr/SttlmInf/SttlmMtd", SETTLEMENT_METHODS, { required: true });
      const t = m.tx;
      const p = "CdtTrfTxInf";
      c.paymentId(t.paymentId, `${p}/PmtId`);
      c.paymentTypeInfo(t.paymentTypeInfo, `${p}/PmtTpInf`);
      c.amount(t.interbankSettlementAmount, `${p}/IntrBkSttlmAmt`, { required: true });
      c.date(t.interbankSettlementDate, `${p}/IntrBkSttlmDt`, { required: true });
      c.amount(t.instructedAmount, `${p}/InstdAmt`);
      c.decimal(t.exchangeRate, `${p}/XchgRate`);
      if (t.instructedAmount && t.interbankSettlementAmount && t.instructedAmount.currency !== t.interbankSettlementAmount.currency && !t.exchangeRate) {
        issues.add(`${p}/XchgRate`, "is required when InstdAmt and IntrBkSttlmAmt currencies differ");
      }
      c.code(t.chargeBearer, `${p}/ChrgBr`, CHARGE_BEARERS, { required: true });
      c.agent(t.instructingAgent, `${p}/InstgAgt`, { required: true, requireBic: true });
      c.agent(t.instructedAgent, `${p}/InstdAgt`, { required: true, requireBic: true });
      c.agent(t.intermediaryAgent1, `${p}/IntrmyAgt1`);
      c.party(t.ultimateDebtor, `${p}/UltmtDbtr`);
      c.party(t.debtor, `${p}/Dbtr`, { required: true, requireName: true, requireAddressOrId: true });
      c.account(t.debtorAccount, `${p}/DbtrAcct`, { required: true });
      c.agent(t.debtorAgent, `${p}/DbtrAgt`, { required: true });
      c.agent(t.creditorAgent, `${p}/CdtrAgt`, { required: true });
      c.party(t.creditor, `${p}/Cdtr`, { required: true, requireName: true });
      c.account(t.creditorAccount, `${p}/CdtrAcct`);
      c.party(t.ultimateCreditor, `${p}/UltmtCdtr`);
      c.code(t.purpose, `${p}/Purp/Cd`, CODE4);
      const r = t.remittanceInformation;
      if (r) {
        c.text(r.unstructured, `${p}/RmtInf/Ustrd`, 140);
        c.text(r.creditorReference, `${p}/RmtInf/Strd/CdtrRefInf/Ref`, 35);
        if (r.unstructured && r.creditorReference) issues.add(`${p}/RmtInf`, "CBPR+ allows Ustrd or Strd, not both");
        if (!r.unstructured && !r.creditorReference) issues.add(`${p}/RmtInf`, "is empty");
      }
      break;
    }
    case "pacs.009": {
      const g = m.groupHeader;
      c.ref(g?.messageId, "GrpHdr/MsgId", { required: true });
      c.dateTime(g?.creationDateTime, "GrpHdr/CreDtTm", { required: true });
      c.code(g?.settlementMethod, "GrpHdr/SttlmInf/SttlmMtd", SETTLEMENT_METHODS, { required: true });
      const t = m.tx;
      const p = "CdtTrfTxInf";
      c.paymentId(t.paymentId, `${p}/PmtId`);
      c.paymentTypeInfo(t.paymentTypeInfo, `${p}/PmtTpInf`);
      c.amount(t.interbankSettlementAmount, `${p}/IntrBkSttlmAmt`, { required: true });
      c.date(t.interbankSettlementDate, `${p}/IntrBkSttlmDt`, { required: true });
      c.agent(t.instructingAgent, `${p}/InstgAgt`, { required: true, requireBic: true });
      c.agent(t.instructedAgent, `${p}/InstdAgt`, { required: true, requireBic: true });
      c.agent(t.intermediaryAgent1, `${p}/IntrmyAgt1`);
      c.agent(t.debtor, `${p}/Dbtr`, { required: true, requireBic: true });
      c.account(t.debtorAccount, `${p}/DbtrAcct`);
      c.agent(t.debtorAgent, `${p}/DbtrAgt`);
      c.agent(t.creditorAgent, `${p}/CdtrAgt`);
      c.agent(t.creditor, `${p}/Cdtr`, { required: true, requireBic: true });
      c.account(t.creditorAccount, `${p}/CdtrAcct`);
      c.text(t.remittanceInformation?.unstructured, `${p}/RmtInf/Ustrd`, 140, { required: !!t.remittanceInformation });
      break;
    }
    case "pacs.002": {
      c.ref(m.groupHeader?.messageId, "GrpHdr/MsgId", { required: true });
      c.dateTime(m.groupHeader?.creationDateTime, "GrpHdr/CreDtTm", { required: true });
      const t = m.tx;
      const p = "TxInfAndSts";
      c.ref(t.statusId, `${p}/StsId`);
      c.originalGroup(t.originalGroupInfo, `${p}/OrgnlGrpInf`);
      c.ref(t.originalInstructionId, `${p}/OrgnlInstrId`);
      c.ref(t.originalEndToEndId, `${p}/OrgnlEndToEndId`);
      c.ref(t.originalTxId, `${p}/OrgnlTxId`);
      c.uetr(t.originalUetr, `${p}/OrgnlUETR`, { required: true });
      c.code(t.status, `${p}/TxSts`, TX_STATUS, { required: true });
      (t.statusReasons ?? []).forEach((r, i) => c.reason(r, `${p}/StsRsnInf[${i}]`, RJCT_CODE));
      if (t.status === "RJCT" && !(t.statusReasons?.length)) issues.add(`${p}/StsRsnInf`, "is required when TxSts is RJCT");
      c.dateTime(t.acceptanceDateTime, `${p}/AccptncDtTm`);
      c.agent(t.instructingAgent, `${p}/InstgAgt`, { requireBic: true });
      c.agent(t.instructedAgent, `${p}/InstdAgt`, { requireBic: true });
      break;
    }
    case "camt.056": {
      c.assignment(m.assignment, "Assgnmt");
      const t = m.tx;
      const p = "Undrlyg/TxInf";
      c.ref(t.cancellationId, `${p}/CxlId`);
      c.investigationCase(t.case, `${p}/Case`, { required: true });
      c.originalGroup(t.originalGroupInfo, `${p}/OrgnlGrpInf`);
      c.ref(t.originalInstructionId, `${p}/OrgnlInstrId`);
      c.ref(t.originalEndToEndId, `${p}/OrgnlEndToEndId`);
      c.ref(t.originalTxId, `${p}/OrgnlTxId`);
      c.uetr(t.originalUetr, `${p}/OrgnlUETR`, { required: true });
      c.amount(t.originalInterbankSettlementAmount, `${p}/OrgnlIntrBkSttlmAmt`, { required: true });
      c.date(t.originalInterbankSettlementDate, `${p}/OrgnlIntrBkSttlmDt`, { required: true });
      c.reason(t.reason, `${p}/CxlRsnInf`, CANCELLATION_REASONS, { required: true });
      break;
    }
    case "pacs.004": {
      const g = m.groupHeader;
      c.ref(g?.messageId, "GrpHdr/MsgId", { required: true });
      c.dateTime(g?.creationDateTime, "GrpHdr/CreDtTm", { required: true });
      c.code(g?.settlementMethod, "GrpHdr/SttlmInf/SttlmMtd", SETTLEMENT_METHODS, { required: true });
      const t = m.tx;
      const p = "TxInf";
      c.ref(t.returnId, `${p}/RtrId`);
      c.originalGroup(t.originalGroupInfo, `${p}/OrgnlGrpInf`);
      c.ref(t.originalInstructionId, `${p}/OrgnlInstrId`);
      c.ref(t.originalEndToEndId, `${p}/OrgnlEndToEndId`);
      c.ref(t.originalTxId, `${p}/OrgnlTxId`);
      c.uetr(t.originalUetr, `${p}/OrgnlUETR`, { required: true });
      c.amount(t.originalInterbankSettlementAmount, `${p}/OrgnlIntrBkSttlmAmt`);
      c.date(t.originalInterbankSettlementDate, `${p}/OrgnlIntrBkSttlmDt`);
      c.amount(t.returnedInterbankSettlementAmount, `${p}/RtrdIntrBkSttlmAmt`, { required: true });
      c.date(t.interbankSettlementDate, `${p}/IntrBkSttlmDt`, { required: true });
      c.code(t.chargeBearer, `${p}/ChrgBr`, CHARGE_BEARERS);
      c.agent(t.instructingAgent, `${p}/InstgAgt`, { required: true, requireBic: true });
      c.agent(t.instructedAgent, `${p}/InstdAgt`, { required: true, requireBic: true });
      if (!t.returnChain) issues.add(`${p}/RtrChain`, "is required");
      else {
        c.partyOrAgent(t.returnChain.debtor, `${p}/RtrChain/Dbtr`);
        c.agent(t.returnChain.debtorAgent, `${p}/RtrChain/DbtrAgt`);
        c.agent(t.returnChain.creditorAgent, `${p}/RtrChain/CdtrAgt`);
        c.partyOrAgent(t.returnChain.creditor, `${p}/RtrChain/Cdtr`);
      }
      c.reason(t.reason, `${p}/RtrRsnInf`, RETURN_REASONS, { required: true });
      const o = t.originalInterbankSettlementAmount;
      const r = t.returnedInterbankSettlementAmount;
      if (o && r && o.currency === r.currency && DECIMAL.test(o.value) && DECIMAL.test(r.value) && Number(r.value) > Number(o.value)) {
        issues.add(`${p}/RtrdIntrBkSttlmAmt`, "exceeds the original interbank settlement amount");
      }
      break;
    }
    case "camt.029": {
      c.assignment(m.assignment, "Assgnmt");
      c.investigationCase(m.resolvedCase, "RslvdCase");
      c.code(m.confirmation, "Sts/Conf", INVESTIGATION_CONFIRMATIONS, { required: true });
      const t = m.tx;
      const p = "CxlDtls/TxInfAndSts";
      c.ref(t.cancellationStatusId, `${p}/CxlStsId`);
      c.originalGroup(t.originalGroupInfo, `${p}/OrgnlGrpInf`);
      c.ref(t.originalInstructionId, `${p}/OrgnlInstrId`);
      c.ref(t.originalEndToEndId, `${p}/OrgnlEndToEndId`);
      c.ref(t.originalTxId, `${p}/OrgnlTxId`);
      c.uetr(t.originalUetr, `${p}/OrgnlUETR`, { required: true });
      c.code(t.cancellationStatus, `${p}/TxCxlSts`, TX_CANCELLATION_STATUS, { required: true });
      c.reason(t.reason, `${p}/CxlStsRsnInf`, RJCT_CODE);
      if (t.cancellationStatus === "RJCR" && !t.reason) issues.add(`${p}/CxlStsRsnInf`, "is required when the cancellation is rejected");
      if (m.confirmation === "CNCL" && t.cancellationStatus !== "ACCR") issues.add(`${p}/TxCxlSts`, "must be ACCR when Sts/Conf is CNCL");
      if (m.confirmation === "RJCR" && t.cancellationStatus !== "RJCR") issues.add(`${p}/TxCxlSts`, "must be RJCR when Sts/Conf is RJCR");
      break;
    }
    default:
      issues.add("message", `unknown kind ${(m as { kind?: string }).kind}`);
  }
  return issues.list;
}

export function assertValidMessage(m: IsoMessage): void {
  const list = validateMessage(m);
  if (list.length > 0) throw new IsoValidationError(MESSAGE_DEFINITIONS[m.kind] ?? "message", list);
}
