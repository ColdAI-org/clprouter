/**
 * UETR (Unique End-to-end Transaction Reference): an RFC 4122 UUID version 4, lower case, as ISO 20022's
 * `UUIDv4Identifier` requires. Under the ISO 20022 filter the UETR is the envelope's 16-byte `route_id`, so one id
 * tracks the payment across every hop.
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

/** UETR → the 16-byte envelope `route_id`. */
export function uetrToRouteId(uetr: string): Hex {
  assertUetr(uetr);
  return `0x${uetr.replaceAll("-", "")}`;
}

/** Envelope `route_id` → UETR; throws if the id is not a UUIDv4. */
export function routeIdToUetr(routeId: Hex | Uint8Array): string {
  const b = typeof routeId === "string" ? (isHex(routeId) ? hexToBytes(routeId) : new Uint8Array()) : routeId;
  if (b.length !== 16) throw new Error("route_id must be 16 bytes");
  const u = bytesToUetr(b);
  assertUetr(u);
  return u;
}
