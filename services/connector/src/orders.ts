// SPDX-License-Identifier: MIT
import type { Address, Hex } from "viem";
import type { Logger } from "../../src/log.js";
import { ORDER_BOOK_ABI } from "./abi.js";
import type { Ledger } from "./clients.js";
import { sendTx } from "./clients.js";
import { ledgerHash } from "./config.js";
import { deliveryHash, deliveryStruct } from "./deliver.js";
import type { Store } from "./store.js";

/** `SettleOrderBook.Status`. */
export const Status = { NONE: 0, OPEN: 1, DELIVERED: 2, DEFAULTED: 3, CANCELLED: 4, REJECTED: 5 } as const;
export const STATUS_NAMES = ["NONE", "OPEN", "DELIVERED", "DEFAULTED", "CANCELLED", "REJECTED"] as const;

export interface OnchainOrder {
  connector: Address;
  status: number;
  deadline: bigint;
  coverAsset: Address;
  openedAt: bigint;
  refundTo: Address;
  dstLedger: Hex;
  assetOut: Hex;
  recipient: Hex;
  amountOut: bigint;
  owedOnDefault: bigint;
  reserved: bigint;
}

export async function readOrder(h: Ledger, orderBook: Address, orderId: Hex): Promise<OnchainOrder> {
  const r = await h.public.readContract({ address: orderBook, abi: ORDER_BOOK_ABI, functionName: "orders", args: [orderId] });
  const [connector, status, deadline, coverAsset, openedAt, refundTo, dstLedger, assetOut, recipient, amountOut, owedOnDefault, reserved] = r;
  return { connector, status, deadline, coverAsset, openedAt, refundTo, dstLedger, assetOut, recipient, amountOut, owedOnDefault, reserved };
}

export interface ReconcileResult {
  /** Closed by this run with `closeWithRecordedDelivery`. */
  closed: string[];
  /** Cancelled by this run (orders this Connector chose not to deliver). */
  cancelled: string[];
  /** Seen settled by the delivery message itself. */
  settled: string[];
}

/**
 * Bring the store in line with the order book for every order with a seen deposit or a delivery: mark opened
 * orders (their bond is then reserved on-chain), close an open order whose delivery the order book recorded before
 * the deposit arrived, optionally cancel an open order this Connector decided not to deliver, and record final
 * states.
 */
export async function reconcile(h: Ledger, orderBook: Address, store: Store, o: { cancelUndeliverable: boolean; log: Logger }): Promise<ReconcileResult> {
  const out: ReconcileResult = { closed: [], cancelled: [], settled: [] };
  const ids = new Set([...Object.keys(store.data.deposits), ...Object.keys(store.data.deliveries)]);
  for (const id of ids) {
    if (store.data.closed[id] || !store.data.quotes[id]) continue;
    const ord = await readOrder(h, orderBook, id as Hex);
    if (ord.status === Status.NONE) continue;
    store.update((d) => {
      d.quotes[id]!.openedStatus = ord.status;
    });
    if (ord.status === Status.OPEN) {
      const rec = store.data.deliveries[id];
      if (rec?.delivery) {
        const ledger = ledgerHash(rec.ledgerId);
        const seen = await h.public.readContract({ address: orderBook, abi: ORDER_BOOK_ABI, functionName: "deliverySeen", args: [id as Hex, deliveryHash(ledger, rec.delivery)] });
        if (seen) {
          const r = await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "closeWithRecordedDelivery", args: [ledger, deliveryStruct(rec.delivery)] });
          store.update((d) => {
            d.closed[id] = { how: "recorded", status: Status.DELIVERED, txHash: r.transactionHash };
            d.quotes[id]!.openedStatus = Status.DELIVERED;
          });
          out.closed.push(id);
          o.log.info("order closed with its recorded delivery", { orderId: id, tx: r.transactionHash });
        }
        continue;
      }
      const skip = store.data.skipped[id];
      if (skip && skip.reason === "too-late" && o.cancelUndeliverable) {
        const r = await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "cancelOrder", args: [id as Hex] });
        store.update((d) => {
          d.closed[id] = { how: "cancelled", status: Status.CANCELLED, txHash: r.transactionHash };
          d.quotes[id]!.openedStatus = Status.CANCELLED;
        });
        out.cancelled.push(id);
        o.log.info("order cancelled; the user is paid from the bond", { orderId: id, tx: r.transactionHash });
      }
      continue;
    }
    const how = ord.status === Status.DELIVERED ? "delivered" : (STATUS_NAMES[ord.status] ?? "unknown").toLowerCase();
    store.update((d) => {
      d.closed[id] = { how, status: ord.status };
    });
    if (ord.status === Status.DELIVERED) out.settled.push(id);
  }
  return out;
}
