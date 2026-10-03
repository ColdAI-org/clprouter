// SPDX-License-Identifier: MIT
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { QuoteResponse } from "./quote.js";

/**
 * The Connector's state as one JSON file: quotes it issued, deposits it saw, deliveries it made, orders it skipped
 * or closed, and a scan cursor per chain. Every save writes a temp file in the same directory, syncs it and renames
 * it over the old file, so a crash leaves either the old or the new state, never a torn file.
 *
 * One process per store file: two processes writing the same file would lose each other's updates.
 */

export const STORE_VERSION = 1;

export interface IssuedQuote {
  orderId: string;
  response: QuoteResponse;
  /** Bond the order book reserves when the order opens (cover + penalty), decimal. */
  owedOnDefault: string;
  expiry: number;
  /** Set once the order book has the order (any status but NONE): its bond is then counted on-chain. */
  openedStatus?: number;
}

export interface DepositSeen {
  orderId: string;
  ledgerId: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  connector: string;
  user: string;
  signer: string;
  assetIn: string;
  amountIn: string;
  payTo: string;
  messageId: string;
}

/** `SettleTypes.Delivery` as JSON. */
export interface DeliveryJson {
  orderId: string;
  asset: string;
  recipient: string;
  amount: string;
  deliveredAt: number;
  deliverer: string;
}

export interface DeliveryRecord {
  orderId: string;
  ledgerId: string;
  /** Set when the transaction was sent; `delivery` is set once its receipt is read. */
  txHash?: string;
  /** First block to search for the `Delivered` event when resuming an unfinished delivery. */
  fromBlock: number;
  delivery?: DeliveryJson;
  blockNumber?: number;
}

export interface SkipRecord {
  reason: string;
  at: number;
}

export interface CloseRecord {
  /** How the order ended: `delivered` (delivery message), `recorded` (closeWithRecordedDelivery), `cancelled`, `defaulted`, `rejected`. */
  how: string;
  status: number;
  txHash?: string;
}

export interface Cursor {
  /** Last block scanned (inclusive). */
  block: number;
  /** Timestamp of that block. */
  time: number;
}

export interface StoreData {
  version: number;
  quotes: Record<string, IssuedQuote>;
  deposits: Record<string, DepositSeen>;
  deliveries: Record<string, DeliveryRecord>;
  skipped: Record<string, SkipRecord>;
  closed: Record<string, CloseRecord>;
  cursors: Record<string, Cursor>;
}

export const emptyStore = (): StoreData => ({ version: STORE_VERSION, quotes: {}, deposits: {}, deliveries: {}, skipped: {}, closed: {}, cursors: {} });

export class StoreError extends Error {
  override name = "StoreError";
}

export class Store {
  private constructor(
    readonly path: string,
    public data: StoreData,
  ) {}

  /** Open a store file; a missing file is an empty store. */
  static open(path: string): Store {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Store(path, emptyStore());
      throw e;
    }
    let data: StoreData;
    try {
      data = JSON.parse(text) as StoreData;
    } catch (e) {
      throw new StoreError(`store ${path} is not valid JSON: ${(e as Error).message}`);
    }
    if (data.version !== STORE_VERSION) throw new StoreError(`store ${path} has version ${String(data.version)}, expected ${STORE_VERSION}`);
    return new Store(path, { ...emptyStore(), ...data });
  }

  /** Write the whole state atomically (temp file, fsync, rename). */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(this.data, null, 2)}\n`);
      fsyncSync(fd);
    } catch (e) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
  }

  /** Apply `fn` and save. */
  update<T>(fn: (d: StoreData) => T): T {
    const r = fn(this.data);
    this.save();
    return r;
  }

  quote(orderId: string): IssuedQuote | undefined {
    return this.data.quotes[orderId.toLowerCase()];
  }
}

export const key = (orderId: string): string => orderId.toLowerCase();
