// SPDX-License-Identifier: MIT
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { DecideContext } from "../src/deliver.js";
import { decide, deliveryFromLog } from "../src/deliver.js";
import type { QuoteResponse } from "../src/quote.js";
import { buildQuote, parseQuoteRequest, toBytes32 } from "../src/quote.js";
import type { DepositSeen, StoreData } from "../src/store.js";
import { emptyStore } from "../src/store.js";
import { depositFromLog } from "../src/watcher.js";
import { connectorAccount, deliveredLog, depositedLog, quoteRequest, signerAccount, testConfig } from "./fixtures.js";

const NOW = 1_800_000_000n;

async function setup(): Promise<{ d: StoreData; r: QuoteResponse; dep: DepositSeen; ctx: DecideContext }> {
  const b = await buildQuote(testConfig(), parseQuoteRequest(quoteRequest()), { now: NOW, penaltyBps: 1000n, connector: connectorAccount.address, signer: signerAccount, salt: `0x${"01".repeat(32)}` });
  const r = b.response;
  const id = r.orderId.toLowerCase();
  const d = emptyStore();
  d.quotes[id] = { orderId: id, response: r, owedOnDefault: r.owedOnDefault, expiry: r.quote.expiry };
  const dep = depositFromLog(
    depositedLog({ orderId: r.orderId, connector: connectorAccount.address, user: "0x0000000000000000000000000000000000005678", signer: signerAccount.address, assetIn: r.quote.assetIn as Hex, amountIn: BigInt(r.quote.amountIn), payTo: r.quote.payTo as Hex }),
    "eip155:31001",
  )!;
  const ctx: DecideContext = { connector: connectorAccount.address, signer: signerAccount.address, dstNow: NOW + 60n, minDeliveryMarginS: 30 };
  return { d, r, dep, ctx };
}

describe("delivery decision", () => {
  it("delivers a deposit that matches the issued quote", async () => {
    const { d, dep, ctx } = await setup();
    expect(decide(d, dep, ctx)).toEqual({ kind: "deliver" });
  });

  it("ignores unknown orders and finished ones", async () => {
    const { d, dep, ctx } = await setup();
    expect(decide(d, { ...dep, orderId: `0x${"99".repeat(32)}` }, ctx)).toEqual({ kind: "ignore", reason: "unknown-order" });
    d.skipped[dep.orderId] = { reason: "too-late", at: 0 };
    expect(decide(d, dep, ctx).kind).toBe("ignore");
  });

  it("skips deposits that do not match the quote", async () => {
    const { d, dep, ctx } = await setup();
    expect(decide(d, { ...dep, signer: connectorAccount.address }, ctx)).toEqual({ kind: "skip", reason: "wrong-signer" });
    expect(decide(d, { ...dep, amountIn: "1" }, ctx)).toEqual({ kind: "skip", reason: "amount-mismatch" });
    expect(decide(d, { ...dep, payTo: toBytes32(signerAccount.address) }, ctx)).toEqual({ kind: "skip", reason: "payee-mismatch" });
    expect(decide(d, { ...dep, assetIn: `0x${"0".repeat(63)}1` }, ctx)).toEqual({ kind: "skip", reason: "asset-mismatch" });
    expect(decide(d, { ...dep, connector: signerAccount.address }, ctx)).toEqual({ kind: "skip", reason: "wrong-connector" });
    expect(decide(d, { ...dep, ledgerId: "eip155:31002" }, ctx)).toEqual({ kind: "skip", reason: "wrong-source-chain" });
  });

  it("skips when too close to the deadline", async () => {
    const { d, r, dep, ctx } = await setup();
    const deadline = BigInt(r.quote.deadline);
    expect(decide(d, dep, { ...ctx, dstNow: deadline - 30n }).kind).toBe("deliver");
    expect(decide(d, dep, { ...ctx, dstNow: deadline - 29n })).toEqual({ kind: "skip", reason: "too-late" });
    expect(decide(d, dep, { ...ctx, dstNow: deadline + 100n })).toEqual({ kind: "skip", reason: "too-late" });
  });

  it("honours --skip-delivery for all orders or one order", async () => {
    const { d, dep, ctx } = await setup();
    expect(decide(d, dep, { ...ctx, skip: "all" })).toEqual({ kind: "skip", reason: "skip-delivery" });
    expect(decide(d, dep, { ...ctx, skip: dep.orderId.toUpperCase().replace("0X", "0x") })).toEqual({ kind: "skip", reason: "skip-delivery" });
    expect(decide(d, dep, { ...ctx, skip: `0x${"77".repeat(32)}` })).toEqual({ kind: "deliver" });
  });
});

describe("delivery struct", () => {
  it("rebuilds SettleTypes.Delivery from a Delivered log", () => {
    const orderId = `0x${"ab".repeat(32)}` as Hex;
    const log = deliveredLog({ orderId, deliverer: connectorAccount.address, recipient: "0x0000000000000000000000000000000000001234", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: 2_500_000_000n });
    expect(deliveryFromLog(log, 1_800_000_100n)).toEqual({
      orderId,
      asset: "0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e",
      recipient: "0x0000000000000000000000000000000000000000000000000000000000001234",
      amount: "2500000000",
      deliveredAt: 1_800_000_100,
      deliverer: toBytes32(connectorAccount.address),
    });
  });
});
