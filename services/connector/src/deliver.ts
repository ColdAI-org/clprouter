// SPDX-License-Identifier: MIT
import type { Address, Hex, Log, TransactionReceipt } from "viem";
import { encodeAbiParameters, isAddressEqual, keccak256, parseEventLogs, zeroAddress } from "viem";
import type { Logger } from "../../src/log.js";
import { DELIVERY_ABI, ERC20_ABI } from "./abi.js";
import type { Ledger } from "./clients.js";
import { sendTx, waitOk } from "./clients.js";
import type { ChainConfig } from "./config.js";
import { fromBytes32, toBytes32 } from "./quote.js";
import type { DeliveryJson, DepositSeen, StoreData, Store } from "./store.js";
import { key } from "./store.js";

// ── Decision ──────────────────────────────────────────────────────────────

export type Decision =
  | { kind: "deliver" }
  /** Recorded: this Connector will not deliver the order. */
  | { kind: "skip"; reason: string }
  /** Not ours, or nothing left to do. */
  | { kind: "ignore"; reason: string };

export interface DecideContext {
  connector: Address;
  signer: Address;
  /** Destination chain time, unix seconds. */
  dstNow: bigint;
  minDeliveryMarginS: number;
  /** `--skip-delivery`: "all" or one order id. */
  skip?: string;
}

/** Whether to deliver an order for a seen deposit. Pure. */
export function decide(d: StoreData, dep: DepositSeen, ctx: DecideContext): Decision {
  const id = key(dep.orderId);
  const q = d.quotes[id];
  if (!q) return { kind: "ignore", reason: "unknown-order" };
  if (d.deliveries[id]?.delivery) return { kind: "ignore", reason: "already-delivered" };
  if (d.skipped[id]) return { kind: "ignore", reason: "already-skipped" };
  if (d.closed[id]) return { kind: "ignore", reason: "closed" };
  const quote = q.response.quote;
  if (dep.ledgerId !== q.response.srcLedgerId) return { kind: "skip", reason: "wrong-source-chain" };
  if (!isAddressEqual(dep.connector as Address, ctx.connector)) return { kind: "skip", reason: "wrong-connector" };
  if (!isAddressEqual(dep.signer as Address, ctx.signer)) return { kind: "skip", reason: "wrong-signer" };
  if (BigInt(dep.amountIn) !== BigInt(quote.amountIn)) return { kind: "skip", reason: "amount-mismatch" };
  if (dep.payTo.toLowerCase() !== quote.payTo.toLowerCase()) return { kind: "skip", reason: "payee-mismatch" };
  if (dep.assetIn.toLowerCase() !== quote.assetIn.toLowerCase()) return { kind: "skip", reason: "asset-mismatch" };
  if (ctx.skip !== undefined && (ctx.skip === "all" || key(ctx.skip) === id)) return { kind: "skip", reason: "skip-delivery" };
  if (BigInt(quote.deadline) - ctx.dstNow < BigInt(ctx.minDeliveryMarginS)) return { kind: "skip", reason: "too-late" };
  return { kind: "deliver" };
}

// ── Delivery struct ───────────────────────────────────────────────────────

/** `SettleTypes.Delivery` from a `Delivered` log and its block's timestamp, as the delivery message carries it. */
export function deliveryFromLog(log: Log, blockTimestamp: bigint): DeliveryJson | undefined {
  const [ev] = parseEventLogs({ abi: DELIVERY_ABI, eventName: "Delivered", logs: [log], strict: true });
  if (!ev) return undefined;
  return {
    orderId: key(ev.args.orderId),
    asset: toBytes32(ev.args.asset),
    recipient: toBytes32(ev.args.recipient),
    amount: ev.args.amount.toString(),
    deliveredAt: Number(blockTimestamp),
    deliverer: toBytes32(ev.args.deliverer),
  };
}

export const DELIVERY_COMPONENTS = [
  { name: "orderId", type: "bytes32" },
  { name: "asset", type: "bytes32" },
  { name: "recipient", type: "bytes32" },
  { name: "amount", type: "uint256" },
  { name: "deliveredAt", type: "uint64" },
  { name: "deliverer", type: "bytes32" },
] as const;

export interface DeliveryStruct {
  orderId: Hex;
  asset: Hex;
  recipient: Hex;
  amount: bigint;
  deliveredAt: bigint;
  deliverer: Hex;
}

export function deliveryStruct(d: DeliveryJson): DeliveryStruct {
  return {
    orderId: d.orderId as Hex,
    asset: d.asset as Hex,
    recipient: d.recipient as Hex,
    amount: BigInt(d.amount),
    deliveredAt: BigInt(d.deliveredAt),
    deliverer: d.deliverer as Hex,
  };
}

/** The order book's `deliveryHash(ledger, d)`: keccak256(abi.encode(ledger, d)). */
export function deliveryHash(ledger: Hex, d: DeliveryJson): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "tuple", components: DELIVERY_COMPONENTS }], [ledger, deliveryStruct(d)]));
}

/** The CLPR message SettleDelivery sends: abi.encode(VERSION, MSG_DELIVERY, d). */
export function encodeDeliveryMessage(d: DeliveryJson): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "tuple", components: DELIVERY_COMPONENTS }], [1, 2, deliveryStruct(d)]);
}

// ── Execution ─────────────────────────────────────────────────────────────

async function fromReceipt(l: Ledger, chain: ChainConfig, r: TransactionReceipt, orderId: string): Promise<DeliveryJson | undefined> {
  const block = await l.public.getBlock({ blockNumber: r.blockNumber });
  for (const lg of r.logs) {
    if (!isAddressEqual(lg.address, chain.delivery)) continue;
    const d = deliveryFromLog(lg as Log, block.timestamp);
    if (d && d.orderId === key(orderId)) return d;
  }
  return undefined;
}

/** Look for our own `Delivered` event for `orderId` since `fromBlock` (resume after a crash). */
async function findDelivered(l: Ledger, chain: ChainConfig, orderId: string, fromBlock: number, deliverer: Address): Promise<{ d: DeliveryJson; block: number; tx: string } | undefined> {
  const logs = await l.public.getLogs({
    address: chain.delivery,
    event: DELIVERY_ABI.find((x) => x.type === "event" && x.name === "Delivered") as Extract<(typeof DELIVERY_ABI)[number], { type: "event"; name: "Delivered" }>,
    args: { orderId: orderId as Hex, deliverer },
    fromBlock: BigInt(fromBlock),
    toBlock: "latest",
  });
  const lg = logs[0];
  if (!lg || lg.blockNumber === null) return undefined;
  const block = await l.public.getBlock({ blockNumber: lg.blockNumber });
  const d = deliveryFromLog(lg as Log, block.timestamp);
  return d ? { d, block: Number(lg.blockNumber), tx: lg.transactionHash ?? "" } : undefined;
}

/**
 * Deliver an order on its destination chain through SettleDelivery and record the delivery struct. The intent is
 * saved before the transaction is sent and the tx hash right after, so a restart finds a delivery that landed
 * instead of paying twice.
 */
export async function deliver(l: Ledger, chain: ChainConfig, store: Store, orderId: string, log: Logger): Promise<DeliveryJson> {
  const id = key(orderId);
  const q = store.data.quotes[id];
  if (!q) throw new Error(`deliver: unknown order ${id}`);
  const me = l.wallet.account.address;
  const prev = store.data.deliveries[id];
  if (prev?.delivery) return prev.delivery;
  if (prev) {
    if (prev.txHash) {
      const r = await l.public.getTransactionReceipt({ hash: prev.txHash as Hex }).catch(() => undefined);
      if (r && r.status === "success") {
        const d = await fromReceipt(l, chain, r, id);
        if (d) return record(store, id, d, Number(r.blockNumber));
      }
    }
    const found = await findDelivered(l, chain, id, prev.fromBlock, me);
    if (found) return record(store, id, found.d, found.block, found.tx);
    log.warn("unfinished delivery not found on-chain; sending again", { orderId: id });
  }

  const quote = q.response.quote;
  const asset = fromBytes32(quote.assetOut as Hex);
  const recipient = fromBytes32(quote.recipient as Hex);
  if (!asset || !recipient) throw new Error(`deliver: order ${id} has a non-EVM asset or recipient`);
  const amount = BigInt(quote.amountOut);
  const fromBlock = Number(await l.public.getBlockNumber());
  store.update((d) => {
    d.deliveries[id] = { orderId: id, ledgerId: chain.ledgerId, fromBlock };
  });

  if (!isAddressEqual(asset, zeroAddress)) {
    const allowance = await l.public.readContract({ address: asset, abi: ERC20_ABI, functionName: "allowance", args: [me, chain.delivery] });
    if (allowance < amount) await sendTx(l, { address: asset, abi: ERC20_ABI, functionName: "approve", args: [chain.delivery, amount] });
  }
  const { request } = await l.public.simulateContract({
    address: chain.delivery,
    abi: DELIVERY_ABI,
    functionName: "deliver",
    args: [id as Hex, asset, recipient, amount],
    value: isAddressEqual(asset, zeroAddress) ? amount : 0n,
    account: l.wallet.account,
  });
  const hash = await l.wallet.writeContract(request as never);
  store.update((d) => {
    d.deliveries[id] = { orderId: id, ledgerId: chain.ledgerId, fromBlock, txHash: hash };
  });
  const r = await waitOk(l, hash, "deliver");
  const d = await fromReceipt(l, chain, r, id);
  if (!d) throw new Error(`deliver: no Delivered event for ${id} in ${hash}`);
  log.info("delivered", { orderId: id, ledger: chain.ledgerId, tx: hash, amount: d.amount });
  return record(store, id, d, Number(r.blockNumber), hash);
}

function record(store: Store, id: string, d: DeliveryJson, blockNumber: number, tx?: string): DeliveryJson {
  store.update((s) => {
    const prev = s.deliveries[id];
    s.deliveries[id] = { orderId: id, ledgerId: prev?.ledgerId ?? "", fromBlock: prev?.fromBlock ?? blockNumber, txHash: tx ?? prev?.txHash, delivery: d, blockNumber };
  });
  return d;
}
