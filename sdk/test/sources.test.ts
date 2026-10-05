import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex, PublicClient } from "viem";
import { concatHex, encodeAbiParameters, keccak256, pad, parseEther, toFunctionSelector, toHex } from "viem";
import { describe, expect, it } from "vitest";
import type { Edge, OnChainReader, RegistryState } from "../src/index.js";
import {
  OnChainGraphSource,
  StaticJsonSource,
  ViemOnChainReader,
  checkRegistryHeads,
  edgeId,
  plan,
  registryKeys,
} from "../src/index.js";
import { A, B, H, NOW, X, cert, fixtureGraph } from "./fixtures.js";

describe("StaticJsonSource", () => {
  it("loads from an object, a JSON string and a file", async () => {
    const g = fixtureGraph();
    const dir = mkdtempSync(join(tmpdir(), "clprouter-"));
    const file = join(dir, "graph.json");
    writeFileSync(file, JSON.stringify(g));
    for (const src of [new StaticJsonSource(g), new StaticJsonSource(JSON.stringify(g)), new StaticJsonSource({ file })]) {
      const graph = await src.load();
      expect(graph.ledgers()).toHaveLength(g.ledgers.length);
      expect(graph.edges()).toHaveLength(g.edges.length);
    }
  });

  it("does not share state with the caller's object", async () => {
    const g = fixtureGraph();
    const graph = await new StaticJsonSource(g).load();
    graph.data.ledgers[0]!.disabled = true;
    expect(g.ledgers[0]!.disabled).toBeUndefined();
  });
});

class MockReader implements OnChainReader {
  status = new Map<string, Edge["status"]>();
  balances = new Map<string, number>();
  slashes = new Map<string, number>();
  registry?: RegistryState;
  async channelState(e: Edge) {
    const s = this.status.get(edgeId(e));
    return s ? { status: s } : undefined;
  }
  async connectorState(_e: Edge, id: string) {
    const b = this.balances.get(id);
    return b === undefined ? undefined : { balanceNative: b, slashCount: this.slashes.get(id) };
  }
  async registryState() {
    return this.registry;
  }
}

const ID = (from: string, to: string) => `ch-${from}-${to}:${from}->${to}`;
const emptyRegistry = (): RegistryState => ({
  certifications: {},
  disabledLedgers: [],
  disabledEdges: [],
  disabledRouterVersions: [],
});

describe("OnChainGraphSource", () => {
  const base = new StaticJsonSource(fixtureGraph());

  it("overlays Channel status: a paused Channel drops out of planning", async () => {
    const reader = new MockReader();
    reader.status.set(ID(A, X), "paused");
    const g = await new OnChainGraphSource(base, reader).load();
    const r = plan(g, { origin: A, destination: B, mode: "cheapest", now: NOW });
    expect(r.ok && r.route.ledgers).toEqual([A, H, B]);
  });

  it("overlays Connector balances (native × price) and slashing history", async () => {
    const reader = new MockReader();
    reader.balances.set(`conn-${A}-${H}`, 42);
    reader.slashes.set(`conn-${A}-${H}`, 2);
    const g = await new OnChainGraphSource(base, reader).load();
    const c = g.edge(ID(A, H)).connectors[0]!;
    expect(c.balanceUsd).toBe(42);
    expect(c.successRate).toBeCloseTo(0.81);
  });

  it("overlays registry state: disables, revocations and versions", async () => {
    const reader = new MockReader();
    reader.registry = {
      ...emptyRegistry(),
      certifications: { [H]: { ISO20022: cert(undefined, { status: "revoked" }) } },
      disabledEdges: [ID(A, X)],
      disabledLedgers: ["test:z"],
      disabledRouterVersions: [2],
      version: 9n,
      edgeTrustTiers: { [ID(A, H)]: "attested" },
    };
    const g = await new OnChainGraphSource(base, reader).load();
    expect(g.edge(ID(A, X)).disabled).toBe(true);
    expect(g.ledger("test:z").disabled).toBe(true);
    expect(g.data.disabledRouterVersions).toEqual([2]);
    expect(g.data.registryVersion).toBe(9);
    expect(g.edge(ID(A, H)).trustTier).toBe("attested"); // the on-chain label replaces the snapshot's tier
    const iso = plan(g, { origin: A, destination: B, mode: "cheapest", filters: { iso20022: true }, now: NOW });
    expect(iso.ok && iso.route.ledgers).toEqual([A, "test:y", B]); // the hub lost its ISO listing
  });

  it("overlays Channel approvals: an edge the registry does not approve drops out of planning", async () => {
    const reader = new MockReader();
    reader.registry = { ...emptyRegistry(), edgeApproved: { [ID(A, X)]: false, [ID(A, H)]: true } };
    const g = await new OnChainGraphSource(base, reader).load();
    expect(g.edge(ID(A, X)).approved).toBe(false);
    expect(g.edge(ID(A, H)).approved).toBe(true);
    const r = plan(g, { origin: A, destination: B, mode: "cheapest", now: NOW });
    expect(r.ok && r.route.ledgers).toEqual([A, H, B]);
  });

  it("keeps the snapshot when the reader knows nothing", async () => {
    const g = await new OnChainGraphSource(base, new MockReader()).load();
    expect(g.edges().map((e) => e.status)).toEqual(fixtureGraph().edges.map((e) => e.status));
  });
});

describe("ViemOnChainReader", () => {
  const CH = pad("0x01");
  const CONN = pad("0x02");
  const SERVICE = "0x00000000000000000000000000000000000000c1" as const;
  const REGISTRY = "0x00000000000000000000000000000000000000e1" as const;
  const CONTRACT = "0x00000000000000000000000000000000000000d1" as const;
  const edge = { ...fixtureGraph().edges[0]!, channelId: CH };

  function channelReturn(status: number): Hex {
    // Mimic `getChannel` return data: (offset, channelId, verifier, status, nextMessageId, ...dynamic tail).
    return encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }, { type: "uint64" }, { type: "string" }] }],
      [[CH, CONTRACT, status, 5n, "eip155:1"]],
    );
  }

  const client = {
    async call({ data }: { data: Hex }) {
      if (data.startsWith(toFunctionSelector("getChannel(bytes32)"))) return { data: channelReturn(2) };
      if (data.startsWith(toFunctionSelector("getConnector(bytes32,bytes32)"))) {
        return {
          data: encodeAbiParameters(
            [{ type: "tuple", components: [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint32" }] }],
            [[CONN, CONTRACT, CONTRACT, 10n, 1]],
          ),
        };
      }
      return { data: undefined };
    },
    async getBalance() {
      return parseEther("12.5");
    },
    async readContract({ functionName, args }: { functionName: string; args: [Hex] }) {
      if (functionName === "version") return 6n;
      // Only CH into H is labelled; the way back (CH into the edge's `from`) is not, so the edge is not approved.
      if (functionName === "trustTier") return args[0] === registryKeys.edge(CH, H) ? [true, 1] : [false, 0];
      if (functionName === "isDisabled") {
        return [registryKeys.ledger(X), registryKeys.edge(CH, H), registryKeys.routerVersion(2)].includes(args[0]);
      }
      if (functionName === "certificationLog") {
        if (args[0] === registryKeys.cert(H, "ENERGY")) {
          return [
            { version: 1n, effectiveFrom: 100n, expiry: 1830297600n, certified: true, emissionsUg: 5_000_000n, evidenceHash: pad("0xee") },
            { version: 4n, effectiveFrom: 200n, expiry: 1830297600n, certified: true, emissionsUg: 3_000_000n, evidenceHash: pad("0xef") },
            // Scheduled after "now": not in effect yet.
            { version: 5n, effectiveFrom: 9_999_999_999n, expiry: 9_999_999_999n, certified: false, emissionsUg: 0n, evidenceHash: pad("0xf0") },
            // Appended after the version read below (a racing decision): ignored, as the Router would.
            { version: 7n, effectiveFrom: 150n, expiry: 1830297600n, certified: true, emissionsUg: 1n, evidenceHash: pad("0xf1") },
          ];
        }
        if (args[0] === registryKeys.cert(H, "MICA")) {
          return [{ version: 2n, effectiveFrom: 100n, expiry: 1830297600n, certified: false, emissionsUg: 0n, evidenceHash: pad("0xaa") }];
        }
        return [];
      }
      throw new Error(functionName);
    },
  } as unknown as PublicClient;

  const reader = new ViemOnChainReader({
    ledgers: { [H]: { client, clprService: SERVICE } },
    registry: { ledger: H, address: REGISTRY },
    ledgerIds: [H, X],
    routerVersions: [1, 2],
    edges: [edge],
    now: () => NOW,
  });

  it("reads Channel status from the static head of getChannel", async () => {
    expect(await reader.channelState(edge)).toEqual({ status: "paused" });
    expect(await reader.channelState({ ...edge, to: X })).toBeUndefined(); // no client for X
  });

  it("reads Connector balance and slash count", async () => {
    expect(await reader.connectorState(edge, CONN)).toEqual({ balanceNative: 12.5, slashCount: 1 });
  });

  it("reads registry state through the Caip key helpers", async () => {
    const s = (await reader.registryState())!;
    expect(s.certifications[H]!.ENERGY).toMatchObject({
      status: "full",
      kgCO2ePerTx: 0.003, // 3_000_000 µgCO2e/tx = 3 g, the latest entry already in effect at version 6
      effectiveFrom: 200,
      evidenceHash: pad("0xef"),
    });
    expect(s.certifications[H]!.MICA?.status).toBe("revoked");
    expect(s.certifications[H]!.ISO20022).toBeUndefined();
    expect(s.disabledLedgers).toEqual([X]);
    expect(s.disabledEdges).toEqual([edgeId(edge)]);
    expect(s.disabledRouterVersions).toEqual([2]);
    expect(s.version).toBe(6n);
    expect(s.edgeTrustTiers).toEqual({ [edgeId(edge)]: "committee" });
    expect(s.edgeApproved).toEqual({ [edgeId(edge)]: false }); // labelled one way only
  });

  it("derives the same keys as Caip.sol", () => {
    // keccak256(abi.encodePacked("ledger", "hedera:mainnet")) etc.; spot-check the packing.
    expect(registryKeys.ledger("hedera:mainnet")).toBe(keccak256(toHex("ledgerhedera:mainnet")));
    expect(registryKeys.cert("hedera:mainnet", "ENERGY")).toBe(keccak256(concatHex([toHex("cert"), "0x03", toHex("hedera:mainnet")])));
    expect(registryKeys.routerVersion(1)).toBe(keccak256(concatHex([toHex("router-version"), "0x00000001"])));
    expect(registryKeys.edge(CH, "hedera:mainnet")).toBe(keccak256(concatHex([toHex("edge"), CH, toHex("hedera:mainnet")])));
  });
});

describe("checkRegistryHeads (package entry point)", () => {
  const head = (n: number): Hex => pad(toHex(n), { size: 32 });
  const client = (h: Hex | Error) =>
    ({
      readContract: async () => {
        if (h instanceof Error) throw h;
        return h;
      },
    }) as unknown as PublicClient;
  const reg = "0x00000000000000000000000000000000000000aa" as const;

  it("is consistent when every registry reports the same head at the pinned version", async () => {
    const r = await checkRegistryHeads({ [A]: { client: client(head(7)), address: reg }, [B]: { client: client(head(7)), address: reg } }, 3n);
    expect(r.consistent).toBe(true);
    expect(r.heads[A]).toBe(head(7));
  });

  it("flags a forked or lagging registry", async () => {
    const forked = await checkRegistryHeads({ [A]: { client: client(head(7)), address: reg }, [B]: { client: client(head(8)), address: reg } }, 3n);
    expect(forked.consistent).toBe(false);
    const lagging = await checkRegistryHeads({ [A]: { client: client(head(7)), address: reg }, [B]: { client: client(new Error("no headAt")), address: reg } }, 3n);
    expect(lagging.consistent).toBe(false);
  });
});
