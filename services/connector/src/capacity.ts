// SPDX-License-Identifier: MIT
import { QuoteError } from "./quote.js";
import type { StoreData } from "./store.js";

/**
 * Bond capacity for new quotes. The order book reserves `owedOnDefault` from the bond only when an order opens on
 * Hedera, so quotes issued but not yet opened are counted here, against the on-chain free capacity:
 *
 *   available = freeCapacity(connector, bondAsset) - sum(owedOnDefault of outstanding quotes)
 *
 * A quote stops being outstanding when the order book has it (any status: an open order is then reserved on-chain,
 * a rejected one reserves nothing), or when it expired unused: the source chain has been scanned through a block
 * later than its expiry and no deposit for it was seen.
 */

/** Sum of owedOnDefault over quotes that may still open an order and are not yet reserved on-chain. */
export function outstandingOwed(d: StoreData): bigint {
  let sum = 0n;
  for (const q of Object.values(d.quotes)) if (isOutstanding(d, q.orderId)) sum += BigInt(q.owedOnDefault);
  return sum;
}

export function isOutstanding(d: StoreData, orderId: string): boolean {
  const q = d.quotes[orderId];
  if (!q) return false;
  if (q.openedStatus !== undefined) return false;
  if (d.deposits[orderId]) return true;
  const cursor = d.cursors[q.response.srcLedgerId];
  return !(cursor && cursor.time > q.expiry);
}

export function available(freeOnChain: bigint, d: StoreData): bigint {
  const left = freeOnChain - outstandingOwed(d);
  return left > 0n ? left : 0n;
}

/** Throw `no-capacity` unless `need` fits. */
export function requireCapacity(freeOnChain: bigint, d: StoreData, need: bigint): void {
  const a = available(freeOnChain, d);
  if (need > a) throw new QuoteError("no-capacity", `the Connector's free bond (${a}) does not cover this order (${need})`);
}
