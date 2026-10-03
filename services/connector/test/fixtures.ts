// SPDX-License-Identifier: MIT
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex, Log } from "viem";
import { encodeAbiParameters, encodeEventTopics, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DELIVERY_ABI, DEPOSIT_ABI } from "../src/abi.js";
import type { Ledger } from "../src/clients.js";
import type { ConnectorConfig } from "../src/config.js";
import { resolveConnectorConfig } from "../src/config.js";

/** anvil's published dev keys (accounts 0 and 1). Test code only. */
export const ANVIL_KEY_0: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ANVIL_KEY_1: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const connectorAccount = privateKeyToAccount(ANVIL_KEY_0);
export const signerAccount = privateKeyToAccount(ANVIL_KEY_1);

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const ORDER_BOOK: Address = "0x00000000000000000000000000000000000000b0";
export const DEPOSIT_Y: Address = "0x00000000000000000000000000000000000000d1";
export const DELIVERY_X: Address = "0x00000000000000000000000000000000000000e2";

export const tmpStorePath = (): string => join(mkdtempSync(join(tmpdir(), "connector-test-")), "store.json");

/** A config like the e2e one: chains Y (31001) and X (31002), Hedera 31003, native-to-native route. */
export function rawConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-connector",
    hedera: { ledgerId: "eip155:31003", rpcUrl: "http://127.0.0.1:18557", chainId: 31003, orderBook: ORDER_BOOK, clprService: "0x00000000000000000000000000000000000000c3" },
    chains: [
      { ledgerId: "eip155:31001", rpcUrl: "http://127.0.0.1:18555", chainId: 31001, clprService: "0x00000000000000000000000000000000000000c1", deposit: DEPOSIT_Y, delivery: "0x00000000000000000000000000000000000000e1", channelId: `0x${"11".repeat(32)}`, confirmations: 0, startBlock: 0 },
      { ledgerId: "eip155:31002", rpcUrl: "http://127.0.0.1:18556", chainId: 31002, clprService: "0x00000000000000000000000000000000000000c2", deposit: "0x00000000000000000000000000000000000000d2", delivery: DELIVERY_X, channelId: `0x${"22".repeat(32)}`, confirmations: 0, startBlock: 0 },
    ],
    routes: [{ srcLedger: "eip155:31001", assetIn: ZERO, dstLedger: "eip155:31002", assetOut: ZERO, rateNum: "1", rateDen: "1", feeBps: 100, coverNum: "1", coverDen: "1", deliveryP90S: 60 }],
    bond: { asset: ZERO, target: "50000000000000000000" },
    quote: { ttlS: 300, defaultDeadlineS: 3600, minDeliveryMarginS: 30 },
    keys: { connector: { kind: "local-test-key", privateKey: ANVIL_KEY_0 }, signer: { kind: "local-test-key", privateKey: ANVIL_KEY_1 } },
    relay: { kind: "e2e-test-only", bundleEncoder: "0x00000000000000000000000000000000000000ee", bundleEncoderLedger: "eip155:31003" },
    store: "e2e-out/settle/connector-store.json",
    http: { host: "127.0.0.1", port: 8787 },
    ...over,
  };
}

export const testConfig = (over: Record<string, unknown> = {}): ConnectorConfig => resolveConnectorConfig(rawConfig(over));

export const quoteRequest = (over: Record<string, unknown> = {}) => ({
  srcLedger: "eip155:31001",
  assetIn: ZERO,
  dstLedger: "eip155:31002",
  assetOut: ZERO,
  amountOut: "1000000000000000000",
  recipient: "0x0000000000000000000000000000000000001234",
  user: "0x0000000000000000000000000000000000005678",
  refundTo: "0x0000000000000000000000000000000000009abc",
  ...over,
});

let logIndex = 0;

export function depositedLog(o: { orderId: Hex; connector: Address; user: Address; signer: Address; assetIn: Hex; amountIn: bigint; payTo: Hex; messageId?: bigint; block?: bigint; address?: Address }): Log {
  const topics = encodeEventTopics({ abi: DEPOSIT_ABI, eventName: "Deposited", args: { orderId: o.orderId, connector: o.connector, user: o.user } });
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }],
    [o.signer, o.assetIn, o.amountIn, o.payTo, o.messageId ?? 1n],
  );
  return fakeLog(o.address ?? DEPOSIT_Y, topics as Hex[], data, o.block ?? 1n);
}

export function deliveredLog(o: { orderId: Hex; deliverer: Address; recipient: Address; asset: Address; amount: bigint; messageId?: bigint; block?: bigint }): Log {
  const topics = encodeEventTopics({ abi: DELIVERY_ABI, eventName: "Delivered", args: { orderId: o.orderId, deliverer: o.deliverer, recipient: o.recipient } });
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [o.asset, o.amount, o.messageId ?? 1n]);
  return fakeLog(DELIVERY_X, topics as Hex[], data, o.block ?? 1n);
}

function fakeLog(address: Address, topics: Hex[], data: Hex, block: bigint): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: pad("0x01", { size: 32 }),
    transactionHash: pad(`0x${(++logIndex).toString(16)}`, { size: 32 }),
    transactionIndex: 0,
    logIndex: logIndex,
    removed: false,
  };
}

/**
 * A fake ledger: `reads` answers readContract by function name, `blocks` gives block timestamps, `logs` is what
 * getLogs returns (filtered by block range). Only what the code under test calls is implemented.
 */
export function fakeLedger(o: {
  ledgerId: string;
  head?: bigint;
  time?: bigint;
  reads?: Record<string, (args: readonly unknown[]) => unknown>;
  balance?: bigint;
  logs?: Log[];
  rpcUrl?: string;
}): Ledger & { calls: string[]; sent: { functionName: string; args: readonly unknown[] }[] } {
  const calls: string[] = [];
  const sent: { functionName: string; args: readonly unknown[] }[] = [];
  const pub = {
    getBlockNumber: async () => o.head ?? 10n,
    getBlock: async (a: { blockNumber?: bigint; blockTag?: string }) => ({ number: a.blockNumber ?? o.head ?? 10n, timestamp: (o.time ?? 1_800_000_000n) + (a.blockNumber ?? 0n) }),
    getBalance: async () => o.balance ?? 10n ** 30n,
    readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
      calls.push(`read:${a.functionName}`);
      const f = o.reads?.[a.functionName];
      if (!f) throw new Error(`fake ledger: no read ${a.functionName}`);
      return f(a.args ?? []);
    },
    getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push(`getLogs:${a.fromBlock}-${a.toBlock}`);
      return (o.logs ?? []).filter((l) => l.blockNumber! >= a.fromBlock && l.blockNumber! <= a.toBlock);
    },
    simulateContract: async (a: { functionName: string; args: readonly unknown[] }) => ({ request: a }),
    waitForTransactionReceipt: async (a: { hash: Hex }) => ({ status: "success", transactionHash: a.hash, blockNumber: 1n, logs: [] }),
  };
  const wallet = {
    account: connectorAccount,
    writeContract: async (a: { functionName: string; args: readonly unknown[] }) => {
      sent.push({ functionName: a.functionName, args: a.args });
      return pad(`0x${sent.length.toString(16)}`, { size: 32 });
    },
  };
  return {
    ledgerId: o.ledgerId,
    chainId: 1,
    rpcUrl: o.rpcUrl ?? "http://127.0.0.1:1",
    public: pub as never,
    wallet: wallet as never,
    calls,
    sent,
  };
}
