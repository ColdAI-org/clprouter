import type { Hex } from "viem";
import { bytesToHex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { PlanSuccess } from "../../src/index.js";
import { ProtoWriter, decodeEnvelope, encodeEnvelope, envelopeUetr, plan } from "../../src/index.js";
import {
  bindIsoMessage,
  buildIsoEnvelope,
  decodeIsoPayload,
  encodeIsoPayload,
  generateInstitutionKeyPair,
  generateUetr,
  institutionKeyId,
  isUetr,
  open,
  openIsoPayload,
  bytesToUetr16,
  seal,
  toXml,
  uetrToBytes,
  verifyOffChainDelivery,
} from "../../src/iso20022/index.js";
import { A, B, NOW } from "../fixtures.js";
import { fixtureGraph } from "../fixtures.js";
import { PII, UETR, pacs008, pacs009 } from "./fixtures.js";

const APP_A = "0x00000000000000000000000000000000000000aa" as const;
const APP_B = "0x00000000000000000000000000000000000000bb" as const;
const SENDER = `${A}:0x1111111111111111111111111111111111111111`;
const RECIPIENT = `${B}:0x2222222222222222222222222222222222222222`;

function isoPlan(): PlanSuccess {
  const r = plan(fixtureGraph(), { origin: A, destination: B, now: NOW, mode: "fastest", filters: { iso20022: true } });
  if (!r.ok) throw new Error(r.details.join());
  return r;
}

const envInput = (p = isoPlan()) => ({
  plan: p,
  originApp: APP_A,
  destinationApp: APP_B,
  sender: SENDER,
  recipient: RECIPIENT,
  feeUnit: { nativeUsd: 2, decimals: 6 },
  registryVersion: 7n,
  now: NOW,
});

/** Flip one bit of a hex string's byte at `i`. */
function flip(h: Hex, i: number): Hex {
  const b = hexToBytes(h);
  b[i] = b[i]! ^ 0x01;
  return bytesToHex(b);
}

describe("UETR", () => {
  it("generates lower-case UUIDv4s and maps them to 16 bytes (iso_uetr) and back", () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUetr();
      expect(isUetr(u)).toBe(true);
      expect(bytesToUetr16(uetrToBytes(u))).toBe(u);
    }
    expect(uetrToBytes(UETR)).toBe("0x8a562c67ca1648bab07465581be6f001");
  });

  it("rejects non-v4, upper-case and malformed ids", () => {
    expect(isUetr("8A562C67-CA16-48BA-B074-65581BE6F001")).toBe(false);
    expect(isUetr("8a562c67-ca16-18ba-b074-65581be6f001")).toBe(false); // version 1
    expect(isUetr("8a562c67-ca16-48ba-c074-65581be6f001")).toBe(false); // wrong variant
    expect(isUetr("8a562c67ca1648bab07465581be6f001")).toBe(false);
    expect(() => bytesToUetr16("0x8a562c67ca1618bab07465581be6f001")).toThrow(/UUIDv4/);
    expect(() => bytesToUetr16("0x1234")).toThrow(/16 bytes/);
  });
});

describe("sealing (X25519 + HKDF-SHA256 + XChaCha20-Poly1305)", () => {
  const kp = generateInstitutionKeyPair();
  const aad = new TextEncoder().encode("header");
  const msg = new TextEncoder().encode("hello");

  it("round trips and uses a fresh ephemeral key and nonce each time", () => {
    const a = seal(msg, kp.publicKey, aad);
    const b = seal(msg, kp.publicKey, aad);
    expect(open(a, kp.secretKey, aad)).toEqual(msg);
    expect(bytesToHex(a.ephemeralPublicKey)).not.toBe(bytesToHex(b.ephemeralPublicKey));
    expect(bytesToHex(a.ciphertext)).not.toBe(bytesToHex(b.ciphertext));
  });

  it("fails on a wrong key, altered AAD, nonce, ephemeral key or ciphertext", () => {
    const s = seal(msg, kp.publicKey, aad);
    expect(() => open(s, generateInstitutionKeyPair().secretKey, aad)).toThrow(/authentication/);
    expect(() => open(s, kp.secretKey, new TextEncoder().encode("headeR"))).toThrow(/authentication/);
    expect(() => open({ ...s, nonce: hexToBytes(flip(bytesToHex(s.nonce), 0)) }, kp.secretKey, aad)).toThrow(/authentication/);
    expect(() => open({ ...s, ephemeralPublicKey: hexToBytes(flip(bytesToHex(s.ephemeralPublicKey), 3)) }, kp.secretKey, aad)).toThrow();
    expect(() => open({ ...s, ciphertext: hexToBytes(flip(bytesToHex(s.ciphertext), 0)) }, kp.secretKey, aad)).toThrow(/authentication/);
  });

  it("refuses a low-order (all-zero) recipient key", () => {
    expect(() => seal(msg, new Uint8Array(32), aad)).toThrow(/invalid|all-zero|low-order/);
  });
});

describe("envelope binding", () => {
  const bank = generateInstitutionKeyPair();

  it("iso_uetr is the UETR (not the route id); only UETR, amount, currency and hashes are in clear", () => {
    const { envelope, binding } = buildIsoEnvelope(envInput(), { message: pacs008(), recipientPublicKey: bank.publicKey });
    expect(envelope.iso_uetr).toBe(uetrToBytes(UETR));
    expect(envelope.route_id).toBe("0x"); // derived by the origin Router at send
    expect(envelopeUetr(envelope)).toBe(UETR);
    expect(envelope.payload_type).toBe("iso20022");
    const h = decodeIsoPayload(envelope.payload);
    expect(h).toMatchObject({
      version: 1,
      messageDefinition: "pacs.008.001.08",
      uetr: UETR,
      amount: { value: "1250.00", currency: "EUR" },
      delivery: "encrypted",
      recipientKeyId: institutionKeyId(bank.publicKey),
    });
    expect(h.messageCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.travelRuleCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(binding.offChain).toBeUndefined();
    // No personal data anywhere in the encoded envelope bytes.
    const wire = Buffer.from(hexToBytes(encodeEnvelope(envelope))).toString("latin1");
    for (const s of Object.values(PII)) expect(wire).not.toContain(s);
    expect(wire).not.toContain("<Document");
  });

  it("recipient decrypts the full message and travel-rule data", () => {
    const { envelope, binding } = buildIsoEnvelope(envInput(), { message: pacs008(), recipientPublicKey: bank.publicKey });
    const opened = openIsoPayload(decodeEnvelope(encodeEnvelope(envelope)), bank.secretKey);
    expect(opened.message).toEqual(pacs008());
    expect(opened.xml).toBe(binding.xml);
    expect(opened.travelRule?.originator.party?.name).toBe(PII.debtorName);
    expect(opened.travelRule?.originator.account?.iban).toBe(PII.debtorIban);
    expect(opened.travelRule?.beneficiary.party?.name).toBe(PII.creditorName);
    expect(opened.travelRule?.beneficiaryAgent?.bicfi).toBe("CLPRGB2L");
  });

  it("binds raw XML input as-is and pacs.009 with its own UETR", () => {
    const xml = toXml(pacs009());
    const kp = generateInstitutionKeyPair();
    const b = bindIsoMessage({ message: xml, recipientPublicKey: kp.publicKey });
    expect(b.header.amount).toEqual({ value: "1000000", currency: "JPY" });
    const opened = openIsoPayload(b.payload, kp.secretKey);
    expect(opened.xml).toBe(xml);
    expect(opened.travelRule?.beneficiary.institution?.bicfi).toBe("CLPRGB2LTRS");
  });

  it("is deterministic given salt, ephemeral key and nonce", () => {
    const fixed = { salt: new Uint8Array(32).fill(7), ephemeralSecretKey: new Uint8Array(32).fill(9), nonce: new Uint8Array(24).fill(1) };
    const a = bindIsoMessage({ message: pacs008(), recipientPublicKey: bank.publicKey, ...fixed });
    const b = bindIsoMessage({ message: pacs008(), recipientPublicKey: bank.publicKey, ...fixed });
    expect(a.payload).toBe(b.payload);
    const c = bindIsoMessage({ message: pacs008(), recipientPublicKey: bank.publicKey });
    expect(c.header.messageCommitment).not.toBe(a.header.messageCommitment); // random salt hides the message
  });

  it("detects tampering with every clear field and the ciphertext", () => {
    const { envelope } = buildIsoEnvelope(envInput(), { message: pacs008(), recipientPublicKey: bank.publicKey });
    const h = decodeIsoPayload(envelope.payload);
    const tampered = [
      { ...h, amount: { value: "9250.00", currency: "EUR" } },
      { ...h, amount: { value: "1250.00", currency: "USD" } },
      { ...h, messageCommitment: flip(h.messageCommitment, 0) },
      { ...h, travelRuleCommitment: flip(h.travelRuleCommitment, 31) },
      { ...h, ciphertext: flip(h.ciphertext!, 5) },
      { ...h, nonce: flip(h.nonce!, 0) },
      { ...h, ephemeralPublicKey: flip(h.ephemeralPublicKey!, 1) },
      { ...h, messageDefinition: "pacs.009.001.08" as const },
    ];
    for (const t of tampered) expect(() => openIsoPayload(encodeIsoPayload(t), bank.secretKey)).toThrow();
    // A different UETR in the header no longer matches the envelope's iso_uetr.
    const other = { ...h, uetr: generateUetr() };
    expect(() => openIsoPayload({ ...envelope, payload: encodeIsoPayload(other) }, bank.secretKey)).toThrow(/iso_uetr/);
    // A different iso_uetr no longer matches the header.
    expect(() => openIsoPayload({ ...envelope, iso_uetr: uetrToBytes(generateUetr()) }, bank.secretKey)).toThrow(/iso_uetr/);
    expect(() => openIsoPayload(envelope, generateInstitutionKeyPair().secretKey)).toThrow(/different institution key/);
  });

  it("detects a sender whose commitment does not match the sealed message", () => {
    // Seal one message but commit to another: the recipient must notice.
    const salt = new Uint8Array(32).fill(3);
    const real = bindIsoMessage({ message: pacs008(), recipientPublicKey: bank.publicKey, salt });
    const other = bindIsoMessage({ message: pacs008({ purpose: "SALA" }), recipientPublicKey: bank.publicKey, salt });
    const forged = { ...real.header, messageCommitment: other.header.messageCommitment };
    // AAD covers the commitment, so the ciphertext fails before the commitment check.
    expect(() => openIsoPayload(encodeIsoPayload(forged), bank.secretKey)).toThrow(/authentication/);
  });

  it("off-chain delivery: the envelope has hashes only; the endpoint delivery is checked against them", () => {
    const { envelope, binding } = buildIsoEnvelope(envInput(), { message: pacs008(), delivery: "off-chain" });
    const h = decodeIsoPayload(envelope.payload);
    expect(h.delivery).toBe("off-chain");
    expect(h.ciphertext).toBeUndefined();
    expect(hexToBytes(envelope.payload).length).toBeLessThan(160);
    const opened = verifyOffChainDelivery(envelope, binding.offChain!);
    expect(opened.message).toEqual(pacs008());
    const altered = binding.offChain!.xml.replace(PII.creditorName, "Mallory Smith");
    expect(() => verifyOffChainDelivery(envelope, { ...binding.offChain!, xml: altered })).toThrow(/commitment/);
    expect(() => verifyOffChainDelivery(envelope, { ...binding.offChain!, travelRule: "null" })).toThrow(/travel-rule/);
    expect(() => openIsoPayload(envelope, bank.secretKey)).toThrow(/off-chain/);
  });

  it("follow-up messages get a fresh route UETR and carry the original", () => {
    const camt = {
      kind: "camt.056" as const,
      assignment: { id: "A-1", assigner: { bicfi: "CLPRDEFFXXX" }, assignee: { bicfi: "CLPRGB2L" }, creationDateTime: "2026-10-02T08:00:00Z" },
      tx: {
        case: { id: "C-1", creator: { bicfi: "CLPRDEFFXXX" } },
        originalGroupInfo: { messageId: "MSG-2026-10-01-0001", messageNameId: "pacs.008.001.08" },
        originalUetr: UETR,
        originalInterbankSettlementAmount: { value: "1250.00", currency: "EUR" },
        originalInterbankSettlementDate: "2026-10-01",
        reason: { code: "DUPL" as const },
      },
    };
    const b = bindIsoMessage({ message: camt, recipientPublicKey: bank.publicKey });
    expect(b.header.uetr).not.toBe(UETR);
    expect(b.header.originalUetr).toBe(UETR);
    expect(() => bindIsoMessage({ message: camt, recipientPublicKey: bank.publicKey, routeUetr: UETR })).toThrow(/own UETR/);
    expect(() => bindIsoMessage({ message: pacs008(), recipientPublicKey: bank.publicKey, routeUetr: generateUetr() })).toThrow(/must equal/);
    expect(openIsoPayload(b.payload, bank.secretKey).travelRule).toBeNull();
  });

  it("refuses invalid messages, missing keys and routes without the ISO 20022 filter", () => {
    expect(() => bindIsoMessage({ message: pacs008({ chargeBearer: "SLEV" as never }), recipientPublicKey: bank.publicKey })).toThrow(/ChrgBr/);
    expect(() => bindIsoMessage({ message: pacs008() })).toThrow(/public key/);
    const plain = plan(fixtureGraph(), { origin: A, destination: B, now: NOW });
    if (!plain.ok) throw new Error("plan");
    expect(() => buildIsoEnvelope(envInput(plain), { message: pacs008(), recipientPublicKey: bank.publicKey })).toThrow(/ISO 20022 filter/);
  });

  it("strict header decoding: unknown fields, bad sizes and mixed delivery fail", () => {
    const { binding } = buildIsoEnvelope(envInput(), { message: pacs008(), recipientPublicKey: bank.publicKey });
    const extra = (binding.payload + new ProtoWriter().string(20, PII.creditorName).hex().slice(2)) as Hex;
    expect(() => decodeIsoPayload(extra)).toThrow(/unknown field 20/);
    const dup = (binding.payload + new ProtoWriter().string(5, "1.00").hex().slice(2)) as Hex;
    expect(() => decodeIsoPayload(dup)).toThrow(/repeats/);
    const h = binding.header;
    expect(() => decodeIsoPayload(encodeIsoPayload({ ...h, amount: { value: "1250.005", currency: "EUR" } }))).toThrow(/decimal places/);
    expect(() => decodeIsoPayload(encodeIsoPayload({ ...h, delivery: "off-chain" }))).toThrow(/must not carry/);
    expect(() => decodeIsoPayload(encodeIsoPayload({ ...h, ciphertext: undefined }))).toThrow(/needs key id/);
    expect(() => decodeIsoPayload(encodeIsoPayload({ ...h, messageDefinition: "pain.001.001.09" as never }))).toThrow(/message definition/);
  });
});
