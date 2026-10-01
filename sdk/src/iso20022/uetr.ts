/**
 * UETR (Unique End-to-end Transaction Reference): an RFC 4122 UUID version 4, lower case, as ISO 20022's
 * `UUIDv4Identifier` requires. Under the ISO 20022 filter the UETR travels in the envelope's own 16-byte `iso_uetr`
 * field (and in the ISO payload header). It is never the route id: route ids are derived by the origin Router, so a
 * UETR cannot be used to squat or censor a route, and the same UETR may appear on several routes (follow-ups).
 */
import type { Hex } from "viem";
import { bytesToHex, hexToBytes, isHex } from "viem";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lower-case UUIDv4 (the ISO 20022 `UUIDv4Identifier` pattern). */
export function isUetr(s: string): boolean {
  return typeof s === "string" && UUID_V4.test(s);
}

/** A fresh random UETR from the platform CSPRNG. */
export function generateUetr(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUetr(b);
}

export function assertUetr(s: string): void {
  if (!isUetr(s)) throw new Error(`not a UUIDv4 UETR: ${s}`);
}

function bytesToUetr(b: Uint8Array): string {
  const h = bytesToHex(b).slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** UETR → its 16 bytes (the envelope `iso_uetr`, the ISO payload `uetr`). */
export function uetrToBytes(uetr: string): Hex {
  assertUetr(uetr);
  return `0x${uetr.replaceAll("-", "")}`;
}

/** 16 bytes (envelope `iso_uetr`) → UETR; throws if they are not a UUIDv4. */
export function bytesToUetr16(value: Hex | Uint8Array): string {
  const b = typeof value === "string" ? (isHex(value) ? hexToBytes(value) : new Uint8Array()) : value;
  if (b.length !== 16) throw new Error("uetr must be 16 bytes");
  const u = bytesToUetr(b);
  assertUetr(u);
  return u;
}
