/**
 * Minimal proto3 codec for `clprouter.v1.ClprRouteEnvelope` (proto/clprouter/v1/route_envelope.proto), byte-compatible
 * with the Solidity `RouteCodec`: fields in ascending order, default-valued scalars and empty bytes omitted, repeated
 * message elements always emitted (even when empty). {@link readFields} is a structural reader; the envelope decoder
 * (`decodeEnvelope`) additionally accepts only the canonical encoding, exactly as the Solidity codec does.
 */
import type { Hex } from "viem";
import { bytesToHex, hexToBytes } from "viem";

const WT_VARINT = 0;
const WT_I64 = 1;
const WT_LEN = 2;
const WT_I32 = 5;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ProtoWriter {
  private parts: Uint8Array[] = [];

  private push(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }

  static varint(v: bigint | number): Uint8Array {
    let x = BigInt(v);
    if (x < 0n) throw new Error("negative varint");
    const out: number[] = [];
    do {
      const b = Number(x & 0x7fn);
      x >>= 7n;
      out.push(x === 0n ? b : b | 0x80);
    } while (x !== 0n);
    return Uint8Array.from(out);
  }

  private key(field: number, wt: number): Uint8Array {
    return ProtoWriter.varint((field << 3) | wt);
  }

  uint(field: number, v: bigint | number | boolean): this {
    const x = typeof v === "boolean" ? (v ? 1n : 0n) : BigInt(v);
    if (x === 0n) return this;
    return this.push(this.key(field, WT_VARINT)).push(ProtoWriter.varint(x));
  }

  bytes(field: number, v: Uint8Array | Hex): this {
    const b = typeof v === "string" ? hexToBytes(v) : v;
    if (b.length === 0) return this;
    return this.push(this.key(field, WT_LEN)).push(ProtoWriter.varint(b.length)).push(b);
  }

  string(field: number, v: string): this {
    return this.bytes(field, enc.encode(v));
  }

  /** Singular message field: omitted when empty. */
  message(field: number, w: ProtoWriter): this {
    return this.bytes(field, w.finish());
  }

  /** Repeated message element: always emitted, even when empty. */
  element(field: number, w: ProtoWriter): this {
    const b = w.finish();
    return this.push(this.key(field, WT_LEN)).push(ProtoWriter.varint(b.length)).push(b);
  }

  finish(): Uint8Array {
    const n = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  hex(): Hex {
    return bytesToHex(this.finish());
  }
}

export interface ProtoField {
  field: number;
  wt: number;
  /** Varint value (wt 0). */
  int?: bigint;
  /** Length-delimited payload (wt 2). */
  bytes?: Uint8Array;
}

/** Split a message into its fields; unknown wire types 1 and 5 are skipped. */
export function readFields(b: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let p = 0;
  const varint = (): bigint => {
    let x = 0n;
    let shift = 0n;
    for (;;) {
      if (p >= b.length) throw new Error("malformed protobuf: truncated varint");
      const byte = b[p++]!;
      x |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return x;
      shift += 7n;
      if (shift > 63n) throw new Error("malformed protobuf: varint too long");
    }
  };
  while (p < b.length) {
    const k = varint();
    const field = Number(k >> 3n);
    const wt = Number(k & 7n);
    if (field === 0) throw new Error("malformed protobuf: field 0");
    if (wt === WT_VARINT) out.push({ field, wt, int: varint() });
    else if (wt === WT_LEN) {
      const len = Number(varint());
      if (p + len > b.length) throw new Error("malformed protobuf: truncated bytes");
      out.push({ field, wt, bytes: b.slice(p, p + len) });
      p += len;
    } else if (wt === WT_I64) p += 8;
    else if (wt === WT_I32) p += 4;
    else throw new Error(`malformed protobuf: wire type ${wt}`);
    if (p > b.length) throw new Error("malformed protobuf: truncated fixed field");
  }
  return out;
}

export function fieldString(f: ProtoField): string {
  return dec.decode(f.bytes ?? new Uint8Array());
}
