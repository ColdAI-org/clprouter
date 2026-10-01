import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { encodeFunctionData, keccak256 } from "viem";
import { ROUTER_ABI } from "./abi.js";
import type { IndexedEvent } from "./events.js";
import type { EventBus } from "./indexer.js";
import type { Store, TriggerJob } from "./store.js";

/** `ClprRouter.HopState` values a {forward} call accepts. */
const FORWARD_PENDING = 2;
const NACKED = 4;
const MAX_ATTEMPTS = 3;
/** Upper bound on the gas the trigger sends with (well under common block gas limits). */
const GAS_CAP = 10_000_000n;

/** What the trigger needs from one ledger's Router. Implemented over viem below; mocked in tests. */
export interface RouterChain {
  hopState(routeId: Hex): Promise<number>;
  pendingHash(routeId: Hex): Promise<Hex>;
  outbox(key: Hex): Promise<boolean>;
  /** Simulate, send and wait for {forward}(envelope, []). Returns the tx hash; throws if it reverted. */
  forward(envelope: Hex): Promise<Hex>;
  /** Simulate, send and wait for {flush}. */
  flush(channelId: Hex, connectorId: Hex, target: Hex, data: Hex): Promise<Hex>;
}

export function viemRouterChain(pub: PublicClient, wallet: WalletClient, router: Address): RouterChain {
  const read = (functionName: "hopState" | "pendingHash" | "outbox", args: readonly unknown[]) =>
    pub.readContract({ address: router, abi: ROUTER_ABI, functionName, args } as never) as Promise<unknown>;
  const write = async (functionName: "forward" | "flush", args: readonly unknown[]): Promise<Hex> => {
    const account = wallet.account;
    if (!account) throw new Error("wallet has no account");
    const { request } = await pub.simulateContract({ address: router, abi: ROUTER_ABI, functionName, args, account } as never);
    // The Router wraps `sendMessage` in try/catch, so eth_estimateGas converges on a limit where the inner call
    // runs out of gas and the hop is recorded as failed instead of reverting. Give the inner call real headroom.
    const estimate = await pub.estimateContractGas({ address: router, abi: ROUTER_ABI, functionName, args, account } as never);
    const gas = estimate * 3n + 300_000n < GAS_CAP ? estimate * 3n + 300_000n : GAS_CAP;
    const hash = await wallet.writeContract({ ...(request as object), gas } as never);
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`tx ${hash} reverted`);
    return hash;
  };
  return {
    hopState: async (id) => Number(await read("hopState", [id])),
    pendingHash: async (id) => (await read("pendingHash", [id])) as Hex,
    outbox: async (k) => Boolean(await read("outbox", [k])),
    forward: (envelope) => write("forward", [envelope, []]),
    flush: (c, k, t, d) => write("flush", [c, k, t, d]),
  };
}

/** Calldata anyone can send to complete a job themselves (the trigger is public; the service is a convenience). */
export function jobCalldata(job: Pick<TriggerJob, "kind" | "payload">): Hex {
  const p = job.payload as Record<string, Hex>;
  if (job.kind === "flush") {
    return encodeFunctionData({ abi: ROUTER_ABI, functionName: "flush", args: [p.channelId!, p.connectorId!, p.target!, p.data!] });
  }
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: "forward", args: [p.envelope!, []] });
}

export interface ForwardTriggerOptions {
  store: Store;
  bus: EventBus;
  /** Router per ledger (for the API's calldata). */
  routers: Record<string, Address>;
  /** Chains the service may submit on. Ledgers without one only record jobs for others to complete. */
  chains?: Record<string, RouterChain>;
  /** Also complete `ForwardRejected` hops (FAILED receipt to the origin). Default false: leave them for re-routing. */
  completeRejected?: boolean;
  log?: (msg: string) => void;
}

/**
 * The ADR's fallback: when a Router could not forward inside CLPR delivery (`ForwardPending`) or could not send a
 * receipt (`OutboxQueued`), anyone may complete it with {forward} / {flush}. This records every such hop as a job,
 * exposes the calldata, and — when given a (test) key for a local ledger — submits it. Before sending it re-reads
 * the Router, so a hop someone else already completed is skipped, not retried.
 */
export class ForwardTrigger {
  private unsubscribe: (() => void) | undefined;
  private busy = false;
  private again = false;
  private stopped = false;
  private current: Promise<void> | undefined;

  constructor(private readonly o: ForwardTriggerOptions) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.o.bus.onEvent((e) => {
      if (this.ingest(e)) void this.process();
    });
    // A crash between submit and confirmation leaves jobs "submitted"; the pre-send re-check makes a retry safe.
    for (const j of this.o.store.jobs({ status: ["submitted"] })) {
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "pending" });
    }
    // Jobs from events indexed before a restart.
    for (const name of ["ForwardPending", "OutboxQueued", "ForwardRejected"]) {
      for (const e of this.o.store.eventsByName(name)) this.ingest(e);
    }
    void this.process();
  }

  /** Stop listening and wait for an in-flight pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.current;
  }

  /** Turn one indexed event into a job. Returns true if a new job was added. */
  ingest(e: IndexedEvent): boolean {
    if (e.contract !== "router") return false;
    const a = e.args;
    if (e.name === "ForwardPending") {
      const envelope = a.envelope as Hex;
      return this.o.store.addJob({
        ledger: e.ledger,
        kind: "forward",
        key: keccak256(envelope),
        routeId: e.routeId,
        blockNumber: e.blockNumber,
        payload: { envelope, hopIndex: Number(a.hopIndex) },
      });
    }
    if (e.name === "OutboxQueued") {
      return this.o.store.addJob({
        ledger: e.ledger,
        kind: "flush",
        key: String(a.key),
        blockNumber: e.blockNumber,
        payload: { channelId: a.channelId, connectorId: a.connectorId, target: a.target, data: a.data },
      });
    }
    if (e.name === "ForwardRejected" && this.o.completeRejected) {
      const envelope = a.envelope as Hex;
      if (!envelope || envelope === "0x") return false; // NACK from a CLPR Response: the envelope is not in the event
      return this.o.store.addJob({
        ledger: e.ledger,
        kind: "reject",
        key: keccak256(envelope),
        routeId: e.routeId,
        blockNumber: e.blockNumber,
        payload: { envelope },
      });
    }
    return false;
  }

  /** Jobs with the calldata to complete them. */
  pending(): (TriggerJob & { router: Address | undefined; calldata: Hex })[] {
    return this.o.store
      .jobs({ status: ["pending", "failed", "submitted"] })
      .map((j) => ({ ...j, router: this.o.routers[j.ledger], calldata: jobCalldata(j) }));
  }

  /** Submit every open job on ledgers the service can sign for. */
  async process(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return this.current;
    }
    this.busy = true;
    this.current = (async () => {
      try {
        do {
          this.again = false;
          for (const j of this.o.store.jobs({ status: ["pending", "failed"] })) {
            if (this.stopped) return;
            const chain = this.o.chains?.[j.ledger];
            if (!chain || j.attempts >= MAX_ATTEMPTS) continue;
            await this.run(chain, j);
          }
        } while (this.again && !this.stopped);
      } finally {
        this.busy = false;
      }
    })();
    return this.current;
  }

  private async run(chain: RouterChain, j: TriggerJob): Promise<void> {
    const p = j.payload as Record<string, Hex>;
    try {
      if (j.kind === "flush") {
        if (!(await chain.outbox(j.key as Hex))) {
          this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "skipped", error: "already flushed" });
          return;
        }
      } else {
        const st = await chain.hopState(j.routeId!);
        const ph = await chain.pendingHash(j.routeId!);
        const wanted = j.kind === "forward" ? FORWARD_PENDING : NACKED;
        if (st !== wanted || ph.toLowerCase() !== j.key.toLowerCase()) {
          this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "skipped", error: "already completed" });
          return;
        }
      }
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "submitted", attempt: true });
      const tx =
        j.kind === "flush" ? await chain.flush(p.channelId!, p.connectorId!, p.target!, p.data!) : await chain.forward(p.envelope!);
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "done", txHash: tx });
      this.o.log?.(`trigger: ${j.kind} on ${j.ledger} ${j.routeId ?? j.key} → ${tx}`);
    } catch (err) {
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "failed", error: (err as Error).message.slice(0, 500) });
      this.o.log?.(`trigger: ${j.kind} on ${j.ledger} failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}
