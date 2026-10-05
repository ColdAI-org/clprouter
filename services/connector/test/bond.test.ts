// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { postBond, WEIBARS_PER_TINYBAR } from "../src/bond.js";
import type { Ledger } from "../src/clients.js";
import { connectorAccount, ORDER_BOOK, ZERO } from "./fixtures.js";

/** A ledger that records the value of each simulated call and succeeds. */
function recordingLedger(chainId: number) {
  const calls: { functionName: string; args: readonly unknown[]; value?: bigint }[] = [];
  const l = {
    ledgerId: `eip155:${chainId}`,
    chainId,
    rpcUrl: "http://127.0.0.1:1",
    public: {
      simulateContract: async (c: { functionName: string; args: readonly unknown[]; value?: bigint }) => {
        calls.push({ functionName: c.functionName, args: c.args, value: c.value });
        return { request: c };
      },
      readContract: async () => 0n,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
    wallet: { account: connectorAccount, writeContract: async () => `0x${"ab".repeat(32)}` },
  } as unknown as Ledger;
  return { l, calls };
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

describe("postBond value", () => {
  it("scales a native HBAR bond to weibars on Hedera's relay; the amount stays in tinybars", async () => {
    for (const id of [295, 296, 297]) {
      const { l, calls } = recordingLedger(id);
      await postBond(l, ORDER_BOOK, ZERO as Address, 500_000_000n, log);
      expect(calls).toEqual([{ functionName: "postBond", args: [ZERO, 500_000_000n], value: 500_000_000n * WEIBARS_PER_TINYBAR }]);
    }
  });

  it("sends the amount as is on other EVM networks", async () => {
    const { l, calls } = recordingLedger(31003);
    await postBond(l, ORDER_BOOK, ZERO as Address, 7n, log);
    expect(calls[0]!.value).toBe(7n);
  });
});
