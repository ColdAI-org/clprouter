// SPDX-License-Identifier: MIT
import { createPublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainIdMismatchError, ResilientRpc, parseRetryAfter } from "../src/rpc.js";
import { FakeNode } from "./fakenode.js";

const L = "eip155:31337";
let a: FakeNode;
let b: FakeNode;
const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

beforeEach(async () => {
  sleeps.length = 0;
  a = await new FakeNode().start();
  b = await new FakeNode().start();
});
afterEach(async () => {
  await a.stop();
  await b.stop();
});

const rpc = (urls: string[], extra: Partial<ConstructorParameters<typeof ResilientRpc>[0]> = {}) =>
  new ResilientRpc({ ledger: L, urls, policy: { retries: 3, backoffMs: 100, maxBackoffMs: 2000, timeoutMs: 500, cooldownMs: 1000 }, sleep, random: () => 0.5, ...extra });

describe("ResilientRpc", () => {
  it("honours Retry-After on a 429 and then succeeds on the same endpoint", async () => {
    a.faults.push({ status: 429, headers: { "retry-after": "1" }, body: { error: "slow down" } });
    const r = rpc([a.url]);
    expect(await r.request("eth_blockNumber")).toBe("0x0");
    expect(sleeps).toEqual([1000]);
    expect(a.calls).toEqual(["eth_blockNumber", "eth_blockNumber"]);
  });

  it("caps a huge Retry-After at maxBackoffMs", async () => {
    a.faults.push({ status: 429, headers: { "retry-after": "3600" } });
    await rpc([a.url]).request("eth_blockNumber");
    expect(sleeps).toEqual([2000]);
  });

  it("backs off exponentially with jitter on repeated 5xx from a single endpoint", async () => {
    a.faults.push({ status: 503 }, { status: 502 }, { status: 500 });
    expect(await rpc([a.url]).request("eth_blockNumber")).toBe("0x0");
    // full jitter with random() = 0.5: 0.5 * 100, 0.5 * 200, 0.5 * 400
    expect(sleeps).toEqual([50, 100, 200]);
  });

  it("fails over to the next endpoint without waiting, and cools the failing one down", async () => {
    a.failMethods.set("eth_blockNumber", { status: 503 });
    const r = rpc([a.url, b.url]);
    expect(await r.request("eth_blockNumber")).toBe("0x0");
    expect(b.calls).toContain("eth_blockNumber");
    expect(sleeps).toEqual([]); // no wait: another endpoint was free
    // The next request starts on b (a is cooling down).
    a.calls.length = 0;
    await r.request("eth_blockNumber");
    expect(a.calls).toEqual([]);
  });

  it("treats a JSON-RPC rate-limit error as transient", async () => {
    a.faults.push({ body: { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } } });
    expect(await rpc([a.url]).request("eth_blockNumber")).toBe("0x0");
    expect(a.calls).toHaveLength(2);
  });

  it("does not retry deterministic errors (reverts) and keeps the revert data for viem", async () => {
    const r = rpc([a.url, b.url]);
    await expect(r.request("eth_call", [{ to: "0x0000000000000000000000000000000000000001" }, "latest"])).rejects.toMatchObject({ code: 3 });
    expect(a.calls.length + b.calls.length).toBe(1);
  });

  it("times out a hanging endpoint and retries elsewhere", async () => {
    a.faults.push({ hang: true });
    const r = rpc([a.url, b.url]);
    r["next"] = 0;
    expect(await r.request("eth_blockNumber")).toBe("0x0");
    expect(b.calls).toEqual(["eth_blockNumber"]);
  });

  it("gives up after the retry budget with the last error", async () => {
    a.failMethods.set("eth_blockNumber", { status: 502 });
    await expect(rpc([a.url]).request("eth_blockNumber")).rejects.toThrow(/HTTP request failed|502/);
    expect(a.calls).toHaveLength(4);
  });

  it("checks the chain id of every endpoint: a mismatch is fatal", async () => {
    b.chainId = 1;
    const r = rpc([a.url, b.url], { chainId: 31337 });
    await expect(r.checkChainId()).rejects.toThrow(ChainIdMismatchError);
    expect(r.endpoints[1]!.disabled).toMatch(/chain id 1, expected 31337/);
    // The good endpoint still serves.
    expect(await r.request("eth_blockNumber")).toBe("0x0");
    expect(b.calls).toEqual(["eth_chainId"]);
  });

  it("verifies an endpoint that was down at startup before its first use", async () => {
    a.faults.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    const r = rpc([a.url], { chainId: 999 });
    const res = await r.checkChainId();
    expect(res[0]!.error).toBeDefined();
    expect(r.usable()).toBe(false);
    // Comes back on the wrong chain: disabled, request fails.
    await expect(r.request("eth_blockNumber")).rejects.toThrow(/disabled/);
  });

  it("plugs into viem and reports every request to the observer", async () => {
    const seen: string[] = [];
    const r = rpc([a.url], { observer: { request: (o) => seen.push(`${o.method}:${o.outcome}:${o.endpoint}`), retry: () => seen.push("retry") } });
    a.faults.push({ status: 429 });
    const client = createPublicClient({ transport: r.transport() });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(0n);
    expect(seen[0]).toMatch(/^eth_blockNumber:rate_limited:127\.0\.0\.1:\d+$/);
    expect(seen).toContain("retry");
    expect(seen.at(-1)).toMatch(/:ok:/);
  });

  it("never puts credentials from the URL into errors", async () => {
    const r = rpc([`http://user:pw@127.0.0.1:1/v3/abcdefabcdefabcdefabcdef`], { policy: { retries: 0, timeoutMs: 300 } });
    const err = (await r.request("eth_blockNumber").catch((e: Error) => e)) as Error;
    expect(String(err.message)).not.toMatch(/pw|abcdefabcdefabcdefabcdef/);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
