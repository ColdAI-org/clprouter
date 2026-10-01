/**
 * Encryption of the ISO message to the destination institution's key.
 *
 * Construction (an ECIES / HPKE-base-mode shape, one ephemeral key per message):
 *
 * 1. `esk` = fresh X25519 secret key; `epk` = X25519(esk, G).
 * 2. `ss`  = X25519(esk, recipientPublicKey); an all-zero result (low-order point) is refused.
 * 3. `key` = HKDF-SHA256(ikm = ss, salt = epk ‖ recipientPublicKey, info = INFO), 32 bytes.
 * 4. `ct`  = XChaCha20-Poly1305(key, nonce = 24 random bytes, aad, plaintext).
 *
 * Why this and not RFC 9180 HPKE: HPKE's registered AEADs are AES-GCM and ChaCha20-Poly1305 with 96-bit nonces;
 * XChaCha20-Poly1305's 192-bit nonce can be drawn at random with no counter state, which suits a sender that may
 * seal from several processes. The KDF binds both public keys (as HPKE's DHKEM does), so a ciphertext cannot be
 * re-targeted to another recipient, and the AAD binds the clear header that rides on-chain (UETR, amount, currency,
 * hashes), so none of those can be changed without breaking decryption. Every primitive is from the audited
 * `@noble/*` libraries; nothing here touches the network.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import type { Hex } from "viem";
import { bytesToHex, hexToBytes } from "viem";

export const SEAL_INFO = "clprouter/iso20022/v1 x25519-hkdf-sha256-xchacha20poly1305";
const KEY_ID_DOMAIN = "clprouter/iso20022/v1 key-id";

const enc = new TextEncoder();

export interface InstitutionKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface Sealed {
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function toBytes(v: Uint8Array | Hex, what: string, len?: number): Uint8Array {
  const b = typeof v === "string" ? hexToBytes(v) : v;
  if (len !== undefined && b.length !== len) throw new Error(`${what} must be ${len} bytes`);
  return b;
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

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A destination institution's X25519 key pair. Publish `publicKey`; keep `secretKey` in the institution's HSM / KMS. */
export function generateInstitutionKeyPair(): InstitutionKeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function publicKeyOf(secretKey: Uint8Array | Hex): Uint8Array {
  return x25519.getPublicKey(toBytes(secretKey, "secret key", 32));
}

/** 32-byte identifier of a recipient key, carried in clear so the recipient knows which key to use. */
export function institutionKeyId(publicKey: Uint8Array | Hex): Hex {
  return bytesToHex(sha256(concat(enc.encode(KEY_ID_DOMAIN), toBytes(publicKey, "public key", 32))));
}

function deriveKey(shared: Uint8Array, epk: Uint8Array, rpk: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new Error("X25519 produced an all-zero shared secret (low-order public key)");
  return hkdf(sha256, shared, concat(epk, rpk), enc.encode(SEAL_INFO), 32);
}

/** Seal `plaintext` to `recipientPublicKey`, authenticating `aad`. `ephemeralSecretKey` / `nonce` are for tests only. */
export function seal(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array | Hex,
  aad: Uint8Array,
  opts: { ephemeralSecretKey?: Uint8Array; nonce?: Uint8Array } = {},
): Sealed {
  const rpk = toBytes(recipientPublicKey, "recipient public key", 32);
  const esk = opts.ephemeralSecretKey ?? x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(esk);
  const key = deriveKey(x25519.getSharedSecret(esk, rpk), epk, rpk);
  const nonce = opts.nonce ?? randomBytes(24);
  if (nonce.length !== 24) throw new Error("nonce must be 24 bytes");
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  key.fill(0);
  return { ephemeralPublicKey: epk, nonce, ciphertext };
}

/** Open a sealed message. Throws if the ciphertext, nonce, ephemeral key or AAD was altered, or the key is wrong. */
export function open(sealed: Sealed, recipientSecretKey: Uint8Array | Hex, aad: Uint8Array): Uint8Array {
  const sk = toBytes(recipientSecretKey, "recipient secret key", 32);
  const rpk = x25519.getPublicKey(sk);
  const epk = toBytes(sealed.ephemeralPublicKey, "ephemeral public key", 32);
  const key = deriveKey(x25519.getSharedSecret(sk, epk), epk, rpk);
  try {
    return xchacha20poly1305(key, toBytes(sealed.nonce, "nonce", 24), aad).decrypt(sealed.ciphertext);
  } catch {
    throw new Error("ISO 20022 payload failed authentication: tampered, or sealed to another key");
  } finally {
    key.fill(0);
  }
}
