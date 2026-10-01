import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { keccak256, stringToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import type { BuildEnvelopeInput, ClprRouteEnvelope, PlanSuccess } from "../src/index.js";
import {
  ProtoWriter,
  advanceEnvelope,
  buildEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  envelopeUetr,
  parseCaip10,
  plan,
  randomRouteId,
  readFields,
  recoverEnvelopeSigner,
  routeIdToUuid,
  signEnvelope,
  toBytes32Id,
} from "../src/index.js";
import { A, B, H, NOW, Y, fixtureGraph } from "./fixtures.js";

const SENDER = `${A}:0x1111111111111111111111111111111111111111`;
const RECIPIENT = `${B}:0x2222222222222222222222222222222222222222`;
const HASH = `0x${"ab".repeat(32)}` as const;
const APP_A = "0x00000000000000000000000000000000000000aa" as const;
const APP_B = "0x00000000000000000000000000000000000000bb" as const;
const NOW_S = BigInt(NOW.getTime() / 1000);
/** 1 native token = 2 USD, 6 decimals: 1 USD = 500_000 units. */
const FEE_UNIT = { nativeUsd: 2, decimals: 6 };

function planned(req: Partial<Parameters<typeof plan>[1]> = {}): PlanSuccess {
  const r = plan(fixtureGraph(), { origin: A, destination: B, now: NOW, ...req });
  if (!r.ok) throw new Error(r.details.join());
  return r;
}

function input(p: PlanSuccess, extra: Partial<BuildEnvelopeInput> = {}): BuildEnvelopeInput {
  return {
    plan: p,
    originApp: APP_A,
    destinationApp: APP_B,
    sender: SENDER,
    recipient: RECIPIENT,
    payload: "0x1234",
    feeUnit: FEE_UNIT,
    now: NOW,
    ...extra,
  };
}

describe("envelope builder", () => {
  it("fills every spec field", () => {
    const p = planned({ mode: "reliable" });
    const env = buildEnvelope(input(p, { maxFeeUsd: 5, deadlineS: 3600, routers: { [H]: "0x0000000000000000000000000000000000000abc" } }));
    expect(env.route_id).toMatch(/^0x[0-9a-f]{32}$/);
    expect(env.origin).toEqual({ ledger_id: A, application: APP_A });
    expect(env.destination).toEqual({ ledger_id: B, application: APP_B });
    expect(env.sender).toBe(SENDER);
    expect(env.recipient).toBe(RECIPIENT);
    // hops[i] = i-th ledger and the edge leaving it; the destination hop has no channel.
    expect(env.hops.map((h) => h.ledger_id)).toEqual([A, H, B]);
    expect(env.hops[0]!.channel_id).toBe(toBytes32Id(p.route.hops[0]!.channelId));
    expect(env.hops[0]!.connector_id).toBe(toBytes32Id(p.route.hops[0]!.connectorId));
    expect(env.hops[1]!.router).toBe("0x0000000000000000000000000000000000000abc");
    expect(env.hops[2]).toMatchObject({ channel_id: "0x", connector_id: "0x", fee: 0n });
    // Each A→H and H→B hop costs 1 USD = 500_000 units at 2 USD per token, 6 decimals.
    expect(env.hops.map((h) => h.fee)).toEqual([500_000n, 500_000n, 0n]);
    expect(env.hop_index).toBe(0);
    expect(env.mode).toBe("reliable");
    expect(env.constraints).toEqual({
      filters: [],
      deadline: NOW_S + 3600n,
      max_fee: 2_500_000n,
      remaining_fee_budget: 2_500_000n,
      trust_floor: "light-client",
      max_hops: 3,
      loose: true, // data defaults to loose routing
      energy_cap: 0n,
    });
    expect(env.payload_type).toBe("raw");
    expect(env.payload).toBe("0x1234");
    expect(env.receipt_path).toEqual([]); // auto = reverse hops
    expect(env.origin_signature).toBe("0x");
    expect(env.filter_registry_versions).toEqual([]);
    expect(env.router_version).toBe(1);
    expect(envelopeUetr(env)).toBeUndefined();
  });

  it("an explicit reverse receipt path uses the same Channels backwards", () => {
    const env = buildEnvelope(input(planned({ mode: "reliable" }), { receiptPath: "reverse" }));
    expect(env.receipt_path.map((h) => h.ledger_id)).toEqual([B, H, A]);
    expect(env.receipt_path.map((h) => h.channel_id)).toEqual([env.hops[1]!.channel_id, env.hops[0]!.channel_id, "0x"]);
  });

  it("asset payloads default to strict routing", () => {
    const env = buildEnvelope(input(planned(), { asset: { symbol: "USDC", micaClass: "EMT" } }));
    expect(env.payload_type).toBe("asset");
    expect(env.constraints.loose).toBe(false);
  });

  it("ISO 20022: route id is the UETR, payload_type iso20022, registry pinned to the planning time", () => {
    const p = planned({ mode: "fastest", filters: { iso20022: true } });
    const env = buildEnvelope(input(p, { payload: HASH, payloadProtection: "hash" }));
    expect(env.payload_type).toBe("iso20022");
    const uetr = envelopeUetr(env)!;
    expect(uetr).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uetr).toBe(routeIdToUuid(env.route_id));
    expect(env.constraints.filters).toEqual(["ISO20022"]);
    expect(env.filter_registry_versions).toEqual([{ filter: "ISO20022", version: NOW_S }]);
    expect(env.hops.map((h) => h.ledger_id)).toEqual([A, Y, B]);
  });

  it("ISO 20022 refuses plaintext payloads, wrong payload types and non-UUIDv4 route ids", () => {
    const p = planned({ mode: "fastest", filters: { iso20022: true } });
    expect(() => buildEnvelope(input(p))).toThrow(/never plaintext/);
    expect(() => buildEnvelope(input(p, { payloadType: "raw", payloadProtection: "ciphertext" }))).toThrow(/iso20022/);
    expect(() => buildEnvelope(input(p, { payload: HASH, payloadProtection: "hash", routeId: `0x${"00".repeat(16)}` }))).toThrow(
      /UUIDv4/,
    );
    expect(() => buildEnvelope(input(p, { payload: "0x12", payloadProtection: "hash" }))).toThrow(/32 bytes/);
  });

  it("MiCA refuses stablecoins that are not EMTs or ARTs", () => {
    const p = planned({ mode: "cheapest", filters: { mica: true } });
    expect(() => buildEnvelope(input(p, { asset: { symbol: "USDT", micaClass: "other" }, payloadProtection: "ciphertext" }))).toThrow(
      /USDT is not a MiCA-authorised EMT or ART/,
    );
    const env = buildEnvelope(input(p, { asset: { symbol: "EURC", micaClass: "EMT" }, payloadProtection: "ciphertext" }));
    expect(env.filter_registry_versions).toEqual([{ filter: "MICA", version: NOW_S }]);
    expect(() => buildEnvelope(input(p, { asset: { symbol: "EURC", micaClass: "EMT" } }))).toThrow(/plaintext/);
  });

  it("ENERGY cap is carried in grams, rounded up", () => {
    const p = planned({ mode: "greenest", filters: { mica: true, energy: { capKgPerTx: 0.0105 } } });
    const env = buildEnvelope(input(p, { payloadProtection: "ciphertext" }));
    expect(env.constraints.filters).toEqual(["MICA", "ENERGY"]);
    expect(env.constraints.energy_cap).toBe(11n);
  });

  it("checks sender and recipient CAIP-10 ids against the route ends", () => {
    const p = planned();
    expect(() => buildEnvelope(input(p, { sender: RECIPIENT }))).toThrow(/origin/);
    expect(() => buildEnvelope(input(p, { recipient: SENDER }))).toThrow(/destination/);
    expect(() => buildEnvelope(input(p, { sender: "nonsense" }))).toThrow(/CAIP-10/);
    expect(parseCaip10("eip155:1:0xabc")).toEqual({ chain: "eip155:1", address: "0xabc" });
  });

  it("checks constraints against the route", () => {
    const p = planned({ mode: "reliable" });
    expect(() => buildEnvelope(input(p, { maxFeeUsd: 0.5 }))).toThrow(/maxFeeUsd/);
    expect(() => buildEnvelope(input(p, { maxHops: 1 }))).toThrow(/maxHops/);
    expect(() => buildEnvelope(input(p, { trustFloor: "validity-proof" }))).toThrow(/below the floor/);
  });

  it("can send on the fallback route", () => {
    const p = planned({ mode: "reliable" });
    const env = buildEnvelope(input(p, { route: p.fallback!.route }));
    expect(env.hops.map((h) => h.ledger_id)).toEqual(p.fallback!.route.ledgers);
  });

  it("random route ids are UUIDv4 and unique; 32-byte ids pass through, readable ids are hashed", () => {
    const ids = new Set(Array.from({ length: 50 }, randomRouteId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(routeIdToUuid(id)[14]).toBe("4");
    expect(toBytes32Id(HASH)).toBe(HASH);
    expect(toBytes32Id("ch-1")).toBe(keccak256(stringToBytes("ch-1")));
  });
});

describe("protobuf codec", () => {
  function full(): ClprRouteEnvelope {
    const p = planned({ mode: "fastest", filters: { iso20022: true, energy: { capKgPerTx: 1 } } });
    return buildEnvelope(
      input(p, {
        payload: HASH,
        payloadProtection: "hash",
        receiptPath: "reverse",
        feePayees: { 0: "0x00000000000000000000000000000000000000fe" },
        routerVersion: 3,
      }),
    );
  }

  it("round-trips every field", () => {
    const env = full();
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
    const minimal = buildEnvelope(input(planned()));
    expect(decodeEnvelope(encodeEnvelope(minimal))).toEqual(minimal);
  });

  it("matches the proto3 wire rules of the Solidity RouteCodec", () => {
    // Minimal hand-built envelope: defaults omitted, a repeated empty hop still emitted.
    const env: ClprRouteEnvelope = {
      ...buildEnvelope(input(planned())),
      route_id: `0x${"01".repeat(16)}`,
      hops: [{ ledger_id: "", router: "0x", channel_id: "0x", connector_id: "0x", fee: 0n, fee_payee: "0x" }],
      origin: { ledger_id: "a:b", application: "0x" },
      destination: { ledger_id: "", application: "0x" },
      sender: "",
      recipient: "",
      mode: "fastest",
      payload: "0x",
      constraints: { filters: ["ISO20022", "ENERGY"], deadline: 300n, max_fee: 0n, remaining_fee_budget: 0n, trust_floor: "attested", max_hops: 0, loose: false, energy_cap: 0n },
      router_version: 0,
    };
    const expected = new ProtoWriter()
      .bytes(1, env.route_id)
      .message(2, new ProtoWriter().string(1, "a:b"))
      .element(6, new ProtoWriter())
      .uint(8, 2) // ROUTE_MODE_FASTEST
      .message(9, new ProtoWriter().uint(1, 5).uint(2, 300)) // ISO20022 | ENERGY bits
      .hex();
    expect(encodeEnvelope(env)).toBe(expected);
    // Spot-check raw bytes: field 1 (0x0a) len 16, field 2 (0x12) len 5 { 0x0a 03 "a:b" }, field 6 (0x32) len 0.
    expect(expected.startsWith(`0x0a10${"01".repeat(16)}12050a03${toHex("a:b").slice(2)}3200`)).toBe(true);
    expect(expected.endsWith("40024a05080510ac02")).toBe(true); // field 8 = 2; field 9 { 1: 5, 2: 300 }
  });

  it("decoder skips unknown fields", () => {
    const env = full();
    const extra = new ProtoWriter().uint(99, 7).string(100, "future").hex();
    const withUnknown = (encodeEnvelope(env) + extra.slice(2)) as Hex;
    expect(decodeEnvelope(withUnknown)).toEqual(env);
    expect(readFields(new ProtoWriter().uint(1, 300).finish())).toEqual([{ field: 1, wt: 0, int: 300n }]);
  });

  it("decoder rejects truncated input", () => {
    const bytes = encodeEnvelope(full());
    expect(() => decodeEnvelope(bytes.slice(0, bytes.length - 6) as Hex)).toThrow(/malformed/);
  });
});

describe("origin signature and hop advancement", () => {
  it("recovers to the signer and survives hop advancement", async () => {
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const env = await signEnvelope(buildEnvelope(input(planned({ mode: "reliable" }), { maxFeeUsd: 10 })), account);
    expect(await recoverEnvelopeSigner(env)).toBe(account.address);
    const next = advanceEnvelope(env);
    expect(next.hop_index).toBe(1);
    expect(next.constraints.remaining_fee_budget).toBe(5_000_000n - 500_000n);
    expect(await recoverEnvelopeSigner(next)).toBe(account.address);
    // Still valid after a protobuf round trip.
    expect(await recoverEnvelopeSigner(decodeEnvelope(encodeEnvelope(next)))).toBe(account.address);
    // Tampering with a signed field breaks it.
    const tampered = { ...next, recipient: `${B}:0x3333333333333333333333333333333333333333` };
    expect(await recoverEnvelopeSigner(tampered)).not.toBe(account.address);
  });

  it("refuses to advance past the destination or overspend the budget", () => {
    const env = buildEnvelope(input(planned({ mode: "reliable" })));
    const last = advanceEnvelope(advanceEnvelope(env));
    expect(() => advanceEnvelope(last)).toThrow(/destination/);
    const broke = { ...env, constraints: { ...env.constraints, remaining_fee_budget: 1n } };
    expect(() => advanceEnvelope(broke)).toThrow(/budget/);
  });
});
