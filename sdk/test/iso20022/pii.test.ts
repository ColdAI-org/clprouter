import type { Hex } from "viem";
import { bytesToHex, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import type { ClprRouteEnvelope } from "../../src/index.js";
import { ProtoWriter, encodeEnvelope, plan } from "../../src/index.js";
import {
  ClearPersonalDataError,
  assertNoClearPersonalData,
  buildIsoEnvelope,
  encodeIsoPayload,
  encodeRouteReceipt,
  findClearPersonalData,
  generateInstitutionKeyPair,
  looksLikeText,
  makeReceipt,
  toXml,
} from "../../src/iso20022/index.js";
import { A, B, NOW, fixtureGraph } from "../fixtures.js";
import { PII, UETR, pacs008 } from "./fixtures.js";

const bank = generateInstitutionKeyPair();

function isoEnvelope(delivery: "encrypted" | "off-chain" = "encrypted") {
  const p = plan(fixtureGraph(), { origin: A, destination: B, now: NOW, mode: "fastest", filters: { iso20022: true } });
  if (!p.ok) throw new Error("plan");
  return buildIsoEnvelope(
    {
      plan: p,
      originApp: "0x00000000000000000000000000000000000000aa",
      destinationApp: "0x00000000000000000000000000000000000000bb",
      sender: `${A}:0x1111111111111111111111111111111111111111`,
      recipient: `${B}:0x2222222222222222222222222222222222222222`,
      feeUnit: { nativeUsd: 2, decimals: 6 },
      registryVersion: 7n,
      routers: { [A]: "0x000000000000000000000000000000000000a001" },
      now: NOW,
    },
    { message: pacs008(), recipientPublicKey: bank.publicKey, delivery },
  );
}

const kinds = (env: ClprRouteEnvelope | Hex) => findClearPersonalData(env).map((v) => `${v.path}:${v.kind}`);

describe("no personal data in the clear", () => {
  it("passes a bound ISO 20022 envelope (encrypted and off-chain), also from its encoded bytes", () => {
    for (const d of ["encrypted", "off-chain"] as const) {
      const { envelope } = isoEnvelope(d);
      expect(findClearPersonalData(envelope)).toEqual([]);
      expect(findClearPersonalData(encodeEnvelope(envelope))).toEqual([]);
      expect(() => assertNoClearPersonalData(envelope)).not.toThrow();
    }
  });

  it("catches the ISO XML sent as the payload", () => {
    const { envelope } = isoEnvelope();
    const leak = { ...envelope, payload: stringToHex(toXml(pacs008())) };
    expect(kinds(leak)).toEqual(["payload:iso-message"]);
    expect(() => assertNoClearPersonalData(leak)).toThrow(ClearPersonalDataError);
  });

  it("catches an extra header field smuggling a name next to the hashes", () => {
    const { envelope } = isoEnvelope();
    const smuggled = (envelope.payload + new ProtoWriter().string(30, PII.debtorName).hex().slice(2)) as Hex;
    expect(kinds({ ...envelope, payload: smuggled })).toEqual(["payload:unknown-field"]);
  });

  it("catches free text in the amount or currency slots", () => {
    const { envelope, binding } = isoEnvelope();
    const h = binding.header;
    expect(kinds({ ...envelope, payload: encodeIsoPayload({ ...h, amount: { value: PII.creditorName, currency: "EUR" } }) })).toEqual(["payload:malformed"]);
    expect(kinds({ ...envelope, payload: encodeIsoPayload({ ...h, amount: { value: "1.00", currency: "Erika" } }) })).toEqual(["payload:malformed"]);
  });

  it("catches 'ciphertext' that is really plaintext", () => {
    const { envelope, binding } = isoEnvelope();
    const fake = encodeIsoPayload({ ...binding.header, ciphertext: stringToHex(`Pay ${PII.creditorName} ${PII.creditorIban}`) });
    expect(kinds({ ...envelope, payload: fake })).toEqual(["payload.ciphertext:account-identifier"]);
  });

  it("catches names and IBANs in CAIP-10 accounts", () => {
    const { envelope } = isoEnvelope();
    expect(kinds({ ...envelope, sender: `${A}:${PII.debtorIban}` })).toEqual(["sender:account-identifier"]);
    expect(kinds({ ...envelope, recipient: `${B}:John Smith` })).toEqual(["recipient:free-text"]);
    expect(kinds({ ...envelope, recipient: `eip155:1:JohnSmith` })).toEqual(["recipient:account-identifier"]);
    expect(kinds({ ...envelope, recipient: "eip155:1:0x2222222222222222222222222222222222222222" })).toEqual([]);
    expect(kinds({ ...envelope, recipient: "hedera:mainnet:0.0.1234-abcde" })).toEqual([]);
    expect(kinds({ ...envelope, recipient: "stellar:pubnet:GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H" })).toEqual([]);
  });

  it("catches text hidden in address, channel and signature bytes", () => {
    const { envelope } = isoEnvelope();
    const name = stringToHex(PII.debtorName);
    expect(kinds({ ...envelope, origin: { ...envelope.origin, application: name } })).toEqual(["origin.application:free-text"]);
    expect(kinds({ ...envelope, hops: envelope.hops.map((h, i) => (i === 0 ? { ...h, channel_id: stringToHex(PII.creditorIban) } : h)) })).toEqual([
      "hops[0].channel_id:account-identifier",
    ]);
    expect(kinds({ ...envelope, origin_signature: stringToHex(`signed by ${PII.debtorName}`) })).toEqual(["origin_signature:free-text"]);
    expect(kinds({ ...envelope, hops: envelope.hops.map((h, i) => (i === 1 ? { ...h, ledger_id: "Erika Mustermann" } : h)) })).toEqual([
      "hops[1].ledger_id:free-text",
    ]);
  });

  it("refuses raw payloads on ISO 20022 routes, and plaintext on any route", () => {
    const { envelope } = isoEnvelope();
    expect(kinds({ ...envelope, payload_type: "raw", payload: `0x${"ab".repeat(32)}` })).toEqual(["payload_type:plaintext-payload"]);
    const noFilter = { ...envelope, payload_type: "raw" as const, constraints: { ...envelope.constraints, filters: [] }, payload: stringToHex("hello Erika, here is your money") };
    expect(kinds(noFilter)).toEqual(["payload:plaintext-payload"]);
    expect(kinds({ ...noFilter, payload: bytesToHex(crypto.getRandomValues(new Uint8Array(64))) })).toEqual([]);
  });

  it("receipts may carry the provider contact, not free text", () => {
    const { envelope } = isoEnvelope();
    const ok = makeReceipt(UETR, { status: "QUARANTINED", reason: "BLACKLIST", ledger_id: "test:hub", case_id: `0x${"c4".repeat(32)}`, contact: "https://provider.example/cases" });
    expect(kinds({ ...envelope, payload_type: "receipt", payload: encodeRouteReceipt(ok) })).toEqual([]);
    const bad = { ...ok, contact: `Call ${PII.creditorName} at home` };
    expect(kinds({ ...envelope, payload_type: "receipt", payload: encodeRouteReceipt(bad) })).toEqual(["payload.contact:free-text"]);
  });

  it("looksLikeText separates text from random bytes", () => {
    expect(looksLikeText(new TextEncoder().encode("Müller GmbH"))).toBe(true);
    expect(looksLikeText(new Uint8Array(20).fill(0x11))).toBe(false);
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (looksLikeText(crypto.getRandomValues(new Uint8Array(20)))) hits++;
    expect(hits).toBe(0);
  });
});
