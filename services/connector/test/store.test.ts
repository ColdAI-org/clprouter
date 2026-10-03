// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/log.js";
import type { QuoteResponse } from "../src/quote.js";
import { toBytes32 } from "../src/quote.js";
import { Store, StoreError } from "../src/store.js";
import { scanDeposits } from "../src/watcher.js";
import { connectorAccount, depositedLog, fakeLedger, signerAccount, testConfig, tmpStorePath } from "./fixtures.js";

describe("store", () => {
  it("starts empty, saves atomically and reopens", () => {
    const p = join(dirname(tmpStorePath()), "nested", "store.json");
    const s = Store.open(p);
    expect(s.data.quotes).toEqual({});
    s.update((d) => {
      d.cursors["eip155:1"] = { block: 7, time: 70 };
    });
    expect(readdirSync(dirname(p))).toEqual(["store.json"]);
    expect(Store.open(p).data.cursors["eip155:1"]).toEqual({ block: 7, time: 70 });
  });

  it("keeps the previous file when a save fails", () => {
    const p = tmpStorePath();
    const s = Store.open(p);
    s.update((d) => {
      d.skipped.a = { reason: "x", at: 1 };
    });
    const before = readFileSync(p, "utf8");
    (s.data as unknown as { bad: bigint }).bad = 1n; // JSON.stringify throws on bigint
    expect(() => s.save()).toThrow();
    expect(readFileSync(p, "utf8")).toBe(before);
    expect(readdirSync(dirname(p))).toEqual(["store.json"]);
  });

  it("refuses a corrupt or foreign store", () => {
    const p = tmpStorePath();
    writeFileSync(p, "{not json");
    expect(() => Store.open(p)).toThrow(StoreError);
    writeFileSync(p, JSON.stringify({ version: 99 }));
    expect(() => Store.open(p)).toThrow(/version/);
  });
});

describe("deposit watcher", () => {
  const chain = testConfig().chains[0]!;
  const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  const log = (n: number, block: bigint) =>
    depositedLog({ orderId: id(n), connector: connectorAccount.address, user: connectorAccount.address, signer: signerAccount.address, assetIn: `0x${"0".repeat(64)}`, amountIn: 5n, payTo: toBytes32(connectorAccount.address), block });

  it("records deposits for known quotes, ignores others, and resumes from the cursor", async () => {
    const p = tmpStorePath();
    const s = Store.open(p);
    s.update((d) => {
      for (const n of [1, 2]) d.quotes[id(n)] = { orderId: id(n), owedOnDefault: "1", expiry: 0, response: {} as QuoteResponse };
    });
    const l1 = fakeLedger({ ledgerId: chain.ledgerId, head: 5n, logs: [log(1, 2n), log(3, 3n)] });
    const r1 = await scanDeposits(l1, { ...chain, logBatch: 2 }, s, silentLogger);
    expect(r1.found.map((x) => x.orderId)).toEqual([id(1)]);
    expect(r1.ignored).toBe(1);
    expect(l1.calls.filter((c) => c.startsWith("getLogs"))).toEqual(["getLogs:0-1", "getLogs:2-3", "getLogs:4-5"]);
    expect(s.data.cursors[chain.ledgerId]).toEqual({ block: 5, time: 1_800_000_005 });

    // A new process over the same file starts after block 5.
    const s2 = Store.open(p);
    const l2 = fakeLedger({ ledgerId: chain.ledgerId, head: 8n, logs: [log(1, 2n), log(2, 7n)] });
    const r2 = await scanDeposits(l2, chain, s2, silentLogger);
    expect(l2.calls.filter((c) => c.startsWith("getLogs"))).toEqual(["getLogs:6-8"]);
    expect(r2.found.map((x) => x.orderId)).toEqual([id(2)]);
    expect(Object.keys(Store.open(p).data.deposits).sort()).toEqual([id(1), id(2)]);
  });

  it("stays confirmations behind the head", async () => {
    const s = Store.open(tmpStorePath());
    const l = fakeLedger({ ledgerId: chain.ledgerId, head: 10n });
    const r = await scanDeposits(l, { ...chain, confirmations: 3, startBlock: 4 }, s, silentLogger);
    expect([r.fromBlock, r.toBlock]).toEqual([4, 7]);
    expect(s.data.cursors[chain.ledgerId]!.block).toBe(7);
  });
});
