/**
 * Cross-check against the Solidity codec: every vector in vectors/route-envelope.json was produced by
 * test/unit/RouteCodecVectors.t.sol as (abi.encode(RouteTypes.Envelope), RouteCodec.encodeEnvelope(envelope)).
 * The SDK must encode the same envelope to the same bytes, and decode those bytes back to the same envelope.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import type { ClprRouteEnvelope, FilterLabel, Mode, PayloadType, RouteHop } from "../src/index.js";
import { TRUST_TIER_ORDER, decodeEnvelope, encodeEnvelope } from "../src/index.js";

interface Vector {
  name: string;
  envelopeAbi: Hex;
  protobuf: Hex;
}

const file = join(dirname(fileURLToPath(import.meta.url)), "vectors", "route-envelope.json");
const { vectors } = JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] };

const HOP = {
  type: "tuple[]",
  components: [
    { name: "ledgerId", type: "string" },
    { name: "router", type: "bytes" },
    { name: "channelId", type: "bytes32" },
    { name: "connectorId", type: "bytes32" },
    { name: "fee", type: "uint64" },
    { name: "feePayee", type: "bytes" },
  ],
} as const;
const ENDPOINT = {
  type: "tuple",
  components: [
    { name: "ledgerId", type: "string" },
    { name: "application", type: "bytes" },
  ],
} as const;

/** `RouteTypes.Envelope` (src/libraries/RouteTypes.sol), in declaration order. */
const ENVELOPE_ABI = [
  {
    type: "tuple",
    components: [
      { name: "routeId", type: "bytes16" },
      { name: "origin", ...ENDPOINT },
      { name: "destination", ...ENDPOINT },
      { name: "sender", type: "string" },
      { name: "recipient", type: "string" },
      { name: "hops", ...HOP },
      { name: "hopIndex", type: "uint32" },
      { name: "mode", type: "uint8" },
      {
        name: "constraints",
        type: "tuple",
        components: [
          { name: "filters", type: "uint32" },
          { name: "deadline", type: "uint64" },
          { name: "maxFee", type: "uint64" },
          { name: "remainingFeeBudget", type: "uint64" },
          { name: "trustFloor", type: "uint32" },
          { name: "maxHops", type: "uint32" },
          { name: "loose", type: "bool" },
          { name: "energyCap", type: "uint64" },
        ],
      },
      { name: "payloadType", type: "uint8" },
      { name: "payload", type: "bytes" },
      { name: "receiptPath", ...HOP },
      { name: "originSignature", type: "bytes" },
      {
        name: "filterRegistryVersions",
        type: "tuple[]",
        components: [
          { name: "filter", type: "uint32" },
          { name: "version", type: "uint64" },
        ],
      },
      { name: "routerVersion", type: "uint32" },
    ],
  },
] as const;

const MODES: Mode[] = ["balanced", "cheapest", "fastest", "reliable", "greenest"];
const PAYLOAD_TYPES: PayloadType[] = ["raw", "iso20022", "asset", "receipt"];
const FILTERS: [FilterLabel, number][] = [
  ["ISO20022", 1],
  ["MICA", 2],
  ["ENERGY", 4],
];

/** Solidity's zero bytes16 / bytes32 means "field absent"; the SDK writes absent ids as `0x`. */
const id = (h: Hex): Hex => (/^0x0*$/.test(h) ? "0x" : h);

function fromAbi(data: Hex): ClprRouteEnvelope {
  const [e] = decodeAbiParameters(ENVELOPE_ABI, data);
  const hop = (h: (typeof e.hops)[number]): RouteHop => ({
    ledger_id: h.ledgerId,
    router: h.router,
    channel_id: id(h.channelId),
    connector_id: id(h.connectorId),
    fee: h.fee,
    fee_payee: h.feePayee,
  });
  const filterOf = (bit: number) => FILTERS.find(([, b]) => b === bit)![0];
  const c = e.constraints;
  return {
    route_id: id(e.routeId),
    origin: { ledger_id: e.origin.ledgerId, application: e.origin.application },
    destination: { ledger_id: e.destination.ledgerId, application: e.destination.application },
    sender: e.sender,
    recipient: e.recipient,
    hops: e.hops.map(hop),
    hop_index: e.hopIndex,
    mode: MODES[e.mode]!,
    constraints: {
      filters: FILTERS.filter(([, b]) => c.filters & b).map(([f]) => f),
      deadline: c.deadline,
      max_fee: c.maxFee,
      remaining_fee_budget: c.remainingFeeBudget,
      trust_floor: TRUST_TIER_ORDER[c.trustFloor]!,
      max_hops: c.maxHops,
      loose: c.loose,
      energy_cap: c.energyCap,
    },
    payload_type: PAYLOAD_TYPES[e.payloadType]!,
    payload: e.payload,
    receipt_path: e.receiptPath.map(hop),
    origin_signature: e.originSignature,
    filter_registry_versions: e.filterRegistryVersions.map((v) => ({ filter: filterOf(v.filter), version: v.version })),
    router_version: e.routerVersion,
  };
}

describe("Solidity RouteCodec vectors", () => {
  it("covers the committed fixture", () => {
    expect(vectors.map((v) => v.name)).toEqual([
      "empty",
      "route-id-and-empty-hop",
      "full-three-hops",
      "uint-maxima",
      "receipt",
      "utf8-strings",
      "filters-iso-energy",
    ]);
  });

  for (const v of vectors) {
    it(`${v.name}: SDK bytes equal RouteCodec.encodeEnvelope`, () => {
      const env = fromAbi(v.envelopeAbi);
      expect(encodeEnvelope(env)).toBe(v.protobuf);
      expect(decodeEnvelope(v.protobuf)).toEqual(env);
    });
  }

  it("all-zero ids are omitted like Solidity's zero bytes16 / bytes32", () => {
    const env = fromAbi(vectors.find((v) => v.name === "full-three-hops")!.envelopeAbi);
    const zero32 = `0x${"00".repeat(32)}` as Hex;
    const withZeros: ClprRouteEnvelope = {
      ...env,
      hops: env.hops.map((h) => (h.channel_id === "0x" ? { ...h, channel_id: zero32, connector_id: zero32 } : h)),
    };
    expect(encodeEnvelope(withZeros)).toBe(encodeEnvelope(env));
    expect(encodeEnvelope({ ...env, route_id: `0x${"00".repeat(16)}` })).toBe(encodeEnvelope({ ...env, route_id: "0x" }));
  });
});
