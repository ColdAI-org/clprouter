// SPDX-License-Identifier: MIT
import type { Abi, Account, Address, Chain, Hex, LocalAccount, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";
import { createPublicClient, createWalletClient, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ResilientRpc } from "../../src/rpc.js";
import { web3SignerAccount } from "../../src/signer.js";
import type { Logger } from "../../src/log.js";
import type { KeyConfig } from "./config.js";

/** One ledger the Connector reads and sends transactions on. */
export interface Ledger {
  ledgerId: string;
  chainId: number;
  rpcUrl: string;
  public: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
}

export function makeLedger(o: { ledgerId: string; chainId: number; rpcUrl: string; account: Account; transport?: Transport; log?: Logger }): Ledger {
  const chain = defineChain({
    id: o.chainId,
    name: o.ledgerId,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [o.rpcUrl] } },
  });
  const transport = o.transport ?? new ResilientRpc({ ledger: o.ledgerId, urls: [o.rpcUrl], chainId: o.chainId, log: o.log }).transport();
  return {
    ledgerId: o.ledgerId,
    chainId: o.chainId,
    rpcUrl: o.rpcUrl,
    public: createPublicClient({ chain, transport, pollingInterval: 250 }) as PublicClient,
    wallet: createWalletClient({ chain, transport, account: o.account }),
  };
}

/** Build an account from a key config. The policy (local keys on local RPCs only) is enforced by the config. */
export function accountFromKey(k: KeyConfig, env: NodeJS.ProcessEnv = process.env): LocalAccount {
  if (k.kind === "local-test-key") return privateKeyToAccount(k.privateKey as Hex);
  const token = k.authTokenEnv ? env[k.authTokenEnv] : undefined;
  if (k.authTokenEnv && !token) throw new Error(`signer auth token env var ${k.authTokenEnv} is not set`);
  return web3SignerAccount({ url: k.url, address: k.address as Address, authToken: token, timeoutMs: k.timeoutMs });
}

export class TxError extends Error {
  override name = "TxError";
}

/**
 * Simulate (so a revert names its error), send, and wait for a successful receipt.
 */
export async function sendTx(
  l: Ledger,
  c: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint },
): Promise<TransactionReceipt> {
  const { request } = await l.public.simulateContract({ ...(c as object), account: l.wallet.account } as never);
  const hash = await l.wallet.writeContract(request as never);
  return waitOk(l, hash, String(c.functionName));
}

export async function waitOk(l: Ledger, hash: Hex, what: string): Promise<TransactionReceipt> {
  const r = await l.public.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new TxError(`${what} on ${l.ledgerId} reverted (${hash})`);
  return r;
}

/** Latest block timestamp, unix seconds (the ledger's clock, which may differ from wall time on test networks). */
export async function chainNow(l: Ledger): Promise<bigint> {
  return (await l.public.getBlock({ blockTag: "latest" })).timestamp;
}
