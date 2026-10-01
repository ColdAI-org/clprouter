import type { Hex } from "viem";
import { decodeFunctionData, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { ROUTER_ABI } from "../src/abi.js";
import { isLocalRpc } from "../src/config.js";
import { EventBus } from "../src/indexer.js";
import { Store } from "../src/store.js";
import { ForwardTrigger, type RouterChain } from "../src/trigger.js";
import { ADDR, R, ev, h32, rid } from "./helpers.js";

const B = "eip155:31002";

class MockRouter implements RouterChain {
  state = new Map<string, { hop: number; hash: Hex }>();
  outboxKeys = new Set<string>();
  calls: string[] = [];
  failNext = 0;
  async hopState(id: Hex) {
    return this.state.get(id)?.hop ?? 0;
  }
  async pendingHash(id: Hex) {
    return this.state.get(id)?.hash ?? (`0x${"0".repeat(64)}` as Hex);
  }
  async outbox(k: Hex) {
    return this.outboxKeys.has(k);
  }
  async forward(envelope: Hex) {
    if (this.failNext-- > 0) throw new Error("execution reverted");
    this.calls.push(`forward:${envelope}`);
    for (const [id, s] of this.state) if (s.hash === keccak256(envelope)) this.state.set(id, { hop: 3, hash: s.hash });
    return h32(`tx${this.calls.length}`);
  }
  async flush(_c: Hex, _k: Hex, _t: Hex, data: Hex) {
    this.calls.push(`flush:${data}`);
    return h32(`tx${this.calls.length}`);
  }
}

function setup(chain?: MockRouter, completeRejected = false) {
  const store = new Store();
  const bus = new EventBus();
  const t = new ForwardTrigger({ store, bus, routers: { [B]: ADDR.router }, chains: chain ? { [B]: chain } : {}, completeRejected });
  t.start();
  return { store, bus, t };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("forward trigger", () => {
  it("completes a pending forward with Router.forward(envelope, [])", async () => {
    const chain = new MockRouter();
    const envelope: Hex = "0xdeadbeef";
    chain.state.set(rid(1), { hop: 2, hash: keccak256(envelope) });
    const { bus, store } = setup(chain);
    bus.emitEvent(ev(B, R.pending(rid(1), 1, envelope), { block: 5 }));
    await settle();
    expect(chain.calls).toEqual([`forward:${envelope}`]);
    expect(store.jobs()[0]).toMatchObject({ kind: "forward", status: "done", attempts: 1, txHash: h32("tx1") });
  });

  it("skips a hop someone else already completed", async () => {
    const chain = new MockRouter();
    chain.state.set(rid(1), { hop: 3, hash: `0x${"0".repeat(64)}` }); // FORWARDED
    const { bus, store } = setup(chain);
    bus.emitEvent(ev(B, R.pending(rid(1), 1, "0x01"), { block: 5 }));
    await settle();
    expect(chain.calls).toEqual([]);
    expect(store.jobs()[0]).toMatchObject({ status: "skipped" });
  });

  it("flushes deferred receipts and dedupes repeated events", async () => {
    const chain = new MockRouter();
    const key = h32("outbox-1");
    chain.outboxKeys.add(key);
    const { bus, store } = setup(chain);
    const e = ev(B, R.outbox(key, "0xcafe"), { block: 5 });
    bus.emitEvent(e);
    bus.emitEvent(e);
    await settle();
    expect(chain.calls).toEqual(["flush:0xcafe"]);
    expect(store.jobs()).toHaveLength(1);
  });

  it("records a failure and retries on the next pass, up to a limit", async () => {
    const chain = new MockRouter();
    chain.failNext = 1;
    const envelope: Hex = "0xbeef";
    chain.state.set(rid(2), { hop: 2, hash: keccak256(envelope) });
    const { bus, store, t } = setup(chain);
    bus.emitEvent(ev(B, R.pending(rid(2), 1, envelope), { block: 5 }));
    await settle();
    expect(store.jobs()[0]).toMatchObject({ status: "failed", attempts: 1, error: "execution reverted" });
    await t.process();
    expect(store.jobs()[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("only records jobs (with calldata for anyone) when it has no key for the ledger", async () => {
    const { bus, t } = setup(undefined);
    bus.emitEvent(ev(B, R.pending(rid(3), 1, "0xabcd"), { block: 5 }));
    await settle();
    const [p] = t.pending();
    expect(p).toMatchObject({ status: "pending", router: ADDR.router });
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: p!.calldata });
    expect(call.functionName).toBe("forward");
    expect(call.args).toEqual(["0xabcd", []]);
  });

  it("completes rejected hops only when configured, and only with an envelope", async () => {
    const chain = new MockRouter();
    const envelope: Hex = "0x0102";
    chain.state.set(rid(4), { hop: 4, hash: keccak256(envelope) }); // NACKED
    let s = setup(chain, false);
    s.bus.emitEvent(ev(B, R.rejected(rid(4), 3, envelope), { block: 5 }));
    await settle();
    expect(s.store.jobs()).toHaveLength(0);

    s = setup(chain, true);
    s.bus.emitEvent(ev(B, R.rejected(rid(4), 3, "0x"), { block: 5 })); // NACK via CLPR Response: no envelope
    s.bus.emitEvent(ev(B, R.rejected(rid(4), 3, envelope), { block: 6 }));
    await settle();
    expect(s.store.jobs()).toEqual([expect.objectContaining({ kind: "reject", status: "done" })]);
  });

  it("only treats local RPC URLs as signable", () => {
    expect(isLocalRpc("http://127.0.0.1:8545")).toBe(true);
    expect(isLocalRpc("http://localhost:7546")).toBe(true);
    expect(isLocalRpc("http://solo.localhost:7546")).toBe(true);
    expect(isLocalRpc("https://testnet.hashio.io/api")).toBe(false);
    expect(isLocalRpc("not a url")).toBe(false);
  });
});
