import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { MIGRATIONS_TABLE, pendingMigrations } from "./db/migrations.js";
import type { ContractKind, IndexedEvent } from "./events.js";

export interface Cursor {
  /** Last indexed (confirmed) block. */
  blockNumber: number;
  blockHash: Hex;
}

export type JobStatus = "pending" | "submitted" | "done" | "skipped" | "failed";

export interface TriggerJob {
  ledger: string;
  kind: "forward" | "flush" | "reject";
  key: string;
  routeId?: Hex;
  status: JobStatus;
  txHash?: Hex;
  error?: string;
  attempts: number;
  /** Event that created the job (for the API). */
  blockNumber: number;
  payload: Record<string, unknown>;
  updatedAt: number;
}

/** How many block-hash checkpoints to keep per ledger for reorg detection. */
const CHECKPOINTS_KEPT = 512;

/**
 * Small persistent store (SQLite through `node:sqlite`). Raw decoded events are the source of truth; every view
 * (route status, registry, notices) is derived from them, so rolling back a reorg is just deleting events.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  /** Apply pending schema migrations (see `db/migrations.ts`). Returns the versions applied. */
  migrate(): number[] {
    this.db.exec(MIGRATIONS_TABLE.sqlite);
    const applied = (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => Number(r.version));
    const todo = pendingMigrations(applied);
    for (const m of todo) {
      this.tx(() => {
        this.db.exec(m.sqlite);
        this.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
      });
    }
    return todo.map((m) => m.version);
  }

  /** Highest applied schema version. */
  schemaVersion(): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
    return Number(r.v ?? 0);
  }

  /** Storage backend name (metrics, readiness). */
  get backend(): "sqlite" | "postgres" {
    return "sqlite";
  }

  /** Throws if the database cannot answer a trivial query (readiness). */
  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  /** Wait until every write so far is durable. SQLite writes are synchronous, so this is a no-op here. */
  async flush(_timeoutMs?: number): Promise<void> {}

  /** Readiness detail of the durable store; `ok: false` makes /readyz fail. */
  health(): { ok: boolean; detail?: string } {
    return { ok: true };
  }

  /** Flush and close (graceful shutdown). */
  async shutdown(): Promise<void> {
    this.close();
  }

  close(): void {
    this.db.close();
  }

  protected tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── Indexing ────────────────────────────────────────────────────────────

  getCursor(ledger: string): Cursor | undefined {
    const r = this.db.prepare("SELECT block_number, block_hash FROM cursors WHERE ledger = ?").get(ledger) as
      | { block_number: number; block_hash: string }
      | undefined;
    return r ? { blockNumber: r.block_number, blockHash: r.block_hash as Hex } : undefined;
  }

  /** Checkpoints (block number → hash) newest first. */
  checkpoints(ledger: string): Cursor[] {
    const rows = this.db
      .prepare("SELECT block_number, block_hash FROM checkpoints WHERE ledger = ? ORDER BY block_number DESC")
      .all(ledger) as { block_number: number; block_hash: string }[];
    return rows.map((r) => ({ blockNumber: r.block_number, blockHash: r.block_hash as Hex }));
  }

  /**
   * Atomically append a confirmed range: its events, the block hashes seen (checkpoints) and the new cursor.
   * Re-applying the same events is harmless (primary key on ledger, tx, log index).
   */
  applyRange(ledger: string, events: IndexedEvent[], cursor: Cursor, checkpoints: Cursor[]): void {
    const insEvent = this.db.prepare(`
      INSERT OR REPLACE INTO events
        (ledger, block_number, block_hash, tx_hash, log_index, contract, address, name, timestamp,
         route_id, case_id, account_key, args)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insCp = this.db.prepare(
      "INSERT OR REPLACE INTO checkpoints (ledger, block_number, block_hash) VALUES (?, ?, ?)",
    );
    this.tx(() => {
      for (const e of events) {
        insEvent.run(
          ledger,
          e.blockNumber,
          e.blockHash,
          e.txHash,
          e.logIndex,
          e.contract,
          e.address,
          e.name,
          e.timestamp,
          e.routeId?.toLowerCase() ?? null,
          e.caseId?.toLowerCase() ?? null,
          e.accountKey?.toLowerCase() ?? null,
          JSON.stringify(e.args),
        );
      }
      for (const c of [...checkpoints, cursor]) insCp.run(ledger, c.blockNumber, c.blockHash);
      this.db
        .prepare(
          "INSERT INTO cursors (ledger, block_number, block_hash) VALUES (?, ?, ?) " +
            "ON CONFLICT(ledger) DO UPDATE SET block_number = excluded.block_number, block_hash = excluded.block_hash",
        )
        .run(ledger, cursor.blockNumber, cursor.blockHash);
      this.db
        .prepare(
          "DELETE FROM checkpoints WHERE ledger = ? AND block_number NOT IN " +
            "(SELECT block_number FROM checkpoints WHERE ledger = ? ORDER BY block_number DESC LIMIT ?)",
        )
        .run(ledger, ledger, CHECKPOINTS_KEPT);
    });
  }

  /** Undo everything above `cursor` (a reorg past the confirmation depth). Returns the events removed. */
  rollback(ledger: string, cursor: Cursor | undefined): number {
    const from = cursor?.blockNumber ?? -1;
    return this.tx(() => {
      const removed = this.db
        .prepare("DELETE FROM events WHERE ledger = ? AND block_number > ?")
        .run(ledger, from).changes;
      this.db.prepare("DELETE FROM checkpoints WHERE ledger = ? AND block_number > ?").run(ledger, from);
      if (cursor) {
        this.db
          .prepare("UPDATE cursors SET block_number = ?, block_hash = ? WHERE ledger = ?")
          .run(cursor.blockNumber, cursor.blockHash, ledger);
      } else {
        this.db.prepare("DELETE FROM cursors WHERE ledger = ?").run(ledger);
      }
      return Number(removed);
    });
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  private rowsToEvents(rows: unknown[]): IndexedEvent[] {
    return (rows as Record<string, unknown>[]).map((r) => {
      const e: IndexedEvent = {
        ledger: r.ledger as string,
        contract: r.contract as ContractKind,
        address: r.address as Hex,
        name: r.name as string,
        blockNumber: Number(r.block_number),
        blockHash: r.block_hash as Hex,
        txHash: r.tx_hash as Hex,
        logIndex: Number(r.log_index),
        timestamp: Number(r.timestamp),
        args: JSON.parse(r.args as string) as IndexedEvent["args"],
      };
      if (r.route_id) e.routeId = r.route_id as Hex;
      if (r.case_id) e.caseId = r.case_id as Hex;
      if (r.account_key) e.accountKey = r.account_key as Hex;
      return e;
    });
  }

  private static readonly ORDER = " ORDER BY timestamp, ledger, block_number, log_index";

  eventsByRouteIds(ids: string[]): IndexedEvent[] {
    if (ids.length === 0) return [];
    const q = `SELECT * FROM events WHERE route_id IN (${ids.map(() => "?").join(",")})${Store.ORDER}`;
    return this.rowsToEvents(this.db.prepare(q).all(...ids.map((i) => i.toLowerCase())));
  }

  eventsByAccountKey(key: string): IndexedEvent[] {
    return this.rowsToEvents(
      this.db.prepare(`SELECT * FROM events WHERE account_key = ?${Store.ORDER}`).all(key.toLowerCase()),
    );
  }

  eventsByCase(caseId: string): IndexedEvent[] {
    return this.rowsToEvents(this.db.prepare(`SELECT * FROM events WHERE case_id = ?${Store.ORDER}`).all(caseId.toLowerCase()));
  }

  /** Events of one contract kind, on one ledger or all, in chain order per ledger. */
  eventsByContract(contract: ContractKind, ledger?: string): IndexedEvent[] {
    const rows = ledger
      ? this.db
          .prepare("SELECT * FROM events WHERE contract = ? AND ledger = ? ORDER BY block_number, log_index")
          .all(contract, ledger)
      : this.db.prepare("SELECT * FROM events WHERE contract = ? ORDER BY ledger, block_number, log_index").all(contract);
    return this.rowsToEvents(rows);
  }

  eventsByName(name: string, ledger?: string): IndexedEvent[] {
    const rows = ledger
      ? this.db.prepare("SELECT * FROM events WHERE name = ? AND ledger = ? ORDER BY block_number, log_index").all(name, ledger)
      : this.db.prepare("SELECT * FROM events WHERE name = ? ORDER BY ledger, block_number, log_index").all(name);
    return this.rowsToEvents(rows);
  }

  /** Router `RouteSent` events whose (indexed) sender is `address` on `ledger`. */
  routesSentBy(ledger: string, address: string): IndexedEvent[] {
    return this.eventsByName("RouteSent", ledger).filter(
      (e) => String(e.args.sender).toLowerCase() === address.toLowerCase(),
    );
  }

  // ── Key/value (bootstrap snapshots) ─────────────────────────────────────

  setKv(ledger: string, key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv (ledger, key, value) VALUES (?, ?, ?) ON CONFLICT(ledger, key) DO UPDATE SET value = excluded.value")
      .run(ledger, key, JSON.stringify(value));
  }

  getKv<T>(ledger: string, key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE ledger = ? AND key = ?").get(ledger, key) as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  // ── Trigger jobs ────────────────────────────────────────────────────────

  /** Insert a job unless one exists for (ledger, kind, key). Returns true if inserted. */
  addJob(job: Omit<TriggerJob, "attempts" | "updatedAt" | "status">): boolean {
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO trigger_jobs (ledger, kind, key, route_id, status, attempts, block_number, payload, updated_at) " +
          "VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
      )
      .run(job.ledger, job.kind, job.key, job.routeId ?? null, job.blockNumber, JSON.stringify(job.payload), Date.now());
    return Number(r.changes) > 0;
  }

  updateJob(ledger: string, kind: string, key: string, patch: Partial<Pick<TriggerJob, "status" | "txHash" | "error">> & { attempt?: boolean }): void {
    const cur = this.db.prepare("SELECT * FROM trigger_jobs WHERE ledger = ? AND kind = ? AND key = ?").get(ledger, kind, key);
    if (!cur) return;
    const c = cur as Record<string, unknown>;
    this.db
      .prepare(
        "UPDATE trigger_jobs SET status = ?, tx_hash = ?, error = ?, attempts = ?, updated_at = ? WHERE ledger = ? AND kind = ? AND key = ?",
      )
      .run(
        patch.status ?? (c.status as string),
        patch.txHash ?? (c.tx_hash as string | null),
        patch.error ?? null,
        Number(c.attempts) + (patch.attempt ? 1 : 0),
        Date.now(),
        ledger,
        kind,
        key,
      );
  }

  jobs(filter: { status?: JobStatus[]; ledger?: string } = {}): TriggerJob[] {
    const rows = this.db.prepare("SELECT * FROM trigger_jobs ORDER BY block_number, updated_at").all() as Record<string, unknown>[];
    return rows
      .map((r) => ({
        ledger: r.ledger as string,
        kind: r.kind as TriggerJob["kind"],
        key: r.key as string,
        routeId: (r.route_id as Hex | null) ?? undefined,
        status: r.status as JobStatus,
        txHash: (r.tx_hash as Hex | null) ?? undefined,
        error: (r.error as string | null) ?? undefined,
        attempts: Number(r.attempts),
        blockNumber: Number(r.block_number),
        payload: JSON.parse(r.payload as string) as Record<string, unknown>,
        updatedAt: Number(r.updated_at),
      }))
      .filter((j) => (!filter.status || filter.status.includes(j.status)) && (!filter.ledger || j.ledger === filter.ledger));
  }

  /** Rolled-back blocks must not keep jobs whose event vanished. */
  dropJobsAbove(ledger: string, blockNumber: number): void {
    this.db
      .prepare("DELETE FROM trigger_jobs WHERE ledger = ? AND block_number > ? AND status IN ('pending', 'failed')")
      .run(ledger, blockNumber);
  }
  /** Open jobs per (ledger, kind, status) (metrics). */
  jobCounts(): { ledger: string; kind: string; status: JobStatus; n: number }[] {
    return (
      this.db.prepare("SELECT ledger, kind, status, COUNT(*) AS n FROM trigger_jobs GROUP BY ledger, kind, status").all() as {
        ledger: string;
        kind: string;
        status: JobStatus;
        n: number;
      }[]
    ).map((r) => ({ ...r, n: Number(r.n) }));
  }

  // ── Pagination ─────────────────────────────────────────────────────────

  /**
   * Routes sent (`RouteSent`), newest first, keyset-paginated: pass the previous page's `next` as `after`.
   * Filters: origin ledger and (indexed) sender address.
   */
  routesPage(o: { ledger?: string; sender?: string; limit: number; after?: PageKey }): { items: IndexedEvent[]; next: PageKey | null } {
    const where = ["name = 'RouteSent'"];
    const args: (string | number)[] = [];
    if (o.ledger) {
      where.push("ledger = ?");
      args.push(o.ledger);
    }
    // Sender is an indexed topic stored inside `args`; filter after the keyset scan, reading ahead in chunks.
    const out: IndexedEvent[] = [];
    let cursor = o.after;
    const chunk = Math.max(o.limit + 1, 64);
    for (;;) {
      const w = cursor ? [...where, "(timestamp, ledger, block_number, log_index) < (?, ?, ?, ?)"] : where;
      const a = cursor ? [...args, cursor.timestamp, cursor.ledger, cursor.blockNumber, cursor.logIndex] : args;
      const rows = this.rowsToEvents(
        this.db
          // The partial index (migration 2) gives the order directly; without the hint SQLite picks events_name and
          // sorts every RouteSent row per page.
          .prepare(`SELECT * FROM events INDEXED BY events_route_sent WHERE ${w.join(" AND ")} ORDER BY timestamp DESC, ledger DESC, block_number DESC, log_index DESC LIMIT ?`)
          .all(...a, chunk),
      );
      for (const e of rows) {
        if (o.sender && String(e.args.sender).toLowerCase() !== o.sender.toLowerCase()) continue;
        out.push(e);
        if (out.length > o.limit) break;
      }
      if (out.length > o.limit || rows.length < chunk) break;
      const last = rows[rows.length - 1]!;
      cursor = { timestamp: last.timestamp, ledger: last.ledger, blockNumber: last.blockNumber, logIndex: last.logIndex };
    }
    const items = out.slice(0, o.limit);
    const tail = items[items.length - 1];
    const next = out.length > o.limit && tail ? { timestamp: tail.timestamp, ledger: tail.ledger, blockNumber: tail.blockNumber, logIndex: tail.logIndex } : null;
    return { items, next };
  }

  /** Raw row of one job (PostgreSQL replication). */
  protected jobRow(ledger: string, kind: string, key: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM trigger_jobs WHERE ledger = ? AND kind = ? AND key = ?").get(ledger, kind, key) as Record<string, unknown> | undefined;
  }
}

/** Keyset position in the event order used by {@link Store.routesPage}. */
export interface PageKey {
  timestamp: number;
  ledger: string;
  blockNumber: number;
  logIndex: number;
}
