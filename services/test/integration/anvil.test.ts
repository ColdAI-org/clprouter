/**
 * Integration test against one local anvil: three CLPRouter "ledgers" A — B — C deployed side by side (the same
 * layout as the Solidity ThreeLedgerFixture, with the repo's MockRouteService standing in for the CLPR Service).
 * The mock services reject `sendMessage` inside delivery like the reference ClprService's reentrancy lock, so every
 * forward and receipt goes through the fallback trigger, which the services submit with an anvil test key.
 *
 * Needs `anvil` on PATH and the forge artefacts in ../out (`forge build` in the repo root); skipped otherwise.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, http, keccak256, toHex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServicesConfig } from "../../src/config.js";
import { buildServices, type Services } from "../../src/main.js";
import { keys } from "../../src/registry.js";

const OUT = fileURLToPath(new URL("../../../out/", import.meta.url));
const hasAnvil = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
/** ClprRouter MIN_SEND_GAS: gas a hop must keep for `sendMessage` (the Solidity fixtures use the same figure). */
const MIN_SEND_GAS = 1_500_000n;
const ARTEFACTS = ["ClprRouter", "ClprRouterDeployer", "MockRouteService", "ProviderRegistry", "QuarantineVault", "RouteApp"];
const hasArtefacts = ARTEFACTS.every((n) => existsSync(`${OUT}${n}.sol/${n}.json`));

type LinkRefs = Record<string, Record<string, { start: number; length: number }[]>>;
interface Artefact {
  abi: Abi;
  bytecode: Hex;
  links: LinkRefs;
}

function artefact(name: string, file = name): Artefact {
  const j = JSON.parse(readFileSync(`${OUT}${file}.sol/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex; linkReferences?: LinkRefs } };
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
}

// anvil's well-known dev accounts: #0 deploys and sends, #1 is the trigger's TEST key.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const devKey = (i: number): Hex => toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);
const DEPLOYER = devKey(0);
const TRIGGER = devKey(1);
// Provider committee test keys (5 members, k = 3, disables and blacklist need 4).
const COMMITTEE = (["0xa11ce", "0xb0b", "0xca401", "0xd00d", "0xe7e"] as const)
  .map((k) => privateKeyToAccount(toHex(BigInt(k), { size: 32 })))
  .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const K = 3;
const CONTACT = "mailto:incident@provider.example";
const IDS = ["eip155:31001", "eip155:31002", "eip155:31003"] as const;
const CH_AB = keccak256(toHex("AB"));
const CH_BC = keccak256(toHex("BC"));
const CONN = keccak256(toHex("conn"));

interface Ledger {
  id: string;
  service: Address;
  registry: Address;
  vault: Address;
  router: Address;
  app: Address;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe.skipIf(!hasAnvil || !hasArtefacts)("services against a local anvil", () => {
  let anvil: ChildProcess;
  let rpc: string;
  let pub: PublicClient;
  let wallet: WalletClient;
  let services: Services;
  let api: string;
  const L: Ledger[] = [];
  const A = () => L[0]!;
  const B = () => L[1]!;
  const C = () => L[2]!;
  const router = artefact("ClprRouter");
  const routerDeployer = artefact("ClprRouterDeployer");
  const mock = artefact("MockRouteService");
  const registry = artefact("ProviderRegistry");
  const vault = artefact("QuarantineVault");
  const app = artefact("RouteApp");

  const libraries = new Map<string, Address>();
  /** Deploy (once) and link every external library `a` needs, then return its linked bytecode. */
  async function link(a: Artefact): Promise<Hex> {
    let code = a.bytecode.slice(2);
    for (const [file, libs] of Object.entries(a.links)) {
      for (const [lib, refs] of Object.entries(libs)) {
        let addr = libraries.get(lib);
        if (!addr) {
          const base = file.split("/").pop()!.replace(/\.sol$/, "");
          addr = await deploy(artefact(lib, base), []);
          libraries.set(lib, addr);
        }
        for (const r of refs) code = code.slice(0, r.start * 2) + addr.slice(2).toLowerCase() + code.slice((r.start + r.length) * 2);
      }
    }
    return `0x${code}`;
  }

  async function deploy(a: Artefact, args: unknown[]): Promise<Address> {
    const bytecode = await link(a);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode, args, account: wallet.account!, chain: null } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error("no contract address");
    return r.contractAddress;
  }

  async function write(address: Address, abi: Abi, functionName: string, args: unknown[], value = 0n) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, value, account: wallet.account!, chain: null } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  }

  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args }) as Promise<T>;

  async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── Relay: plays the CLPR endpoints between the mock services ──────────

  const consumed = new Map<string, number>();
  /** Deliver every message `from` queued on `channel` to `to`'s Router. Returns how many were delivered. */
  async function relay(from: Ledger, to: Ledger, channel: Hex): Promise<number> {
    const count = Number(await read<bigint>(from.service, mock.abi, "sentCount"));
    let done = consumed.get(from.id) ?? 0;
    let n = 0;
    for (; done < count; done++) {
      const s = await read<{ channelId: Hex; target: Hex; data: Hex }>(from.service, mock.abi, "sent", [BigInt(done)]);
      if (s.channelId !== channel || s.target.toLowerCase() !== to.router.toLowerCase()) continue;
      await write(to.service, mock.abi, "deliver", [to.router, channel, from.router, s.data]);
      n++;
    }
    consumed.set(from.id, done);
    return n;
  }

  async function getJson(path: string): Promise<Record<string, any>> {
    return (await (await fetch(api + path)).json()) as Record<string, any>;
  }

  /** Poll the indexer and let the trigger submit, until `path` satisfies `ok`. */
  async function until(path: string, ok: (b: Record<string, any>) => boolean): Promise<Record<string, any>> {
    return waitFor(path, async () => {
      await services.indexer.pollAll();
      await services.trigger.process();
      const b = await getJson(path);
      return ok(b) ? b : undefined;
    });
  }

  function request(o: { recipient?: string; hops?: unknown[]; deadline: bigint }) {
    const hop = (l: Ledger, ch: Hex, fee: bigint) => ({ ledgerId: l.id, router: l.router, channelId: ch, connectorId: ch === `0x${"0".repeat(64)}` ? ch : CONN, fee, feePayee: "0x" });
    const zero = `0x${"0".repeat(64)}` as Hex;
    return {
      destination: { ledgerId: C().id, application: C().app },
      recipient: o.recipient ?? `${C().id}:${C().app.toLowerCase()}`,
      hops: o.hops ?? [hop(A(), CH_AB, 10n ** 16n), hop(B(), CH_BC, 2n * 10n ** 16n), hop(C(), zero, 0n)],
      mode: 2,
      constraints: { filters: 0, deadline: o.deadline, maxFee: 0n, remainingFeeBudget: 0n, trustFloor: 0, maxHops: 0, loose: false, energyCap: 0n },
      payloadType: 0,
      payload: toHex("hello from A"),
      receiptPath: [],
      originSignature: "0x",
      isoUetr: "0x00000000000000000000000000000000",
      escrow: 0n,
      payee: "0x0000000000000000000000000000000000000000",
    };
  }

  async function sendRoute(req: ReturnType<typeof request>): Promise<Hex> {
    const r = await write(A().router, router.abi, "send", [req], 3n * 10n ** 16n);
    for (const log of r.logs) {
      try {
        const d = decodeEventLog({ abi: router.abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: { routeId: Hex } };
        if (d.eventName === "RouteSent") return d.args.routeId;
      } catch {
        /* other contracts' logs */
      }
    }
    throw new Error("no RouteSent");
  }

  /** Apply a committee decision on `l`'s registry with `count` signatures. */
  async function decide(l: Ledger, action: number, payload: Hex, count: number) {
    const version = await read<bigint>(l.registry, registry.abi, "version");
    const epoch = await read<bigint>(l.registry, registry.abi, "epoch");
    const block = await pub.getBlock();
    const d = { action, payload, evidenceHash: keccak256(toHex("evidence")), nonce: version + 1n, effectiveAt: 0n, validUntil: block.timestamp + 86_400n, epoch };
    const digest = await read<Hex>(l.registry, registry.abi, "decisionDigest", [d]);
    const sigs = await Promise.all(COMMITTEE.slice(0, count).map((m) => m.signMessage({ message: { raw: digest } })));
    await write(l.registry, registry.abi, "submit", [d, sigs]);
  }

  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
    await waitFor("anvil", async () => (await pub.getBlockNumber().catch(() => undefined)) !== undefined ? true : undefined, 20_000);
    wallet = createWalletClient({ account: privateKeyToAccount(DEPLOYER), transport: http(rpc) });

    // Routers live at their canonical CREATE2 addresses, deployed through one ClprRouterDeployer.
    const routerCode = await link(router);
    const deployer = await deploy(routerDeployer, [wallet.account!.address, keccak256(toHex("clprouter-anvil")), keccak256(routerCode)]);
    const codeHash = async (a: Address) => keccak256((await pub.getCode({ address: a }))!);
    for (const id of IDS) {
      const service = await deploy(mock, [id]);
      const reg = await deploy(registry, [
        keccak256(toHex("clprouter-anvil-deployment")),
        COMMITTEE.map((m) => m.address),
        K,
        CONTACT,
        [86400n, 3600n, 86400n, 7n * 86400n, 30n * 86400n, 7n * 86400n],
      ]);
      const v = await deploy(vault, [reg, 3n * 86400n, 7n * 86400n]);
      await write(deployer, routerDeployer.abi, "deploy", [
        routerCode,
        { service, registry: reg, vault: v, ledgerId: id, reclaimGrace: 3600n, appGas: 300_000n, minSendGas: MIN_SEND_GAS },
      ]);
      const r = await read<Address>(deployer, routerDeployer.abi, "routerAddress", [id]);
      const a = await deploy(app, []);
      await write(a, app.abi, "setRouter", [r]);
      await write(service, mock.abi, "setGuard", [true]); // reference ClprService behaviour: no send inside delivery
      L.push({ id, service, registry: reg, vault: v, router: r, app: a });
    }
    await write(A().service, mock.abi, "setPeer", [CH_AB, B().id]);
    await write(B().service, mock.abi, "setPeer", [CH_AB, A().id]);
    await write(B().service, mock.abi, "setPeer", [CH_BC, C().id]);
    await write(C().service, mock.abi, "setPeer", [CH_BC, B().id]);
    // The committee approves both directions of both Channels on every ledger (each label names the verifier the
    // receiving ledger uses: the mock service stands in for it), then the certification notice (1 day) passes.
    const directions: [Hex, Ledger][] = [[CH_AB, B()], [CH_AB, A()], [CH_BC, C()], [CH_BC, B()]];
    for (const l of L) {
      for (const [ch, to] of directions) {
        const payload = encodeAbiParameters(
          [{ type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "address" }, { type: "bytes32" }],
          [ch, to.id, 0, to.service, await codeHash(to.service)],
        );
        await decide(l, 11, payload, K);
      }
    }
    await pub.request({ method: "evm_increaseTime", params: [86_401] } as never);
    await pub.request({ method: "evm_mine", params: [] } as never);

    process.env.CLPROUTER_TRIGGER_KEY_TEST = TRIGGER;
    const cfg: ServicesConfig = {
      database: ":memory:",
      ledgers: L.map((l) => ({ id: l.id, rpcUrl: rpc, confirmations: 0, contracts: { router: l.router, registry: l.registry, vault: l.vault } })),
      trigger: { enabled: true, keyEnv: "CLPROUTER_TRIGGER_KEY_TEST", completeRejected: true },
    };
    services = await buildServices(cfg, () => {});
    services.trigger.start();
    await new Promise<void>((r) => services.api.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${(services.api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    services?.api.closeAllConnections();
    await services?.stop();
    anvil?.kill("SIGTERM");
  });

  it("derives the same registry keys as Caip.sol", async () => {
    const acct = `${C().id}:0xAbC0000000000000000000000000000000000001`;
    expect(await read<Hex>(A().registry, registry.abi, "accountKey", [acct])).toBe(keys.account(acct));
    expect(await read<Hex>(A().registry, registry.abi, "edgeKey", [CH_BC, C().id])).toBe(keys.edge(CH_BC, C().id));
    expect(await read<Hex>(A().registry, registry.abi, "ledgerKey", [B().id])).toBe(keys.ledger(B().id));
    expect(await read<Hex>(A().registry, registry.abi, "routerKey", [B().id, B().router])).toBe(keys.router(B().id, B().router));
    expect(await read<Hex>(A().registry, registry.abi, "routerVersionKey", [1])).toBe(keys.routerVersion(1));
  });

  it("delivers A → B → C through the fallback trigger and reports every hop", async () => {
    const block = await pub.getBlock();
    const routeId = await sendRoute(request({ deadline: block.timestamp + 3600n }));

    await relay(A(), B(), CH_AB); // B cannot forward inside delivery → ForwardPending
    let s = await until(`/routes/${routeId}`, (b) => b.hops?.[1]?.status === "forwarded");
    expect(s.hops[1].events.map((e: { name: string }) => e.name)).toEqual(["ForwardPending", "RouteForwarded"]);
    expect(s.plannedHops.map((h: { ledger: string }) => h.ledger)).toEqual([...IDS]);

    await relay(B(), C(), CH_BC); // delivered; the receipt cannot be sent inside delivery → OutboxQueued → flush
    await until("/pending", () => true);
    await waitFor("flush", async () => {
      await services.indexer.pollAll();
      await services.trigger.process();
      return (await relay(C(), B(), CH_BC)) > 0 ? true : undefined; // receipt reaches B → OutboxQueued → flush
    });
    await waitFor("receipt forward", async () => {
      await services.indexer.pollAll();
      await services.trigger.process();
      return (await relay(B(), A(), CH_AB)) > 0 ? true : undefined; // receipt reaches the origin → settles
    });

    s = await until(`/routes/${routeId}`, (b) => b.outcome?.settled === true);
    expect(s.outcome).toMatchObject({ status: "DELIVERED", settled: true, reason: "NONE" });
    expect(s.hops.map((h: { ledger: string; status: string }) => [h.ledger, h.status])).toEqual([
      [A().id, "sent"],
      [B().id, "forwarded"],
      [C().id, "delivered"],
    ]);
    expect(s.receipts[0]).toMatchObject({ fromLedger: C().id, status: "DELIVERED" });
    // Receipts in transit wait in B's outbox (OutboxQueued is keyed by the outbox key) and leave with flush().
    expect(s.receipts[0].path.map((e: { ledger: string; name: string }) => `${e.name}@${e.ledger}`).sort()).toEqual(
      [`RouteForwarded@${C().id}`, `RouteForwarded@${B().id}`].sort(),
    );
    // Every answer names the blocks it was built from.
    for (const id of IDS) expect(s.inputs[id].blockNumber).toBeGreaterThan(0);

    const jobs = services.store.jobs();
    expect(jobs.map((j) => `${j.kind}@${j.ledger}:${j.status}`).sort()).toEqual(
      [`flush@${C().id}:done`, `forward@${B().id}:done`, `flush@${B().id}:done`].sort(),
    );
  });

  it("quarantines a transfer to a blacklisted recipient and tells both sides", async () => {
    const recipient = `${C().id}:${C().app.toLowerCase()}`;
    const caseId = keccak256(toHex("case-42"));
    await decide(A(), 5, encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "string" }], [recipient, caseId, "exploit"]), K + 1);

    const block = await pub.getBlock();
    const routeId = await sendRoute(request({ deadline: block.timestamp + 3600n }));
    const s = await until(`/routes/${routeId}`, (b) => b.outcome?.settled === true);
    expect(s.outcome).toMatchObject({ status: "QUARANTINED", reason: "BLACKLIST", caseId, contact: CONTACT });
    expect(s.quarantine).toEqual([expect.objectContaining({ ledger: A().id, caseId })]);

    const n = await getJson(`/accounts/${encodeURIComponent(recipient)}/notices`);
    expect(n.recipientNotices).toEqual([expect.objectContaining({ routeId, caseId, contact: CONTACT })]);
    const sender = await getJson(`/accounts/${encodeURIComponent(`${A().id}:${wallet.account!.address}`)}/notices`);
    expect(sender.senderReceipts).toEqual([expect.objectContaining({ routeId, caseId })]);

    const reg = await getJson(`/registry?ledger=${A().id}`);
    const a = reg.ledgers[A().id];
    expect(a.blacklist).toEqual([expect.objectContaining({ caip10: recipient, caseId })]);
    expect(a.committee).toMatchObject({ threshold: K, disableThreshold: K + 1, source: "snapshot" });
    expect(a.committee.members).toEqual(COMMITTEE.map((m) => m.address));
    expect(Object.keys(a.quarantine.heldByCase)).toEqual([caseId]);

    // Delist so later routes are not caught.
    await decide(A(), 6, encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [recipient, caseId]), K + 1); // delist needs k+1
  });

  it("stops a route at a disabled edge and refunds through a FAILED receipt", async () => {
    const edge = keys.edge(CH_BC, C().id);
    await decide(B(), 3, encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "string" }], [1, edge, "verifier bug"]), K + 1);

    const block = await pub.getBlock();
    const routeId = await sendRoute(request({ deadline: block.timestamp + 3600n }));
    await relay(A(), B(), CH_AB); // B refuses to forward onto the disabled edge; the receipt is deferred → flush
    await waitFor("failure receipt", async () => {
      await services.indexer.pollAll();
      await services.trigger.process();
      return (await relay(B(), A(), CH_AB)) > 0 ? true : undefined;
    });
    const s = await until(`/routes/${routeId}`, (b) => b.outcome?.settled === true);
    expect(s.hops[1]).toMatchObject({ ledger: B().id, status: "stopped", stop: { status: "FAILED", reason: "DISABLED_EDGE" } });
    expect(s.outcome).toMatchObject({ status: "FAILED", settled: true, reason: "DISABLED_EDGE" });

    const reg = await getJson(`/registry?ledger=${B().id}`);
    expect(reg.ledgers[B().id].disabled).toEqual([expect.objectContaining({ subject: edge, kind: "EDGE", reason: "verifier bug" })]);
  });

  it("streams a route's updates over SSE", async () => {
    const ctrl = new AbortController();
    const block = await pub.getBlock();
    const routeId = await sendRoute(request({ deadline: block.timestamp + 3600n }));
    const res = await fetch(`${api}/stream?routeId=${routeId}`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await services.indexer.pollAll();
    await relay(A(), B(), CH_AB);
    await services.indexer.pollAll();
    // The B → C edge is still disabled from the previous test, so B stops the route.
    const deadline = Date.now() + 20_000;
    while (!buf.includes('"name":"RouteStopped"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    expect(buf).toContain("event: route");
    expect(buf).toContain('"name":"RouteSent"');
    expect(buf).toContain('"name":"RouteStopped"');
    ctrl.abort();
  });
});
