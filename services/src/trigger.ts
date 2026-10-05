import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { decodeEnvelope, inboundKey } from "@clprouter/sdk";
import { encodeFunctionData, keccak256 } from "viem";
import { ROUTER_ABI } from "./abi.js";
import type { IndexedEvent } from "./events.js";
import type { EventBus } from "./indexer.js";
import { scrubMessage } from "./log.js";
import type { Store, TriggerJob } from "./store.js";

/** `ClprRouter.HopState` values a {forward} call accepts. */
const FORWARD_PENDING = 2;
const NACKED = 4;
const MAX_ATTEMPTS = 3;
/** Upper bound on the gas the trigger sends with (well under common block gas limits). */
const GAS_CAP = 10_000_000n;

/** What the trigger needs from one ledger's Router. Implemented over viem below; mocked in tests. */
export interface RouterChain {
  /** By hop-state key: `inboundKey(hops[0].ledger_id, hops[0].router, route_id)` of the envelope. */
  hopState(key: Hex): Promise<number>;
  pendingHash(key: Hex): Promise<Hex>;
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
    // The Router now reverts with InsufficientGas when less than MIN_SEND_GAS is left for `sendMessage`, so an
    // under-funded forward can no longer fail a hop; extra headroom just avoids a wasted reverted transaction.
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

/** Router hop-state key of an envelope (its origin hops[0] and id), as `ClprRouter.hopState` is keyed. */
export function stateKey(envelope: Hex): Hex {
  const env = decodeEnvelope(envelope);
  const h0 = env.hops[0];
  if (!h0) throw new Error("envelope has no hops");
  return inboundKey(h0.ledger_id, h0.router, env.route_id);
}

/** Flush arguments of a receipt message from its data (the encoded receipt envelope, already at its next hop). */
function flushArgs(data: Hex): { channelId: Hex; connectorId: Hex; target: Hex; data: Hex } | undefined {
  try {
    const re = decodeEnvelope(data);
    const from = re.hops[re.hop_index - 1];
    const to = re.hops[re.hop_index];
    if (!from || !to) return undefined;
    return { channelId: from.channel_id, connectorId: from.connector_id, target: to.router, data };
  } catch {
    return undefined;
  }
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
  /** Attempts per job before it is left for someone else. Default 3. */
  maxAttempts?: number;
  /**
   * Other Connectors of a Channel (by lower-case Channel id) to send a queued receipt over when the Connector the
   * route named refuses it. Routers accept a receipt over any Connector of its Channel, so a refusing Connector
   * cannot hold a receipt back while one of these carries it.
   */
  receiptConnectors?: Record<string, Hex[]>;
  /** Called with every job result (metrics). */
  onResult?: (job: TriggerJob, result: "done" | "skipped" | "failed") => void;
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
    // Jobs from events indexed before a restart (RouteForwarded first: it holds envelopes rejections refer to, and
    // receipt data a later ReceiptRequeued refers to).
    for (const name of ["RouteForwarded", "ForwardPending", "OutboxQueued", "ForwardRejected", "ReceiptRequeued"]) {
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

  /** Envelopes seen in `RouteForwarded` / `ForwardPending`, by ledger and keccak256, for later rejections. */
  private readonly envelopes = new Map<string, Hex>();
  /** Receipt messages seen in `OutboxQueued` / `RouteForwarded`, by ledger and outbox key, for later requeues. */
  private readonly receipts = new Map<string, { channelId: Hex; connectorId: Hex; target: Hex; data: Hex }>();

  private receiptFromStore(ledger: string, key: string): { channelId: Hex; connectorId: Hex; target: Hex; data: Hex } | undefined {
    for (const name of ["OutboxQueued", "RouteForwarded"]) {
      for (const x of this.o.store.eventsByName(name)) {
        if (x.ledger !== ledger || String(x.args.key).toLowerCase() !== key) continue;
        if (name === "OutboxQueued") {
          const a = x.args;
          return { channelId: a.channelId as Hex, connectorId: a.connectorId as Hex, target: a.target as Hex, data: a.data as Hex };
        }
        const f = typeof x.args.data === "string" && x.args.data.length > 2 ? flushArgs(x.args.data as Hex) : undefined;
        if (f) return f;
      }
    }
    return undefined;
  }

  private remember(ledger: string, envelope: unknown): void {
    if (typeof envelope === "string" && envelope.length > 2) this.envelopes.set(`${ledger}:${keccak256(envelope as Hex).toLowerCase()}`, envelope as Hex);
  }

  /**
   * The envelope a `ForwardRejected` refers to. A rejection from a local `sendMessage` failure carries it; a NACK in a
   * CLPR Response does not, and names it by `envelopeHash`: the envelope of this route's earlier `RouteForwarded`
   * (or `ForwardPending`) on the same Router.
   */
  private rejectedEnvelope(e: IndexedEvent): Hex | undefined {
    const inline = e.args.envelope as Hex | undefined;
    if (inline && inline !== "0x") return inline;
    const hash = String(e.args.envelopeHash ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return undefined;
    const known = this.envelopes.get(`${e.ledger}:${hash}`);
    if (known) return known;
    if (!e.routeId) return undefined;
    for (const x of this.o.store.eventsByRouteIds([e.routeId])) {
      if (x.ledger !== e.ledger || x.contract !== "router") continue;
      if (x.name !== "RouteForwarded" && x.name !== "ForwardPending") continue;
      const env = x.name === "RouteForwarded" ? x.args.data : x.args.envelope;
      if (typeof env === "string" && env.length > 2 && keccak256(env as Hex).toLowerCase() === hash) return env as Hex;
    }
    return undefined;
  }

  /** Turn one indexed event into a job. Returns true if a new job was added. */
  ingest(e: IndexedEvent): boolean {
    if (e.contract !== "router") return false;
    const a = e.args;
    if (e.name === "RouteForwarded") {
      // Routes: `data` is the envelope as held (key = its hash). Receipts: `data` is the message (key = outbox key).
      this.remember(e.ledger, a.data);
      if (typeof a.data === "string" && a.data.length > 2) {
        const f = flushArgs(a.data as Hex);
        if (f) this.receipts.set(`${e.ledger}:${String(a.key).toLowerCase()}`, f);
      }
      return false;
    }
    if (e.name === "ReceiptRequeued") {
      // CLPR rejected a receipt message; it is back in the outbox under `key`. Its data is in the earlier
      // OutboxQueued or RouteForwarded with that key.
      const k = String(a.key).toLowerCase();
      const f = this.receipts.get(`${e.ledger}:${k}`) ?? this.receiptFromStore(e.ledger, k);
      if (!f) {
        this.o.log?.(`trigger: ReceiptRequeued on ${e.ledger}: receipt ${k} not indexed`);
        return false;
      }
      const added = this.o.store.addJob({ ledger: e.ledger, kind: "flush", key: String(a.key), blockNumber: e.blockNumber, payload: f });
      if (!added) this.o.store.updateJob(e.ledger, "flush", String(a.key), { status: "pending" });
      return true;
    }
    if (e.name === "ForwardPending") {
      const envelope = a.envelope as Hex;
      this.remember(e.ledger, envelope);
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
      this.receipts.set(`${e.ledger}:${String(a.key).toLowerCase()}`, {
        channelId: a.channelId as Hex,
        connectorId: a.connectorId as Hex,
        target: a.target as Hex,
        data: a.data as Hex,
      });
      return this.o.store.addJob({
        ledger: e.ledger,
        kind: "flush",
        key: String(a.key),
        blockNumber: e.blockNumber,
        payload: { channelId: a.channelId, connectorId: a.connectorId, target: a.target, data: a.data },
      });
    }
    if (e.name === "ForwardRejected" && this.o.completeRejected) {
      const envelope = this.rejectedEnvelope(e);
      if (!envelope) {
        this.o.log?.(`trigger: ForwardRejected on ${e.ledger} for ${e.routeId}: envelope ${String(a.envelopeHash)} not indexed`);
        return false;
      }
      return this.o.store.addJob({
        ledger: e.ledger,
        kind: "reject",
        key: keccak256(envelope),
        routeId: e.routeId,
        blockNumber: e.blockNumber,
        payload: { envelope, hopIndex: Number(a.hopIndex), reason: String(a.reasonName ?? a.reason) },
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
            if (!chain || j.attempts >= (this.o.maxAttempts ?? MAX_ATTEMPTS)) continue;
            await this.run(chain, j);
          }
        } while (this.again && !this.stopped);
      } finally {
        this.busy = false;
      }
    })();
    return this.current;
  }

  /** Flush over the route's own Connector, then over each configured fallback of the Channel until one goes. */
  private async flushOverAnyConnector(chain: RouterChain, p: Record<string, Hex>): Promise<Hex> {
    const own = p.connectorId!;
    const others = (this.o.receiptConnectors?.[p.channelId!.toLowerCase()] ?? []).filter((c) => c.toLowerCase() !== own.toLowerCase());
    let last: unknown;
    for (const c of [own, ...others]) {
      try {
        return await chain.flush(p.channelId!, c, p.target!, p.data!);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  private async run(chain: RouterChain, j: TriggerJob): Promise<void> {
    const p = j.payload as Record<string, Hex>;
    try {
      if (j.kind === "flush") {
        if (!(await chain.outbox(j.key as Hex))) {
          this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "skipped", error: "already flushed" });
          this.o.onResult?.(j, "skipped");
          return;
        }
      } else {
        const sk = stateKey(p.envelope!);
        const st = await chain.hopState(sk);
        const ph = await chain.pendingHash(sk);
        const wanted = j.kind === "forward" ? FORWARD_PENDING : NACKED;
        if (st !== wanted || ph.toLowerCase() !== j.key.toLowerCase()) {
          this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "skipped", error: "already completed" });
          this.o.onResult?.(j, "skipped");
          return;
        }
      }
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "submitted", attempt: true });
      // The attempt must be durable before the transaction goes out (a crash then retries, never loops unbounded).
      await this.o.store.flush();
      const tx = j.kind === "flush" ? await this.flushOverAnyConnector(chain, p) : await chain.forward(p.envelope!);
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "done", txHash: tx });
      this.o.onResult?.(j, "done");
      this.o.log?.(`trigger: ${j.kind} on ${j.ledger} ${j.routeId ?? j.key} → ${tx}`);
    } catch (err) {
      this.o.store.updateJob(j.ledger, j.kind, j.key, { status: "failed", error: scrubMessage((err as Error).message).slice(0, 500) });
      this.o.onResult?.(j, "failed");
      this.o.log?.(`trigger: ${j.kind} on ${j.ledger} failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}
