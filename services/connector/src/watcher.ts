// SPDX-License-Identifier: MIT
import type { Log } from "viem";
import { getAddress, parseEventLogs } from "viem";
import type { Logger } from "../../src/log.js";
import { DEPOSIT_ABI } from "./abi.js";
import type { Ledger } from "./clients.js";
import type { ChainConfig } from "./config.js";
import type { DepositSeen, Store } from "./store.js";
import { key } from "./store.js";

/** A `Deposited` log as a store record. Returns undefined for any other log. */
export function depositFromLog(log: Log, ledgerId: string): DepositSeen | undefined {
  const [ev] = parseEventLogs({ abi: DEPOSIT_ABI, eventName: "Deposited", logs: [log], strict: true });
  if (!ev) return undefined;
  const a = ev.args;
  return {
    orderId: key(a.orderId),
    ledgerId,
    txHash: ev.transactionHash ?? "",
    blockNumber: Number(ev.blockNumber ?? 0n),
    logIndex: ev.logIndex ?? 0,
    connector: getAddress(a.connector),
    user: getAddress(a.user),
    signer: getAddress(a.signer),
    assetIn: a.assetIn.toLowerCase(),
    amountIn: a.amountIn.toString(),
    payTo: a.payTo.toLowerCase(),
    messageId: a.messageId.toString(),
  };
}

export interface ScanResult {
  /** Deposits for quotes this Connector issued, newly recorded. */
  found: DepositSeen[];
  /** Deposited events for orders this Connector does not know (ignored). */
  ignored: number;
  fromBlock: number;
  toBlock: number;
}

/**
 * Scan the chain's SettleDeposit for `Deposited` events from the stored cursor up to `head - confirmations`, in
 * batches. Deposits for quotes in the store are recorded; others are ignored. The cursor (block and its timestamp)
 * is saved after each batch, so a restart resumes where the last batch ended.
 */
export async function scanDeposits(l: Ledger, chain: ChainConfig, store: Store, log: Logger): Promise<ScanResult> {
  const latest = Number(await l.public.getBlockNumber());
  const head = latest - chain.confirmations;
  const cur = store.data.cursors[chain.ledgerId];
  let from = cur ? cur.block + 1 : chain.startBlock;
  const out: ScanResult = { found: [], ignored: 0, fromBlock: from, toBlock: head };
  while (from <= head) {
    const to = Math.min(head, from + chain.logBatch - 1);
    const logs = await l.public.getLogs({
      address: chain.deposit,
      event: DEPOSIT_ABI.find((x) => x.type === "event" && x.name === "Deposited") as Extract<(typeof DEPOSIT_ABI)[number], { type: "event"; name: "Deposited" }>,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    const block = await l.public.getBlock({ blockNumber: BigInt(to) });
    store.update((d) => {
      for (const lg of logs) {
        const dep = depositFromLog(lg as Log, chain.ledgerId);
        if (!dep) continue;
        if (!d.quotes[dep.orderId]) {
          out.ignored++;
          log.debug("deposit for an unknown order ignored", { orderId: dep.orderId, ledger: chain.ledgerId });
          continue;
        }
        if (d.deposits[dep.orderId]) continue;
        d.deposits[dep.orderId] = dep;
        out.found.push(dep);
        log.info("deposit seen", { orderId: dep.orderId, ledger: chain.ledgerId, tx: dep.txHash });
      }
      d.cursors[chain.ledgerId] = { block: to, time: Number(block.timestamp) };
    });
    from = to + 1;
  }
  return out;
}
