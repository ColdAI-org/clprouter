/**
 * Code lists used by the ISO 20022 validators: ISO 3166-1 countries, ISO 4217 currencies (with minor units) and the
 * external code sets this module emits or accepts (status, status reason, cancellation and return reasons).
 */

/** ISO 3166-1 alpha-2, plus `XK` (Kosovo), which SWIFT and CBPR+ accept. */
export const COUNTRIES: ReadonlySet<string> = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
    "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
    "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
    "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
    "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
    "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK"
  ).split(" "),
);

/**
 * Active ISO 4217 currencies usable in payments, with their minor units (decimal places). Withdrawn codes (HRK, BGN
 * after Bulgaria joined the euro, ANG after the Caribbean guilder, SLL, CUC) and precious-metal / fund codes without
 * minor units are left out on purpose.
 */
export const CURRENCY_MINOR_UNITS: ReadonlyMap<string, number> = new Map(
  (
    "AED2 AFN2 ALL2 AMD2 AOA2 ARS2 AUD2 AWG2 AZN2 BAM2 BBD2 BDT2 BHD3 BIF0 BMD2 BND2 BOB2 BRL2 BSD2 BTN2 BWP2 BYN2 " +
    "BZD2 CAD2 CDF2 CHF2 CLF4 CLP0 CNY2 COP2 CRC2 CUP2 CVE2 CZK2 DJF0 DKK2 DOP2 DZD2 EGP2 ERN2 ETB2 EUR2 FJD2 FKP2 " +
    "GBP2 GEL2 GHS2 GIP2 GMD2 GNF0 GTQ2 GYD2 HKD2 HNL2 HTG2 HUF2 IDR2 ILS2 INR2 IQD3 IRR2 ISK0 JMD2 JOD3 JPY0 KES2 " +
    "KGS2 KHR2 KMF0 KPW2 KRW0 KWD3 KYD2 KZT2 LAK2 LBP2 LKR2 LRD2 LSL2 LYD3 MAD2 MDL2 MGA2 MKD2 MMK2 MNT2 MOP2 MRU2 " +
    "MUR2 MVR2 MWK2 MXN2 MYR2 MZN2 NAD2 NGN2 NIO2 NOK2 NPR2 NZD2 OMR3 PAB2 PEN2 PGK2 PHP2 PKR2 PLN2 PYG0 QAR2 RON2 " +
    "RSD2 RUB2 RWF0 SAR2 SBD2 SCR2 SDG2 SEK2 SGD2 SHP2 SLE2 SOS2 SRD2 SSP2 STN2 SVC2 SYP2 SZL2 THB2 TJS2 TMT2 TND3 " +
    "TOP2 TRY2 TTD2 TWD2 TZS2 UAH2 UGX0 USD2 UYU2 UYW4 UZS2 VED2 VES2 VND0 VUV0 WST2 XAF0 XCD2 XCG2 XOF0 XPF0 YER2 " +
    "ZAR2 ZMW2 ZWG2"
  )
    .split(" ")
    .map((s) => [s.slice(0, 3), Number(s.slice(3))] as const),
);

/** ExternalPaymentTransactionStatus1Code values this module accepts in pacs.002. */
export const TX_STATUS = ["ACCC", "ACCP", "ACSC", "ACSP", "ACTC", "ACWC", "ACWP", "BLCK", "PDNG", "RCVD", "RJCT"] as const;
export type TxStatus = (typeof TX_STATUS)[number];

/** Settlement methods allowed by CBPR+ (CLRG is not used cross-border). */
export const SETTLEMENT_METHODS = ["INDA", "INGA", "COVE"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

/** Charge bearer codes allowed by CBPR+ (SLEV is SEPA-only). */
export const CHARGE_BEARERS = ["DEBT", "CRED", "SHAR"] as const;
export type ChargeBearer = (typeof CHARGE_BEARERS)[number];

/** ExternalCancellationReason1Code values accepted in camt.056. */
export const CANCELLATION_REASONS = ["AGNT", "AM09", "COVR", "CURR", "CUST", "CUTA", "DUPL", "FRAD", "TECH", "UPAY"] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** ExternalReturnReason1Code values accepted in pacs.004. */
export const RETURN_REASONS = [
  "AC01", "AC03", "AC04", "AC06", "AG01", "AG02", "AM05", "AM09", "BE04", "CUST", "DUPL", "FOCR", "FR01", "MS02",
  "MS03", "NARR", "RC01", "RR01", "RR02", "RR03", "RR04", "TECH",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Reasons for rejecting a cancellation request in camt.029 (ExternalPaymentCancellationRejection1Code). */
export const CANCELLATION_REJECTIONS = ["AC04", "AGNT", "AM04", "ARDT", "ARPL", "CUST", "INDM", "LEGL", "NOAS", "NOOR", "PTNA", "RQDA"] as const;
export type CancellationRejection = (typeof CANCELLATION_REJECTIONS)[number];

/** camt.029 `Sts/Conf` (ExternalInvestigationExecutionConfirmation1Code) values this module emits or accepts. */
export const INVESTIGATION_CONFIRMATIONS = ["CNCL", "PDCR", "RJCR", "MODI", "IPAY", "INFO"] as const;
export type InvestigationConfirmation = (typeof INVESTIGATION_CONFIRMATIONS)[number];

/** camt.029 `TxCxlSts` (CancellationIndividualStatus1Code). */
export const TX_CANCELLATION_STATUS = ["ACCR", "PDCR", "RJCR"] as const;
export type TxCancellationStatus = (typeof TX_CANCELLATION_STATUS)[number];
