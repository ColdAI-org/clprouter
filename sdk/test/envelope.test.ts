import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { keccak256, stringToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";
import type { BuildEnvelopeInput, ClprRouteEnvelope, PlanSuccess } from "../src/index.js";
import {
  DEFAULT_ONCHAIN_TRUST_FLOOR,
  ProtoWriter,
  advanceEnvelope,
  buildEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  envelopeUetr,
  parseCaip10,
  bytes16ToUuid,
  canonicalRouterAddress,
  deriveReceiptId,
  deriveRouteId,
  inboundKey,
  normalizeLedgerId,
  plan,
  randomUuidV4Bytes,
  readFields,
  recoverEnvelopeSigner,
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
    // The route id is derived by the origin Router at send; without a nonce the builder leaves it empty.
    expect(env.route_id).toBe("0x");
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
      trust_floor: "attested", // default on-chain floor 0: no dependence on provider labels
      max_hops: 3,
      loose: false, // the route has hop fees: value routes are strict
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

  it("an explicit reverse receipt path uses the same Channels backwards (routes without value only)", () => {
    // Fees round to zero units: a data route without value, the only kind Routers accept a receipt path on.
    const free = { nativeUsd: 1e12, decimals: 0 };
    const env = buildEnvelope(input(planned({ mode: "reliable" }), { receiptPath: "reverse", feeUnit: free }));
    expect(env.constraints.remaining_fee_budget).toBe(0n);
    expect(env.receipt_path.map((h) => h.ledger_id)).toEqual([B, H, A]);
    expect(env.receipt_path.map((h) => h.channel_id)).toEqual([env.hops[1]!.channel_id, env.hops[0]!.channel_id, "0x"]);
  });

  it("loose routing only for routes without value (Routers reject loose + value)", () => {
    const p = planned({ mode: "reliable" });
    expect(() => buildEnvelope(input(p, { loose: true }))).toThrow(/without value/);
    expect(() => buildEnvelope(input(p, { loose: true, asset: { symbol: "USDC", micaClass: "EMT" } }))).toThrow(/without value/);
    // A data route whose hops cost nothing on-chain may be loose, and is by default.
    const free = buildEnvelope(input(p, { feeUnit: { nativeUsd: 1e30, decimals: 0 }, maxFeeUsd: 2 }));
    expect(free.hops.map((h) => h.fee)).toEqual([0n, 0n, 0n]);
    expect(free.constraints.remaining_fee_budget).toBe(0n);
    expect(free.constraints.loose).toBe(true);
  });

  it("asset payloads default to strict routing", () => {
    const env = buildEnvelope(input(planned(), { asset: { symbol: "USDC", micaClass: "EMT" } }));
    expect(env.payload_type).toBe("asset");
    expect(env.constraints.loose).toBe(false);
  });

  it("ISO 20022: UETR in iso_uetr (not the route id), payload_type iso20022, registry pinned", () => {
    const p = planned({ mode: "fastest", filters: { iso20022: true } });
    const env = buildEnvelope(input(p, { payload: HASH, payloadProtection: "hash", registryVersion: 42n }));
    expect(env.payload_type).toBe("iso20022");
    const uetr = envelopeUetr(env)!;
    expect(uetr).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uetr).toBe(bytes16ToUuid(env.iso_uetr));
    expect(env.route_id).toBe("0x");
    const given = buildEnvelope(
      input(p, { payload: HASH, payloadProtection: "hash", registryVersion: 42n, isoUetr: "8a562c67-ca16-48ba-b074-65581be6f001" }),
    );
    expect(given.iso_uetr).toBe("0x8a562c67ca1648bab07465581be6f001");
    expect(env.constraints.filters).toEqual(["ISO20022"]);
    // ProviderRegistry.version() is a decision counter, not the planning time.
    expect(env.filter_registry_versions).toEqual([{ filter: "ISO20022", version: 42n }]);
    expect(env.hops.map((h) => h.ledger_id)).toEqual([A, Y, B]);
  });

  it("ISO 20022 refuses plaintext payloads, wrong payload types and non-UUIDv4 UETRs", () => {
    const p = planned({ mode: "fastest", filters: { iso20022: true } });
    expect(() => buildEnvelope(input(p, { registryVersion: 1n }))).toThrow(/never plaintext/);
    expect(() => buildEnvelope(input(p, { payloadType: "raw", payloadProtection: "ciphertext", registryVersion: 1n }))).toThrow(/iso20022/);
    expect(() =>
      buildEnvelope(input(p, { payload: HASH, payloadProtection: "hash", isoUetr: `0x${"00".repeat(16)}`, registryVersion: 1n })),
    ).toThrow(/UUIDv4/);
    expect(() => buildEnvelope(input(p, { payload: "0x12", payloadProtection: "hash", registryVersion: 1n }))).toThrow(/32 bytes/);
  });

  it("MiCA refuses stablecoins that are not EMTs or ARTs", () => {
    const p = planned({ mode: "cheapest", filters: { mica: true } });
    const v = { registryVersion: 7n };
    expect(() => buildEnvelope(input(p, { ...v, asset: { symbol: "USDT", micaClass: "other" }, payloadProtection: "ciphertext" }))).toThrow(
      /USDT is not a MiCA-authorised EMT or ART/,
    );
    const env = buildEnvelope(input(p, { ...v, asset: { symbol: "EURC", micaClass: "EMT" }, payloadProtection: "ciphertext" }));
    expect(env.filter_registry_versions).toEqual([{ filter: "MICA", version: 7n }]);
    expect(() => buildEnvelope(input(p, { ...v, asset: { symbol: "EURC", micaClass: "EMT" } }))).toThrow(/plaintext/);
  });

  it("filtered routes need the registry version (never a timestamp fallback)", () => {
    const p = planned({ mode: "cheapest", filters: { mica: true } });
    expect(() => buildEnvelope(input(p, { payloadProtection: "ciphertext" }))).toThrow(/registryVersion/);
    // Unfiltered routes pin nothing and need no version.
    expect(buildEnvelope(input(planned())).filter_registry_versions).toEqual([]);
  });

  it("ENERGY cap is carried in µgCO2e (the registry's unit), rounded up", () => {
    const p = planned({ mode: "greenest", filters: { mica: true, energy: { capKgPerTx: 0.0105 } } });
    const env = buildEnvelope(input(p, { payloadProtection: "ciphertext", registryVersion: 3n }));
    expect(env.constraints.filters).toEqual(["MICA", "ENERGY"]);
    expect(env.constraints.energy_cap).toBe(10_500_000n); // 0.0105 kg = 10.5 g = 10_500_000 µg
    expect(env.filter_registry_versions).toEqual([
      { filter: "MICA", version: 3n },
      { filter: "ENERGY", version: 3n },
    ]);
    // Rounded up, never stricter than asked: 2.4e-9 kg = 2.4 µg -> 3 µg.
    expect(buildEnvelope(input(p, { payloadProtection: "ciphertext", registryVersion: 3n, energyCapKgPerTx: 2.4e-9 })).constraints.energy_cap).toBe(3n);
    expect(() => buildEnvelope(input(p, { payloadProtection: "ciphertext", registryVersion: 3n, energyCapKgPerTx: 0 }))).toThrow(/no cap/);
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

  it("on-chain trust floor defaults to 0 and is opt-in", () => {
    const p = planned({ mode: "reliable", constraints: { trustFloor: "light-client" } });
    expect(p.route.effectiveTrustTier).toBe("light-client"); // the planner still ranks and filters by tier
    expect(buildEnvelope(input(p)).constraints.trust_floor).toBe(DEFAULT_ONCHAIN_TRUST_FLOOR);
    expect(DEFAULT_ONCHAIN_TRUST_FLOOR).toBe("attested");
    const strict = buildEnvelope(input(p, { trustFloor: "light-client" }));
    expect(strict.constraints.trust_floor).toBe("light-client");
    expect(decodeEnvelope(encodeEnvelope(strict)).constraints.trust_floor).toBe("light-client");
  });

  it("can send on the fallback route", () => {
    const p = planned({ mode: "reliable" });
    const env = buildEnvelope(input(p, { route: p.fallback!.route }));
    expect(env.hops.map((h) => h.ledger_id)).toEqual(p.fallback!.route.ledgers);
  });

  it("random UETR bytes are UUIDv4 and unique; 32-byte ids pass through, readable ids are hashed", () => {
    const ids = new Set(Array.from({ length: 50 }, randomUuidV4Bytes));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(bytes16ToUuid(id)[14]).toBe("4");
    expect(toBytes32Id(HASH)).toBe(HASH);
    expect(toBytes32Id("ch-1")).toBe(keccak256(stringToBytes("ch-1")));
  });
});

describe("ids, canonical Routers and ledger ids", () => {
  const DEPLOYMENT = {
    deployer: "0x00000000000000000000000000000000000000d1" as Hex,
    salt: keccak256(stringToBytes("clprouter-test")),
    initCodeHash: keccak256(stringToBytes("init")),
  };

  it("predicts the Router-derived route id from the sender's nonce", () => {
    const p = planned();
    const router = canonicalRouterAddress(DEPLOYMENT, A);
    const env = buildEnvelope(input(p, { deployment: DEPLOYMENT, nonce: 3n }));
    expect(env.hops[0]!.router).toBe(router);
    expect(env.hops[1]!.router).toBe(canonicalRouterAddress(DEPLOYMENT, H));
    expect(env.route_id).toBe(deriveRouteId(A, router, "0x1111111111111111111111111111111111111111", 3n));
    expect(deriveRouteId(A, router, "0x1111111111111111111111111111111111111111", 4n)).not.toBe(env.route_id);
    const receipt = deriveReceiptId(A, router, env.route_id, 2);
    expect(receipt).toMatch(/^0x[0-9a-f]{32}$/);
    expect(receipt).not.toBe(env.route_id);
    expect(inboundKey(A, router, env.route_id)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses an explicit receipt path on a route that carries value", () => {
    expect(() => buildEnvelope(input(planned(), { receiptPath: "reverse" }))).toThrow(/receipt path/);
  });

  it("accepts bare EIP-155 chain ids and emits CAIP-2", () => {
    expect(normalizeLedgerId("296")).toBe("eip155:296");
    expect(normalizeLedgerId("hedera:testnet")).toBe("hedera:testnet");
    expect(parseCaip10("296:0xabc")).toEqual({ chain: "eip155:296", address: "0xabc" });
  });
});

describe("protobuf codec", () => {
  function full(): ClprRouteEnvelope {
    const p = planned({ mode: "fastest", filters: { iso20022: true, energy: { capKgPerTx: 1 } } });
    const env = buildEnvelope(
      input(p, {
        payload: HASH,
        payloadProtection: "hash",
        feePayees: { 0: "0x00000000000000000000000000000000000000fe" },
        routerVersion: 3,
        registryVersion: 12n,
      }),
    );
    // Exercise every field: an explicit receipt path and a route id (Routers would refuse the path with value).
    return {
      ...env,
      route_id: `0x${"5a".repeat(16)}`,
      receipt_path: [...env.hops].reverse().map((h) => ({ ...h, connector_id: "0x", fee: 0n, fee_payee: "0x" })),
    };
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

  it("decoder accepts only the canonical encoding (like RouteCodec)", () => {
    const env = full();
    const bytes = encodeEnvelope(env);
    const extra = new ProtoWriter().uint(99, 7).hex();
    expect(() => decodeEnvelope((bytes + extra.slice(2)) as Hex)).toThrow(/malformed/); // unknown field
    expect(() => decodeEnvelope(`${bytes}3801` as Hex)).toThrow(/malformed/); // hop_index twice / out of order
    expect(() => decodeEnvelope("0x388100")).toThrow(/malformed/); // over-long varint
    expect(() => decodeEnvelope("0x3800")).toThrow(/malformed/); // explicit default
    expect(() => decodeEnvelope("0x4a0238014a023801")).toThrow(/malformed/); // singular message twice
    expect(decodeEnvelope(bytes)).toEqual(env);
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
