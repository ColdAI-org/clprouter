/**
 * Envelope binding for ISO 20022 payments (spec "ISO 20022 filter" → "No personal data in the clear").
 *
 * CLPR gives integrity but no confidentiality: the envelope payload sits in plaintext on every ledger it crosses. So
 * under the filter the payload is a small protobuf header, `ClprIsoPayload`, holding only:
 *
 * | # | Field | Clear content |
 * | --- | --- | --- |
 * | 1 | `version` | 1 |
 * | 2 | `message_definition` | e.g. `pacs.008.001.08` |
 * | 3 | `uetr` | 16 bytes; equals the envelope `iso_uetr` |
 * | 4 | `original_uetr` | 16 bytes; set for camt.056 / pacs.004 / camt.029 / pacs.002 (the payment they refer to) |
 * | 5, 6 | `amount`, `currency` | the interbank amount, e.g. `"1250.00"`, `"EUR"` |
 * | 7 | `message_commitment` | keccak256(domain ‖ salt ‖ XML) |
 * | 8 | `travel_rule_commitment` | keccak256(domain ‖ salt ‖ canonical travel-rule JSON) |
 * | 9 | `delivery` | 1 = encrypted in the envelope, 2 = delivered off-chain between endpoints |
 * | 10 | `recipient_key_id` | sha256 of the destination institution's X25519 key (encrypted only) |
 * | 11–13 | `ephemeral_public_key`, `nonce`, `ciphertext` | the sealed message (encrypted only) |
 *
 * The 32-byte random salt makes the commitments hiding: knowing the UETR, amount and a guess of the debtor's name is
 * not enough to confirm the guess against the on-chain hash. The salt travels only inside the ciphertext (or the
 * off-chain delivery). Fields 1–10 are the AEAD's associated data, so changing any clear field breaks decryption.
 */
import type { Hex } from "viem";
import { bytesToHex, hexToBytes, isHex, keccak256 } from "viem";
import type { BuildEnvelopeInput, ClprRouteEnvelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { ProtoWriter, fieldString, readFields } from "../proto.js";
import { institutionKeyId, open, publicKeyOf, seal, toBytes } from "./crypto.js";
import { fromXml, toXml } from "./messages.js";
import type { Amount, CashAccount, FinancialInstitution, IsoMessage, MessageDefinition, Party, PartyOrAgent } from "./model.js";
import { MESSAGE_DEFINITIONS } from "./model.js";
import { generateUetr, isUetr, bytesToUetr16, uetrToBytes } from "./uetr.js";
import { amountProblems } from "./validate.js";

export const ISO_PAYLOAD_VERSION = 1;
const MSG_DOMAIN = "clprouter/iso20022/v1 message";
const TR_DOMAIN = "clprouter/iso20022/v1 travel-rule";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export type IsoDelivery = "encrypted" | "off-chain";

/** Clear header carried as the envelope payload. Hex fields are 0x-prefixed. */
export interface IsoPayloadHeader {
  version: number;
  messageDefinition: MessageDefinition;
  uetr: string;
  originalUetr?: string;
  amount?: Amount;
  messageCommitment: Hex;
  travelRuleCommitment: Hex;
  delivery: IsoDelivery;
  recipientKeyId?: Hex;
  ephemeralPublicKey?: Hex;
  nonce?: Hex;
  ciphertext?: Hex;
}

/** Originator / beneficiary data required by the travel rule (FATF R.16, EU TFR). Always carried encrypted. */
export interface TravelRuleParticipant {
  party?: Party;
  institution?: FinancialInstitution;
  account?: CashAccount;
}

export interface TravelRuleData {
  originator: TravelRuleParticipant;
  beneficiary: TravelRuleParticipant;
  originatorAgent?: FinancialInstitution;
  beneficiaryAgent?: FinancialInstitution;
}

/** What the sending endpoint hands the receiving endpoint off-chain when `delivery` is `off-chain`. */
export interface OffChainDelivery {
  xml: string;
  salt: Hex;
  travelRule: string;
}

export interface IsoBindInput {
  message: IsoMessage | string;
  /** Default `encrypted`. */
  delivery?: IsoDelivery;
  /** Destination institution's X25519 public key (required for `encrypted`). */
  recipientPublicKey?: Uint8Array | Hex;
  /** Defaults to the data derived from the message; `null` for none. */
  travelRule?: TravelRuleData | null;
  /**
   * The route's UETR (envelope `iso_uetr`). For pacs.008 / pacs.009 it must be (and defaults to) the payment's own
   * UETR. Other messages travel as new routes with a fresh UETR unless one is given, and carry the payment's as
   * `original_uetr`.
   */
  routeUetr?: string;
  /** Deterministic inputs, for tests only. */
  salt?: Uint8Array;
  ephemeralSecretKey?: Uint8Array;
  nonce?: Uint8Array;
}

export interface IsoBinding {
  header: IsoPayloadHeader;
  /** Encoded header: the envelope `payload`. */
  payload: Hex;
  /** 16-byte UETR for the envelope's `iso_uetr` (the route id itself is derived by the origin Router). */
  isoUetr: Hex;
  message: IsoMessage;
  xml: string;
  travelRule: TravelRuleData | null;
  /** Set for `off-chain` delivery: send this to the destination endpoint, never on-chain. */
  offChain?: OffChainDelivery;
}

export interface OpenedIsoPayment {
  header: IsoPayloadHeader;
  xml: string;
  message: IsoMessage;
  travelRule: TravelRuleData | null;
}

// ── Facts and travel rule ───────────────────────────────────────────────────

/** The clear facts of a message: its own UETR (payments), the UETR it refers to, and its interbank amount. */
export function messageFacts(m: IsoMessage): { uetr?: string; originalUetr?: string; amount?: Amount } {
  switch (m.kind) {
    case "pacs.008":
    case "pacs.009":
      return { uetr: m.tx.paymentId.uetr, amount: m.tx.interbankSettlementAmount };
    case "pacs.004":
      return { originalUetr: m.tx.originalUetr, amount: m.tx.returnedInterbankSettlementAmount };
    case "camt.056":
      return { originalUetr: m.tx.originalUetr, amount: m.tx.originalInterbankSettlementAmount };
    case "camt.029":
    case "pacs.002":
      return { originalUetr: m.tx.originalUetr };
  }
}

const fromPartyOrAgent = (p: PartyOrAgent): TravelRuleParticipant => (p.party ? { party: p.party } : { institution: p.agent });

/** Travel-rule data implied by a message (null for status and investigation messages). */
export function deriveTravelRule(m: IsoMessage): TravelRuleData | null {
  switch (m.kind) {
    case "pacs.008":
      return {
        originator: { party: m.tx.debtor, account: m.tx.debtorAccount },
        beneficiary: { party: m.tx.creditor, account: m.tx.creditorAccount },
        originatorAgent: m.tx.debtorAgent,
        beneficiaryAgent: m.tx.creditorAgent,
      };
    case "pacs.009":
      return {
        originator: { institution: m.tx.debtor, account: m.tx.debtorAccount },
        beneficiary: { institution: m.tx.creditor, account: m.tx.creditorAccount },
        originatorAgent: m.tx.debtorAgent,
        beneficiaryAgent: m.tx.creditorAgent,
      };
    case "pacs.004":
      return {
        originator: fromPartyOrAgent(m.tx.returnChain.debtor),
        beneficiary: fromPartyOrAgent(m.tx.returnChain.creditor),
        originatorAgent: m.tx.returnChain.debtorAgent,
        beneficiaryAgent: m.tx.returnChain.creditorAgent,
      };
    default:
      return null;
  }
}

/** Deterministic JSON (sorted keys, no undefined) so both ends hash the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function messageCommitment(salt: Uint8Array, xml: string): Hex {
  return keccak256(concat(enc.encode(MSG_DOMAIN), salt, enc.encode(xml)));
}

export function travelRuleCommitment(salt: Uint8Array, travelRuleJson: string): Hex {
  return keccak256(concat(enc.encode(TR_DOMAIN), salt, enc.encode(travelRuleJson)));
}

// ── Header codec ────────────────────────────────────────────────────────────

const DELIVERY_NUM: Record<IsoDelivery, number> = { encrypted: 1, "off-chain": 2 };
const MESSAGE_DEFS = new Set<string>(Object.values(MESSAGE_DEFINITIONS));

function headerWriter(h: IsoPayloadHeader, withSealed: boolean): ProtoWriter {
  const w = new ProtoWriter()
    .uint(1, h.version)
    .string(2, h.messageDefinition)
    .bytes(3, uetrToBytes(h.uetr));
  if (h.originalUetr) w.bytes(4, uetrToBytes(h.originalUetr));
  if (h.amount) w.string(5, h.amount.value).string(6, h.amount.currency);
  w.bytes(7, h.messageCommitment).bytes(8, h.travelRuleCommitment).uint(9, DELIVERY_NUM[h.delivery]);
  if (h.recipientKeyId) w.bytes(10, h.recipientKeyId);
  if (withSealed) {
    if (h.ephemeralPublicKey) w.bytes(11, h.ephemeralPublicKey);
    if (h.nonce) w.bytes(12, h.nonce);
    if (h.ciphertext) w.bytes(13, h.ciphertext);
  }
  return w;
}

export function encodeIsoPayload(h: IsoPayloadHeader): Hex {
  return headerWriter(h, true).hex();
}

/** AEAD associated data: fields 1–10 of the header (everything in clear except the sealed parts). */
export function isoPayloadAad(h: IsoPayloadHeader): Uint8Array {
  return headerWriter(h, false).finish();
}

/**
 * Strict decoder: every field must have the right wire type and size, appear at most once, and be known. Anything
 * else could smuggle data in the clear, so it is an error.
 */
export function decodeIsoPayload(payload: Hex | Uint8Array): IsoPayloadHeader {
  const bytes = typeof payload === "string" ? (isHex(payload) ? hexToBytes(payload) : null) : payload;
  if (!bytes) throw new Error("ISO payload: not hex");
  const seen = new Set<number>();
  const h: Partial<IsoPayloadHeader> & { amountValue?: string; currency?: string } = {};
  const fixed = (b: Uint8Array | undefined, n: number, name: string): Hex => {
    if (!b || b.length !== n) throw new Error(`ISO payload: ${name} must be ${n} bytes`);
    return bytesToHex(b);
  };
  const str = (f: { bytes?: Uint8Array }, name: string): string => {
    try {
      return dec.decode(f.bytes);
    } catch {
      throw new Error(`ISO payload: ${name} is not UTF-8`);
    }
  };
  for (const f of readFields(bytes)) {
    if (seen.has(f.field)) throw new Error(`ISO payload: field ${f.field} repeats`);
    seen.add(f.field);
    const isVarint = f.field === 1 || f.field === 9;
    if (isVarint ? f.wt !== 0 : f.wt !== 2) throw new Error(`ISO payload: field ${f.field} has the wrong wire type`);
    switch (f.field) {
      case 1: h.version = Number(f.int); break;
      case 2: h.messageDefinition = str(f, "message_definition") as MessageDefinition; break;
      case 3: h.uetr = bytesToUetr16(fixed(f.bytes, 16, "uetr")); break;
      case 4: h.originalUetr = bytesToUetr16(fixed(f.bytes, 16, "original_uetr")); break;
      case 5: h.amountValue = str(f, "amount"); break;
      case 6: h.currency = str(f, "currency"); break;
      case 7: h.messageCommitment = fixed(f.bytes, 32, "message_commitment"); break;
      case 8: h.travelRuleCommitment = fixed(f.bytes, 32, "travel_rule_commitment"); break;
      case 9: {
        const d = Number(f.int);
        h.delivery = d === 1 ? "encrypted" : d === 2 ? "off-chain" : (() => { throw new Error(`ISO payload: unknown delivery ${d}`); })();
        break;
      }
      case 10: h.recipientKeyId = fixed(f.bytes, 32, "recipient_key_id"); break;
      case 11: h.ephemeralPublicKey = fixed(f.bytes, 32, "ephemeral_public_key"); break;
      case 12: h.nonce = fixed(f.bytes, 24, "nonce"); break;
      case 13: h.ciphertext = bytesToHex(f.bytes!); break;
      default: throw new Error(`ISO payload: unknown field ${f.field}`);
    }
  }
  if (h.version !== ISO_PAYLOAD_VERSION) throw new Error(`ISO payload: unsupported version ${h.version}`);
  if (!h.messageDefinition || !MESSAGE_DEFS.has(h.messageDefinition)) throw new Error(`ISO payload: unknown message definition ${h.messageDefinition}`);
  if (!h.uetr) throw new Error("ISO payload: uetr missing");
  if (!h.messageCommitment || !h.travelRuleCommitment) throw new Error("ISO payload: commitments missing");
  if (!h.delivery) throw new Error("ISO payload: delivery missing");
  if ((h.amountValue === undefined) !== (h.currency === undefined)) throw new Error("ISO payload: amount and currency go together");
  const out: IsoPayloadHeader = {
    version: h.version,
    messageDefinition: h.messageDefinition,
    uetr: h.uetr,
    messageCommitment: h.messageCommitment,
    travelRuleCommitment: h.travelRuleCommitment,
    delivery: h.delivery,
  };
  if (h.originalUetr) out.originalUetr = h.originalUetr;
  if (h.amountValue !== undefined) {
    out.amount = { value: h.amountValue, currency: h.currency! };
    const p = amountProblems(out.amount);
    if (p.length) throw new Error(`ISO payload: ${p.join("; ")}`);
  }
  const sealedParts = [h.recipientKeyId, h.ephemeralPublicKey, h.nonce, h.ciphertext];
  if (h.delivery === "encrypted") {
    if (sealedParts.some((x) => x === undefined)) throw new Error("ISO payload: encrypted delivery needs key id, ephemeral key, nonce and ciphertext");
    if (hexToBytes(h.ciphertext!).length < 16) throw new Error("ISO payload: ciphertext shorter than the AEAD tag");
    Object.assign(out, { recipientKeyId: h.recipientKeyId, ephemeralPublicKey: h.ephemeralPublicKey, nonce: h.nonce, ciphertext: h.ciphertext });
  } else if (sealedParts.some((x) => x !== undefined)) {
    throw new Error("ISO payload: off-chain delivery must not carry key id, ephemeral key, nonce or ciphertext");
  }
  return out;
}

// ── Sealed body codec ───────────────────────────────────────────────────────

function encodeSealedBody(xml: string, salt: Uint8Array, travelRule: string): Uint8Array {
  return new ProtoWriter().string(1, xml).bytes(2, salt).string(3, travelRule).finish();
}

function decodeSealedBody(b: Uint8Array): OffChainDelivery {
  let xml: string | undefined;
  let salt: Hex | undefined;
  let travelRule = "";
  for (const f of readFields(b)) {
    if (f.wt !== 2) throw new Error("sealed body: bad wire type");
    if (f.field === 1) xml = fieldString(f);
    else if (f.field === 2) salt = bytesToHex(f.bytes!);
    else if (f.field === 3) travelRule = fieldString(f);
  }
  if (!xml || !salt) throw new Error("sealed body: xml or salt missing");
  return { xml, salt, travelRule };
}

// ── Bind / open ─────────────────────────────────────────────────────────────

/** Validate the ISO message and build the clear header (+ ciphertext or off-chain delivery) for an envelope. */
export function bindIsoMessage(input: IsoBindInput): IsoBinding {
  const message = typeof input.message === "string" ? fromXml(input.message) : input.message;
  const xml = typeof input.message === "string" ? input.message : toXml(message);
  const facts = messageFacts(message);
  let uetr: string;
  if (facts.uetr) {
    if (input.routeUetr && input.routeUetr !== facts.uetr) throw new Error("route UETR must equal the payment's UETR");
    uetr = facts.uetr;
  } else {
    uetr = input.routeUetr ?? generateUetr();
    if (!isUetr(uetr)) throw new Error(`not a UUIDv4 UETR: ${uetr}`);
    if (uetr === facts.originalUetr) throw new Error("a follow-up message needs its own UETR");
  }
  const travelRule = input.travelRule === undefined ? deriveTravelRule(message) : input.travelRule;
  const travelRuleJson = canonicalJson(travelRule);
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(32));
  if (salt.length !== 32) throw new Error("salt must be 32 bytes");
  const delivery = input.delivery ?? "encrypted";

  const header: IsoPayloadHeader = {
    version: ISO_PAYLOAD_VERSION,
    messageDefinition: MESSAGE_DEFINITIONS[message.kind],
    uetr,
    messageCommitment: messageCommitment(salt, xml),
    travelRuleCommitment: travelRuleCommitment(salt, travelRuleJson),
    delivery,
  };
  if (facts.originalUetr) header.originalUetr = facts.originalUetr;
  if (facts.amount) header.amount = { ...facts.amount };

  let offChain: OffChainDelivery | undefined;
  if (delivery === "encrypted") {
    if (!input.recipientPublicKey) throw new Error("encrypted delivery needs the destination institution's public key");
    header.recipientKeyId = institutionKeyId(input.recipientPublicKey);
    const sealed = seal(encodeSealedBody(xml, salt, travelRuleJson), input.recipientPublicKey, isoPayloadAad(header), {
      ephemeralSecretKey: input.ephemeralSecretKey,
      nonce: input.nonce,
    });
    header.ephemeralPublicKey = bytesToHex(sealed.ephemeralPublicKey);
    header.nonce = bytesToHex(sealed.nonce);
    header.ciphertext = bytesToHex(sealed.ciphertext);
  } else {
    offChain = { xml, salt: bytesToHex(salt), travelRule: travelRuleJson };
  }
  return { header, payload: encodeIsoPayload(header), isoUetr: uetrToBytes(uetr), message, xml, travelRule, offChain };
}

/**
 * Build the `ClprRouteEnvelope` for an ISO 20022 message: `iso_uetr` = UETR, `payload_type` = `iso20022`, payload =
 * the clear header. The route must be planned with the ISO 20022 filter.
 */
export function buildIsoEnvelope(
  envelope: Omit<BuildEnvelopeInput, "payload" | "payloadType" | "payloadProtection" | "isoUetr">,
  iso: IsoBindInput,
): { envelope: ClprRouteEnvelope; binding: IsoBinding } {
  if (!envelope.plan.filters.includes("ISO20022")) throw new Error("ISO 20022 payloads need a route planned with the ISO 20022 filter");
  const binding = bindIsoMessage(iso);
  const env = buildEnvelope({
    ...envelope,
    payload: binding.payload,
    payloadType: "iso20022",
    // The header carries hashes and (optionally) ciphertext, never the message: the builder's non-plaintext class.
    payloadProtection: "ciphertext",
    isoUetr: binding.isoUetr,
  });
  return { envelope: env, binding };
}

function headerFrom(source: ClprRouteEnvelope | Hex): IsoPayloadHeader {
  if (typeof source === "string") return decodeIsoPayload(source);
  if (source.payload_type !== "iso20022") throw new Error(`envelope payload_type is ${source.payload_type}, not iso20022`);
  const header = decodeIsoPayload(source.payload);
  if (source.iso_uetr.toLowerCase() !== uetrToBytes(header.uetr)) throw new Error("envelope iso_uetr is not the payload's UETR");
  return header;
}

function finish(header: IsoPayloadHeader, body: OffChainDelivery): OpenedIsoPayment {
  const salt = toBytes(body.salt, "salt", 32);
  if (messageCommitment(salt, body.xml) !== header.messageCommitment) throw new Error("ISO message does not match its on-chain commitment");
  if (travelRuleCommitment(salt, body.travelRule) !== header.travelRuleCommitment) {
    throw new Error("travel-rule data does not match its on-chain commitment");
  }
  const message = fromXml(body.xml);
  if (MESSAGE_DEFINITIONS[message.kind] !== header.messageDefinition) throw new Error("message definition differs from the header");
  const facts = messageFacts(message);
  if (facts.uetr && facts.uetr !== header.uetr) throw new Error("payment UETR differs from the route UETR");
  if (facts.originalUetr !== header.originalUetr) throw new Error("original UETR differs from the header");
  if (facts.amount?.value !== header.amount?.value || facts.amount?.currency !== header.amount?.currency) {
    throw new Error("amount or currency differs from the header");
  }
  const travelRule = JSON.parse(body.travelRule) as TravelRuleData | null;
  return { header, xml: body.xml, message, travelRule };
}

/** Recipient side: decrypt with the institution's secret key and check the result against the clear header. */
export function openIsoPayload(source: ClprRouteEnvelope | Hex, recipientSecretKey: Uint8Array | Hex): OpenedIsoPayment {
  const header = headerFrom(source);
  if (header.delivery !== "encrypted") throw new Error("payload is delivered off-chain; use verifyOffChainDelivery");
  if (institutionKeyId(publicKeyOf(recipientSecretKey)) !== header.recipientKeyId) throw new Error("payload is sealed to a different institution key");
  const plain = open(
    { ephemeralPublicKey: hexToBytes(header.ephemeralPublicKey!), nonce: hexToBytes(header.nonce!), ciphertext: hexToBytes(header.ciphertext!) },
    recipientSecretKey,
    isoPayloadAad(header),
  );
  return finish(header, decodeSealedBody(plain));
}

/** Recipient side for `off-chain` delivery: check the delivered message against the on-chain commitments. */
export function verifyOffChainDelivery(source: ClprRouteEnvelope | Hex, delivery: OffChainDelivery): OpenedIsoPayment {
  const header = headerFrom(source);
  if (header.delivery !== "off-chain") throw new Error("payload is encrypted in the envelope; use openIsoPayload");
  return finish(header, delivery);
}
