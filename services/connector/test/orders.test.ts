// SPDX-License-Identifier: MIT
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/log.js";
import { ledgerHash } from "../src/config.js";
import { deliveryHash, deliveryStruct } from "../src/deliver.js";
import { reconcile, Status } from "../src/orders.js";
import type { QuoteResponse } from "../src/quote.js";
import { toBytes32 } from "../src/quote.js";
import type { DeliveryJson } from "../src/store.js";
import { Store } from "../src/store.js";
import { connectorAccount, fakeLedger, ORDER_BOOK, tmpStorePath, ZERO } from "./fixtures.js";

const ID = `0x${"ab".repeat(32)}` as Hex;
const Z32 = `0x${"0".repeat(64)}` as Hex;
const order = (status: number) => [connectorAccount.address, status, 0n, ZERO, 0n, ZERO, Z32, Z32, Z32, 0n, 0n, 0n] as const;
const delivery: DeliveryJson = { orderId: ID, asset: Z32, recipient: toBytes32("0x0000000000000000000000000000000000001234"), amount: "5", deliveredAt: 1_800_000_100, deliverer: toBytes32(connectorAccount.address) };

function storeWith(o: { delivered?: boolean; skipped?: string }): Store {
  const s = Store.open(tmpStorePath());
  s.update((d) => {
    d.quotes[ID] = { orderId: ID, owedOnDefault: "1", expiry: 0, response: { srcLedgerId: "eip155:31001", dstLedgerId: "eip155:31002" } as QuoteResponse };
    d.deposits[ID] = { orderId: ID } as never;
    if (o.delivered) d.deliveries[ID] = { orderId: ID, ledgerId: "eip155:31002", fromBlock: 1, delivery };
    if (o.skipped) d.skipped[ID] = { reason: o.skipped, at: 0 };
  });
  return s;
}

describe("order settlement", () => {
  it("closes an open order whose delivery the order book recorded first", async () => {
    const s = storeWith({ delivered: true });
    const seenArgs: unknown[] = [];
    const h = fakeLedger({ ledgerId: "eip155:31003", reads: { orders: () => order(Status.OPEN), deliverySeen: (a) => (seenArgs.push(...a), true) } });
    const r = await reconcile(h, ORDER_BOOK, s, { cancelUndeliverable: false, log: silentLogger });
    expect(r.closed).toEqual([ID]);
    expect(seenArgs).toEqual([ID, deliveryHash(ledgerHash("eip155:31002"), delivery)]);
    expect(h.sent).toEqual([{ functionName: "closeWithRecordedDelivery", args: [ledgerHash("eip155:31002"), deliveryStruct(delivery)] }]);
    expect(s.data.closed[ID]!.how).toBe("recorded");
    expect(s.data.quotes[ID]!.openedStatus).toBe(Status.DELIVERED);
  });

  it("leaves an open order alone while its delivery is still in flight", async () => {
    const s = storeWith({ delivered: true });
    const h = fakeLedger({ ledgerId: "eip155:31003", reads: { orders: () => order(Status.OPEN), deliverySeen: () => false } });
    const r = await reconcile(h, ORDER_BOOK, s, { cancelUndeliverable: false, log: silentLogger });
    expect(r.closed).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(s.data.quotes[ID]!.openedStatus).toBe(Status.OPEN);
  });

  it("records orders settled by the delivery message and does not cancel skipped ones unless asked", async () => {
    const s = storeWith({ delivered: true });
    const h = fakeLedger({ ledgerId: "eip155:31003", reads: { orders: () => order(Status.DELIVERED) } });
    expect((await reconcile(h, ORDER_BOOK, s, { cancelUndeliverable: false, log: silentLogger })).settled).toEqual([ID]);

    const late = storeWith({ skipped: "too-late" });
    const h2 = fakeLedger({ ledgerId: "eip155:31003", reads: { orders: () => order(Status.OPEN) } });
    expect((await reconcile(h2, ORDER_BOOK, late, { cancelUndeliverable: false, log: silentLogger })).cancelled).toEqual([]);
    expect((await reconcile(h2, ORDER_BOOK, late, { cancelUndeliverable: true, log: silentLogger })).cancelled).toEqual([ID]);
    expect(h2.sent.map((x) => x.functionName)).toEqual(["cancelOrder"]);

    // A Connector simulating a missed deadline never cancels: the user claims the default.
    const missed = storeWith({ skipped: "skip-delivery" });
    const h3 = fakeLedger({ ledgerId: "eip155:31003", reads: { orders: () => order(Status.OPEN) } });
    await reconcile(h3, ORDER_BOOK, missed, { cancelUndeliverable: true, log: silentLogger });
    expect(h3.sent).toEqual([]);
  });
});
