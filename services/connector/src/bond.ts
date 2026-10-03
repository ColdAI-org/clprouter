// SPDX-License-Identifier: MIT
import type { Address } from "viem";
import { isAddressEqual, zeroAddress } from "viem";
import type { Logger } from "../../src/log.js";
import { ERC20_ABI, ORDER_BOOK_ABI } from "./abi.js";
import type { Ledger } from "./clients.js";
import { sendTx } from "./clients.js";

/**
 * The Connector's registration and bond on the Hedera order book. Amounts are in the bond asset's base units as
 * the order book contract sees them.
 */

export interface BondState {
  total: bigint;
  reserved: bigint;
  pendingWithdraw: bigint;
  withdrawReadyAt: bigint;
  free: bigint;
}

export async function readBond(h: Ledger, orderBook: Address, connector: Address, asset: Address): Promise<BondState> {
  const [total, reserved, pendingWithdraw, withdrawReadyAt] = await h.public.readContract({ address: orderBook, abi: ORDER_BOOK_ABI, functionName: "bonds", args: [connector, asset] });
  const free = await h.public.readContract({ address: orderBook, abi: ORDER_BOOK_ABI, functionName: "freeCapacity", args: [connector, asset] });
  return { total, reserved, pendingWithdraw, withdrawReadyAt, free };
}

export class RegistrationError extends Error {
  override name = "RegistrationError";
}

/** Register the Connector with its quote signer if it is not registered. Returns true if it registered now. */
export async function ensureRegistered(h: Ledger, orderBook: Address, signer: Address, log: Logger): Promise<boolean> {
  const me = h.wallet.account.address;
  const [current, , , registeredAt] = await h.public.readContract({ address: orderBook, abi: ORDER_BOOK_ABI, functionName: "connectors", args: [me] });
  if (registeredAt !== 0n) {
    if (!isAddressEqual(current, signer)) {
      throw new RegistrationError(`connector ${me} is registered with signer ${current}, but the configured signer is ${signer}; rotate the signer on the order book first`);
    }
    return false;
  }
  await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "register", args: [signer] });
  log.info("connector registered", { connector: me, signer });
  return true;
}

/** Post `amount` of `asset` as bond (approving the order book first for an ERC-20). */
export async function postBond(h: Ledger, orderBook: Address, asset: Address, amount: bigint, log: Logger): Promise<void> {
  if (amount <= 0n) throw new Error("bond amount must be greater than zero");
  const native = isAddressEqual(asset, zeroAddress);
  if (!native) {
    const me = h.wallet.account.address;
    const allowance = await h.public.readContract({ address: asset, abi: ERC20_ABI, functionName: "allowance", args: [me, orderBook] });
    if (allowance < amount) await sendTx(h, { address: asset, abi: ERC20_ABI, functionName: "approve", args: [orderBook, amount] });
  }
  await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "postBond", args: [asset, amount], value: native ? amount : 0n });
  log.info("bond posted", { asset, amount: amount.toString() });
}

/** Top the bond up to `target` (total, as the order book counts it). Returns the amount posted. */
export async function ensureBond(h: Ledger, orderBook: Address, asset: Address, target: bigint, log: Logger): Promise<bigint> {
  const b = await readBond(h, orderBook, h.wallet.account.address, asset);
  if (b.total >= target) return 0n;
  const need = target - b.total;
  await postBond(h, orderBook, asset, need, log);
  return need;
}

export async function requestWithdraw(h: Ledger, orderBook: Address, asset: Address, amount: bigint): Promise<void> {
  await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "requestWithdraw", args: [asset, amount] });
}

export async function executeWithdraw(h: Ledger, orderBook: Address, asset: Address): Promise<void> {
  await sendTx(h, { address: orderBook, abi: ORDER_BOOK_ABI, functionName: "executeWithdraw", args: [asset] });
}
