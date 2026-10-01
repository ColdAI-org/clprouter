/**
 * "No personal data in the clear" check (spec "ISO 20022 filter" and build-plan phase 3: "a test proves no
 * plaintext personal data on-chain").
 *
 * Every field of a `ClprRouteEnvelope` outside the ciphertext is checked against a strict shape:
 *
 * - ledger ids are CAIP-2; `sender` / `recipient` are CAIP-10 with a namespace-specific address format (the only
 *   account identifiers allowed in clear);
 * - addresses, Channel / Connector ids, hashes and signatures are binary of the expected size and do not decode to
 *   text;
 * - an `iso20022` payload must be a `ClprIsoPayload` header (UETR, amount, currency, hashes, ciphertext) with no
 *   unknown field, and its ciphertext must not look like plaintext;
 * - a `receipt` payload may carry only the provider's contact (URL, e-mail or CAIP-10), never free text.
 *
 * Anything that does not fit is reported, together with what it looks like (a name, an IBAN, XML, free text).
 */
import type { Hex } from "viem";
import { hexToBytes, isHex } from "viem";
import type { ClprRouteEnvelope, RouteHop } from "../envelope.js";
import { decodeEnvelope } from "../envelope.js";
import { decodeIsoPayload } from "./binding.js";
import { decodeRouteReceipt } from "./receipts.js";
import { isIban } from "./validate.js";

export interface PiiViolation {
  path: string;
  /** What kind of leak this is. */
  kind: "free-text" | "account-identifier" | "iso-message" | "malformed" | "plaintext-payload" | "unknown-field";
  detail: string;
}

export class ClearPersonalDataError extends Error {
  constructor(readonly violations: readonly PiiViolation[]) {
    super(`personal data in the clear:\n  - ${violations.map((v) => `${v.path} [${v.kind}] ${v.detail}`).join("\n  - ")}`);
    this.name = "ClearPersonalDataError";
  }
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const CAIP10 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32}):([-.%a-zA-Z0-9]{1,128})$/;
const HEX_ADDR = /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/** Address formats per CAIP-2 namespace. Any namespace also accepts a 20- or 32-byte hex address. */
const ADDRESS_FORMATS: Record<string, RegExp> = {
  eip155: /^0x[0-9a-fA-F]{40}$/,
  hedera: /^(0\.0\.\d{1,19}(-[a-z]{5})?|0x[0-9a-fA-F]{40})$/,
  stellar: /^(G[A-Z2-7]{55}|M[A-Z2-7]{68}|C[A-Z2-7]{55})$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  bip122: /^([13][1-9A-HJ-NP-Za-km-z]{25,34}|(bc|tb)1[02-9ac-hj-np-z]{11,71})$/,
  xrpl: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  algorand: /^[A-Z2-7]{58}$/,
  cosmos: /^[a-z]{1,83}1[02-9ac-hj-np-z]{38,58}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  canton: /^[0-9a-f]{64,68}$/,
};

/**
 * True when bytes read as human text: mostly printable ASCII/UTF-8 with letters in it. Random 20- or 32-byte values
 * (addresses, hashes) essentially never pass.
 */
export function looksLikeText(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return false;
  }
  const printable = [...s].filter((c) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(c)).length;
  const letters = [...s].filter((c) => /\p{L}/u.test(c)).length;
  return printable / [...s].length >= 0.9 && letters >= 3;
}

/** Classify a text-like value for the report. */
function describeText(s: string): { kind: PiiViolation["kind"]; detail: string } {
  if (/<\?xml|<Document|<(Nm|PstlAdr|Dbtr|Cdtr|IBAN)>/.test(s)) return { kind: "iso-message", detail: "ISO 20022 XML in clear" };
  const compact = s.replace(/\s+/g, "").toUpperCase();
  const iban = /[A-Z]{2}\d{2}[A-Z0-9]{11,30}/.exec(compact);
  if (iban && isIban(iban[0])) return { kind: "account-identifier", detail: "IBAN in clear" };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) return { kind: "free-text", detail: "e-mail address in clear" };
  return { kind: "free-text", detail: `text in clear (${JSON.stringify(s.slice(0, 24))}${s.length > 24 ? "…" : ""})` };
}

function asBytes(h: Hex): Uint8Array | null {
  return isHex(h) ? hexToBytes(h) : null;
}

class Scan {
  readonly out: PiiViolation[] = [];

  add(path: string, kind: PiiViolation["kind"], detail: string): void {
    this.out.push({ path, kind, detail });
  }

  /** Opaque binary of one of the given sizes that does not decode to text. */
  binary(h: Hex, path: string, sizes: number[]): void {
    const b = asBytes(h);
    if (!b) return this.add(path, "malformed", "not hex");
    if (b.length === 0) return;
    if (looksLikeText(b)) {
      const d = describeText(new TextDecoder().decode(b));
      return this.add(path, d.kind, d.detail);
    }
    if (!sizes.includes(b.length)) this.add(path, "malformed", `${b.length} bytes; expected ${sizes.join(" or ")}`);
  }

  caip2(s: string, path: string): void {
    if (!CAIP2.test(s)) this.add(path, s ? describeText(s).kind : "malformed", `not a CAIP-2 ledger id: ${JSON.stringify(s.slice(0, 24))}`);
  }

  caip10(s: string, path: string): void {
    const m = CAIP10.exec(s);
    if (!m) {
      const d = describeText(s);
      return this.add(path, d.kind === "free-text" ? "free-text" : d.kind, `not a CAIP-10 account: ${d.detail}`);
    }
    const [, ns, , addr] = m;
    if (HEX_ADDR.test(addr!)) return;
    const fmt = ADDRESS_FORMATS[ns!];
    if (fmt?.test(addr!)) return;
    const iban = addr!.toUpperCase();
    if (isIban(iban)) return this.add(path, "account-identifier", "IBAN used as a CAIP-10 address");
    this.add(path, "account-identifier", `address is not a ${ns} account format`);
  }

  hop(h: RouteHop, path: string): void {
    this.caip2(h.ledger_id, `${path}.ledger_id`);
    this.binary(h.router, `${path}.router`, [20, 32]);
    this.binary(h.channel_id, `${path}.channel_id`, [32]);
    this.binary(h.connector_id, `${path}.connector_id`, [32]);
    this.binary(h.fee_payee, `${path}.fee_payee`, [20, 32]);
  }

  isoPayload(env: ClprRouteEnvelope): void {
    let header;
    try {
      header = decodeIsoPayload(env.payload);
    } catch (e) {
      const b = asBytes(env.payload);
      if (b && looksLikeText(b)) {
        const d = describeText(new TextDecoder().decode(b));
        return this.add("payload", d.kind === "free-text" ? "plaintext-payload" : d.kind, d.detail);
      }
      const msg = (e as Error).message;
      return this.add("payload", /unknown field|repeats/.test(msg) ? "unknown-field" : "malformed", msg);
    }
    if (header.ciphertext) {
      const ct = hexToBytes(header.ciphertext);
      if (looksLikeText(ct)) {
        const d = describeText(new TextDecoder().decode(ct));
        this.add("payload.ciphertext", d.kind === "free-text" ? "plaintext-payload" : d.kind, `ciphertext is readable: ${d.detail}`);
      }
    }
  }

  receiptPayload(env: ClprRouteEnvelope): void {
    let r;
    try {
      r = decodeRouteReceipt(env.payload);
    } catch (e) {
      return this.add("payload", "malformed", (e as Error).message);
    }
    if (r.ledger_id) this.caip2(r.ledger_id, "payload.ledger_id");
    this.binary(r.case_id, "payload.case_id", [32]);
    this.binary(r.response_hash, "payload.response_hash", [32]);
    r.route_prefix.forEach((h, i) => this.hop(h, `payload.route_prefix[${i}]`));
    this.binary(r.route_edge, "payload.route_edge", [32]);
    this.binary(r.route_rest, "payload.route_rest", [32]);
    if (r.contact && !/^(https?:\/\/[^\s]{1,200}|mailto:[^\s@]+@[^\s@]+|[^\s@]+@[^\s@]+\.[a-z]{2,})$/i.test(r.contact) && !CAIP10.test(r.contact)) {
      this.add("payload.contact", "free-text", "provider contact must be a URL, e-mail or CAIP-10 account");
    }
  }
}

/** All the places where an envelope exposes personal data or free text outside the ciphertext. */
export function findClearPersonalData(envelope: ClprRouteEnvelope | Hex): PiiViolation[] {
  const env = typeof envelope === "string" ? decodeEnvelope(envelope) : envelope;
  const s = new Scan();
  // route_id is derived by the origin Router: empty before send, 16 bytes after.
  s.binary(env.route_id, "route_id", [16]);
  s.binary(env.iso_uetr, "iso_uetr", [16]);
  s.caip2(env.origin.ledger_id, "origin.ledger_id");
  s.binary(env.origin.application, "origin.application", [20, 32]);
  s.caip2(env.destination.ledger_id, "destination.ledger_id");
  s.binary(env.destination.application, "destination.application", [20, 32]);
  s.caip10(env.sender, "sender");
  s.caip10(env.recipient, "recipient");
  env.hops.forEach((h, i) => s.hop(h, `hops[${i}]`));
  env.receipt_path.forEach((h, i) => s.hop(h, `receipt_path[${i}]`));
  s.binary(env.origin_signature, "origin_signature", [64, 65]);

  const iso = env.constraints.filters.includes("ISO20022");
  switch (env.payload_type) {
    case "iso20022":
      s.isoPayload(env);
      break;
    case "receipt":
      s.receiptPayload(env);
      break;
    default: {
      if (iso) s.add("payload_type", "plaintext-payload", `ISO 20022 routes must carry payload_type iso20022, not ${env.payload_type}`);
      const b = asBytes(env.payload);
      if (!b) s.add("payload", "malformed", "not hex");
      else if (looksLikeText(b)) {
        const d = describeText(new TextDecoder().decode(b));
        s.add("payload", d.kind === "free-text" ? "plaintext-payload" : d.kind, d.detail);
      } else if (iso && b.length !== 32) s.add("payload", "plaintext-payload", "not a hash or an ISO payload header");
    }
  }
  return s.out;
}

/** Throws `ClearPersonalDataError` if any field outside the ciphertext carries personal data or free text. */
export function assertNoClearPersonalData(envelope: ClprRouteEnvelope | Hex): void {
  const v = findClearPersonalData(envelope);
  if (v.length > 0) throw new ClearPersonalDataError(v);
}
