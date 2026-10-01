import { EventEmitter } from "node:events";
import type { Address, Hex, Log } from "viem";
import { REGISTRY_ABI } from "./abi.js";
import type { LedgerConfig } from "./config.js";
import type { ContractKind, IndexedEvent } from "./events.js";
import { decodeLog } from "./events.js";
import type { Cursor, Store } from "./store.js";

/** The RPC surface the indexer needs. A viem `PublicClient` satisfies it; tests pass a mock. */
export interface ChainReader {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  getLogs(args: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  readContract?(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
}

export interface ReorgInfo {
  ledger: string;
  /** Cursor before the reorg. */
  from: number;
  /** Last block that still matched (−1: nothing matched, full re-index). */
  to: number;
  removedEvents: number;
}

/** Live notifications from every watcher (the SSE stream and the forward trigger listen here). */
export class EventBus extends EventEmitter {
  emitEvent(e: IndexedEvent): void {
    this.emit("event", e);
  }
  onEvent(fn: (e: IndexedEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

/** Snapshot of registry state that is set in the constructor and never emitted (initial committee, contact). */
export interface RegistrySnapshot {
  blockNumber: number;
  version: number;
  epoch: number;
  threshold: number;
  members: Address[];
  contact: string;
}

/**
 * Watches one ledger's Router, ProviderRegistry and QuarantineVault. Indexes only blocks at least
 * `confirmations` behind the head, and before every step re-checks that the last indexed block is still
 * canonical; if not, it rolls back to the newest checkpoint that still matches and re-indexes from there.
 */
export class LedgerWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private loopDone: Promise<void> | undefined;
  private readonly kinds = new Map<string, ContractKind>();
  readonly batchSize: number;

  constructor(
    readonly cfg: LedgerConfig,
    private readonly client: ChainReader,
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.kinds.set(cfg.contracts.router.toLowerCase(), "router");
    this.kinds.set(cfg.contracts.registry.toLowerCase(), "registry");
    this.kinds.set(cfg.contracts.vault.toLowerCase(), "vault");
    this.batchSize = cfg.batchSize ?? 2000;
  }

  get ledger(): string {
    return this.cfg.id;
  }

  cursor(): Cursor | undefined {
    return this.store.getCursor(this.cfg.id);
  }

  /** Read and store the registry's constructor-time state (committee, contact), which no event carries. */
  async snapshotRegistry(): Promise<RegistrySnapshot | undefined> {
    const rc = this.client.readContract?.bind(this.client);
    if (!rc) return undefined;
    const address = this.cfg.contracts.registry;
    const read = (functionName: string) => rc({ address, abi: REGISTRY_ABI, functionName });
    const [blockNumber, version, epoch, threshold, members, contact] = await Promise.all([
      this.client.getBlockNumber(),
      read("version"),
      read("epoch"),
      read("threshold"),
      read("members"),
      read("contact"),
    ]);
    const snap: RegistrySnapshot = {
      blockNumber: Number(blockNumber),
      version: Number(version),
      epoch: Number(epoch),
      threshold: Number(threshold),
      members: members as Address[],
      contact: contact as string,
    };
    this.store.setKv(this.cfg.id, "registrySnapshot", snap);
    return snap;
  }

  /**
   * Index every confirmed block not indexed yet. Returns the number of new events. Safe to call concurrently
   * with itself (a second call returns 0 while the first runs).
   */
  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let total = 0;
      for (;;) {
        // No client-side caching: viem caches the head per client, which would hold the indexer back.
        const head = Number(await this.client.getBlockNumber({ cacheTime: 0 }));
        const safe = head - this.cfg.confirmations;
        const start = this.cfg.startBlock ?? 0;
        if (safe < start) return total;

        let cursor = this.cursor();
        if (cursor && !(await this.isCanonical(cursor))) cursor = await this.handleReorg(cursor);

        const from = cursor ? cursor.blockNumber + 1 : start;
        if (from > safe) return total;
        const to = Math.min(safe, from + this.batchSize - 1);
        const n = await this.indexRange(from, to);
        if (n < 0) return total; // the chain moved under us; retry on the next poll
        total += n;
        if (to >= safe) return total;
      }
    } finally {
      this.running = false;
    }
  }

  private async isCanonical(c: Cursor): Promise<boolean> {
    const b = await this.client.getBlock({ blockNumber: BigInt(c.blockNumber) });
    return (b.hash ?? "").toLowerCase() === c.blockHash.toLowerCase();
  }

  private async handleReorg(cursor: Cursor): Promise<Cursor | undefined> {
    let keep: Cursor | undefined;
    for (const cp of this.store.checkpoints(this.cfg.id)) {
      if (cp.blockNumber >= cursor.blockNumber) continue;
      if (await this.isCanonical(cp)) {
        keep = cp;
        break;
      }
    }
    const removed = this.store.rollback(this.cfg.id, keep);
    this.store.dropJobsAbove(this.cfg.id, keep?.blockNumber ?? -1);
    const info: ReorgInfo = { ledger: this.cfg.id, from: cursor.blockNumber, to: keep?.blockNumber ?? -1, removedEvents: removed };
    this.log(`reorg on ${this.cfg.id}: rolled back ${cursor.blockNumber} → ${info.to} (${removed} events)`);
    this.bus.emit("reorg", info);
    return keep;
  }

  /** Index [from, to]. Returns the number of events, or −1 if a block hash changed during the read. */
  private async indexRange(from: number, to: number): Promise<number> {
    const logs = await this.client.getLogs({
      address: [this.cfg.contracts.router, this.cfg.contracts.registry, this.cfg.contracts.vault],
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    const blocks = new Map<number, { hash: Hex; timestamp: number }>();
    const blockOf = async (n: number) => {
      let b = blocks.get(n);
      if (!b) {
        const r = await this.client.getBlock({ blockNumber: BigInt(n) });
        b = { hash: r.hash as Hex, timestamp: Number(r.timestamp) };
        blocks.set(n, b);
      }
      return b;
    };

    const events: IndexedEvent[] = [];
    for (const l of logs) {
      if (l.removed) continue;
      const kind = this.kinds.get(l.address.toLowerCase());
      if (!kind || l.blockNumber === null) continue;
      const b = await blockOf(Number(l.blockNumber));
      if (l.blockHash && l.blockHash.toLowerCase() !== b.hash.toLowerCase()) return -1;
      const e = decodeLog(this.cfg.id, kind, l, b.timestamp);
      if (e) events.push(e);
    }
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const end = await blockOf(to);
    const checkpoints = [...blocks.entries()].map(([n, b]) => ({ blockNumber: n, blockHash: b.hash }));
    this.store.applyRange(this.cfg.id, events, { blockNumber: to, blockHash: end.hash }, checkpoints);
    for (const e of events) this.bus.emitEvent(e);
    this.bus.emit("cursor", { ledger: this.cfg.id, blockNumber: to, blockHash: end.hash });
    return events.length;
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.log(`indexer ${this.cfg.id}: ${(err as Error).message}`);
      }
      if (!this.stopped) this.timer = setTimeout(() => (this.loopDone = loop()), this.cfg.pollIntervalMs ?? 2000);
    };
    this.loopDone = loop();
  }

  /** Stop polling and wait for a poll in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loopDone;
  }
}

/** All watchers of a deployment. */
export class Indexer {
  readonly watchers = new Map<string, LedgerWatcher>();

  constructor(
    readonly store: Store,
    readonly bus: EventBus = new EventBus(),
  ) {}

  add(w: LedgerWatcher): void {
    this.watchers.set(w.ledger, w);
  }

  async pollAll(): Promise<number> {
    const n = await Promise.all([...this.watchers.values()].map((w) => w.poll()));
    return n.reduce((a, b) => a + b, 0);
  }

  /** Per-ledger confirmed block: the inputs every answer is built from. */
  cursors(): Record<string, Cursor | null> {
    const out: Record<string, Cursor | null> = {};
    for (const [id, w] of this.watchers) out[id] = w.cursor() ?? null;
    return out;
  }

  start(): void {
    for (const w of this.watchers.values()) w.start();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((w) => w.stop()));
  }
}
