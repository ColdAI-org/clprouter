// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { available, isOutstanding, outstandingOwed, requireCapacity } from "../src/capacity.js";
import type { QuoteResponse } from "../src/quote.js";
import { QuoteError } from "../src/quote.js";
import type { StoreData } from "../src/store.js";
import { emptyStore } from "../src/store.js";

function withQuote(d: StoreData, id: string, owed: bigint, expiry: number): void {
  d.quotes[id] = { orderId: id, owedOnDefault: owed.toString(), expiry, response: { srcLedgerId: "eip155:31001" } as QuoteResponse };
}

describe("capacity", () => {
  it("counts issued quotes until the order book has them", () => {
    const d = emptyStore();
    withQuote(d, "a", 100n, 1000);
    withQuote(d, "b", 50n, 1000);
    expect(outstandingOwed(d)).toBe(150n);
    expect(available(1000n, d)).toBe(850n);
    d.quotes.a!.openedStatus = 1;
    expect(outstandingOwed(d)).toBe(50n);
    d.quotes.b!.openedStatus = 5; // rejected: nothing reserved, nothing outstanding
    expect(outstandingOwed(d)).toBe(0n);
  });

  it("releases an expired quote only once the source chain was scanned past its expiry", () => {
    const d = emptyStore();
    withQuote(d, "a", 100n, 1000);
    d.cursors["eip155:31001"] = { block: 5, time: 1000 };
    expect(isOutstanding(d, "a")).toBe(true);
    d.cursors["eip155:31001"] = { block: 6, time: 1001 };
    expect(isOutstanding(d, "a")).toBe(false);
  });

  it("keeps a deposited quote outstanding after expiry until it opens", () => {
    const d = emptyStore();
    withQuote(d, "a", 100n, 1000);
    d.deposits.a = { orderId: "a" } as StoreData["deposits"][string];
    d.cursors["eip155:31001"] = { block: 9, time: 5000 };
    expect(isOutstanding(d, "a")).toBe(true);
    d.quotes.a!.openedStatus = 1;
    expect(isOutstanding(d, "a")).toBe(false);
  });

  it("refuses quotes beyond capacity with no-capacity (503)", () => {
    const d = emptyStore();
    withQuote(d, "a", 600n, 1000);
    expect(() => requireCapacity(1000n, d, 400n)).not.toThrow();
    try {
      requireCapacity(1000n, d, 401n);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteError);
      expect((e as QuoteError).code).toBe("no-capacity");
      expect((e as QuoteError).status).toBe(503);
    }
    expect(available(500n, d)).toBe(0n);
  });
});
