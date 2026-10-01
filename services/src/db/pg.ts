// SPDX-License-Identifier: MIT
import pg from "pg";
import type { IndexedEvent } from "../events.js";
import type { Logger } from "../log.js";
import { silentLogger } from "../log.js";
import { Store, type Cursor, type TriggerJob } from "../store.js";
import { MIGRATIONS_TABLE, pendingMigrations } from "./migrations.js";

/** Advisory lock keys (arbitrary constants, "CLPR" + purpose). */
const MIGRATION_LOCK = 0x434c5052_01;
const WRITER_LOCK = 0x434c5052_02;
const CHECKPOINTS_KEPT = 512;

type Op = { name: string; run: (c: pg.PoolClient) => Promise<void> };

export interface PgStoreOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  log?: Logger;
  /** Backoff cap between retries of a failed replicated write, ms. Default 5000. */
  maxRetryDelayMs?: number;
  /** Writes waiting longer than this make `health()` fail, ms. Default 30000. */
  maxLagMs?: number;
  /** Take the single-writer advisory lock (default true). Off only for read-only tools and tests. */
  writerLock?: boolean;
}

/** Run every pending migration under an advisory lock, each in its own transaction. Returns versions applied. */
export async function migratePostgres(pool: pg.Pool): Promise<number[]> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await c.query(MIGRATIONS_TABLE.postgres);
      const { rows } = await c.query<{ version: number }>("SELECT version FROM schema_migrations");
      const todo = pendingMigrations(rows.map((r) => Number(r.version)));
      for (const m of todo) {
        await c.query("BEGIN");
        try {
          await c.query(m.postgres);
          await c.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [m.version, m.name, Date.now()]);
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }
      return todo.map((m) => m.version);
    } finally {
      await c.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    c.release();
  }
}

/**
 * PostgreSQL-backed store.
 *
 * PostgreSQL is the system of record. Queries run on an in-process SQLite mirror (the same SQL every view already
 * uses, and synchronous), hydrated from PostgreSQL at startup. Every mutation is applied to the mirror and queued
 * for PostgreSQL; the queue is strictly ordered, each item is idempotent (upserts and range deletes), and a failed
 * item is retried with backoff until it lands, so PostgreSQL never skips a write. The indexer awaits {@link flush}
 * after each range before announcing its events, and the trigger before sending a transaction, so nothing is acted
 * on that is not durable.
 *
 * Exactly one writer per database: a session advisory lock is taken at startup and a second instance refuses to
 * start. Scale reads by putting more API replicas behind the writer is a follow-up (they would hydrate read-only).
 */
export class PgStore extends Store {
  private queue: Op[] = [];
  private draining: Promise<void> | undefined;
  private closed = false;
  private lastError: string | undefined;
  private oldestQueuedAt: number | undefined;
  private waiters: (() => void)[] = [];
  private readonly log: Logger;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly lockClient: pg.PoolClient | undefined,
    private readonly o: PgStoreOptions,
  ) {
    super(":memory:");
    this.log = o.log ?? silentLogger;
  }

  static async open(o: PgStoreOptions): Promise<PgStore> {
    const pool = new pg.Pool({
      connectionString: o.url,
      max: o.poolMax ?? 10,
      statement_timeout: o.statementTimeoutMs ?? 15_000,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "clprouter-services",
    });
    // An idle client erroring (server restart) must not crash the process; the next query reconnects.
    pool.on("error", (e) => (o.log ?? silentLogger).warn("postgres pool error", { err: e.message }));
    let lockClient: pg.PoolClient | undefined;
    try {
      await migratePostgres(pool);
      if (o.writerLock !== false) {
        lockClient = await pool.connect();
        const { rows } = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [WRITER_LOCK]);
        if (!rows[0]?.ok) throw new Error("another clprouter-services instance holds the writer lock on this database");
        lockClient.on("error", (e) => (o.log ?? silentLogger).error("postgres writer-lock connection lost", { err: e.message }));
      }
      const s = new PgStore(pool, lockClient, o);
      await s.hydrate();
      return s;
    } catch (e) {
      lockClient?.release();
      await pool.end().catch(() => {});
      throw e;
    }
  }

  override get backend(): "sqlite" | "postgres" {
    return "postgres";
  }

  /** Load PostgreSQL into the SQLite mirror. */
  private async hydrate(): Promise<void> {
    const q = async (sql: string) => (await this.pool.query(sql)).rows as Record<string, unknown>[];
    const [events, cursors, checkpoints, kv, jobs] = await Promise.all([
      q("SELECT * FROM events"),
      q("SELECT * FROM cursors"),
      q("SELECT * FROM checkpoints"),
      q("SELECT * FROM kv"),
      q("SELECT * FROM trigger_jobs"),
    ]);
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    this.tx(() => {
      const ev = this.db.prepare(
        "INSERT OR REPLACE INTO events (ledger, block_number, block_hash, tx_hash, log_index, contract, address, name, timestamp, route_id, case_id, account_key, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of events) {
        ev.run(r.ledger as string, n(r.block_number), r.block_hash as string, r.tx_hash as string, n(r.log_index), r.contract as string, r.address as string, r.name as string, n(r.timestamp), (r.route_id as string) ?? null, (r.case_id as string) ?? null, (r.account_key as string) ?? null, r.args as string);
      }
      const cu = this.db.prepare("INSERT OR REPLACE INTO cursors (ledger, block_number, block_hash) VALUES (?, ?, ?)");
      for (const r of cursors) cu.run(r.ledger as string, n(r.block_number), r.block_hash as string);
      const cp = this.db.prepare("INSERT OR REPLACE INTO checkpoints (ledger, block_number, block_hash) VALUES (?, ?, ?)");
      for (const r of checkpoints) cp.run(r.ledger as string, n(r.block_number), r.block_hash as string);
      const k = this.db.prepare("INSERT OR REPLACE INTO kv (ledger, key, value) VALUES (?, ?, ?)");
      for (const r of kv) k.run(r.ledger as string, r.key as string, r.value as string);
      const j = this.db.prepare(
        "INSERT OR REPLACE INTO trigger_jobs (ledger, kind, key, route_id, status, tx_hash, error, attempts, block_number, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of jobs) j.run(r.ledger as string, r.kind as string, r.key as string, (r.route_id as string) ?? null, r.status as string, (r.tx_hash as string) ?? null, (r.error as string) ?? null, n(r.attempts), n(r.block_number), r.payload as string, n(r.updated_at));
    });
    this.log.info("postgres store hydrated", { events: events.length, jobs: jobs.length, ledgers: cursors.length });
  }

  // ── Replicated mutations ────────────────────────────────────────────────

  override applyRange(ledger: string, events: IndexedEvent[], cursor: Cursor, checkpoints: Cursor[]): void {
    super.applyRange(ledger, events, cursor, checkpoints);
    const rows = events.map((e) => [
      ledger, e.blockNumber, e.blockHash, e.txHash, e.logIndex, e.contract, e.address, e.name, e.timestamp,
      e.routeId?.toLowerCase() ?? null, e.caseId?.toLowerCase() ?? null, e.accountKey?.toLowerCase() ?? null, JSON.stringify(e.args),
    ]);
    const cps = [...checkpoints, cursor];
    this.enqueue("applyRange", async (c) => {
      await c.query("BEGIN");
      try {
        for (let i = 0; i < rows.length; i += 500) {
          const part = rows.slice(i, i + 500);
          const values = part.map((_, r) => `(${Array.from({ length: 13 }, (_x, k) => `$${r * 13 + k + 1}`).join(", ")})`).join(", ");
          await c.query(
            `INSERT INTO events (ledger, block_number, block_hash, tx_hash, log_index, contract, address, name, timestamp, route_id, case_id, account_key, args)
             VALUES ${values}
             ON CONFLICT (ledger, tx_hash, log_index) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash,
               contract = EXCLUDED.contract, address = EXCLUDED.address, name = EXCLUDED.name, timestamp = EXCLUDED.timestamp,
               route_id = EXCLUDED.route_id, case_id = EXCLUDED.case_id, account_key = EXCLUDED.account_key, args = EXCLUDED.args`,
            part.flat(),
          );
        }
        for (const cp of cps) {
          await c.query(
            "INSERT INTO checkpoints (ledger, block_number, block_hash) VALUES ($1, $2, $3) ON CONFLICT (ledger, block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash",
            [ledger, cp.blockNumber, cp.blockHash],
          );
        }
        await c.query(
          "INSERT INTO cursors (ledger, block_number, block_hash) VALUES ($1, $2, $3) ON CONFLICT (ledger) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash",
          [ledger, cursor.blockNumber, cursor.blockHash],
        );
        await c.query(
          "DELETE FROM checkpoints WHERE ledger = $1 AND block_number NOT IN (SELECT block_number FROM checkpoints WHERE ledger = $1 ORDER BY block_number DESC LIMIT $2)",
          [ledger, CHECKPOINTS_KEPT],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  }

  override rollback(ledger: string, cursor: Cursor | undefined): number {
    const removed = super.rollback(ledger, cursor);
    const from = cursor?.blockNumber ?? -1;
    this.enqueue("rollback", async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("DELETE FROM events WHERE ledger = $1 AND block_number > $2", [ledger, from]);
        await c.query("DELETE FROM checkpoints WHERE ledger = $1 AND block_number > $2", [ledger, from]);
        if (cursor) await c.query("UPDATE cursors SET block_number = $1, block_hash = $2 WHERE ledger = $3", [cursor.blockNumber, cursor.blockHash, ledger]);
        else await c.query("DELETE FROM cursors WHERE ledger = $1", [ledger]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    });
    return removed;
  }

  override setKv(ledger: string, key: string, value: unknown): void {
    super.setKv(ledger, key, value);
    const v = JSON.stringify(value);
    this.enqueue("setKv", async (c) => {
      await c.query("INSERT INTO kv (ledger, key, value) VALUES ($1, $2, $3) ON CONFLICT (ledger, key) DO UPDATE SET value = EXCLUDED.value", [ledger, key, v]);
    });
  }

  override addJob(job: Omit<TriggerJob, "attempts" | "updatedAt" | "status">): boolean {
    const inserted = super.addJob(job);
    if (inserted) this.replicateJob(job.ledger, job.kind, job.key);
    return inserted;
  }

  override updateJob(ledger: string, kind: string, key: string, patch: Parameters<Store["updateJob"]>[3]): void {
    super.updateJob(ledger, kind, key, patch);
    this.replicateJob(ledger, kind, key);
  }

  override dropJobsAbove(ledger: string, blockNumber: number): void {
    super.dropJobsAbove(ledger, blockNumber);
    this.enqueue("dropJobsAbove", async (c) => {
      await c.query("DELETE FROM trigger_jobs WHERE ledger = $1 AND block_number > $2 AND status IN ('pending', 'failed')", [ledger, blockNumber]);
    });
  }

  /** Copy the mirror's current row of a job to PostgreSQL (absolute values, so retries are idempotent). */
  private replicateJob(ledger: string, kind: string, key: string): void {
    const r = this.jobRow(ledger, kind, key);
    if (!r) return;
    const vals = [r.ledger, r.kind, r.key, r.route_id ?? null, r.status, r.tx_hash ?? null, r.error ?? null, Number(r.attempts), Number(r.block_number), r.payload, Number(r.updated_at)];
    this.enqueue("job", async (c) => {
      await c.query(
        `INSERT INTO trigger_jobs (ledger, kind, key, route_id, status, tx_hash, error, attempts, block_number, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (ledger, kind, key) DO UPDATE SET route_id = EXCLUDED.route_id, status = EXCLUDED.status, tx_hash = EXCLUDED.tx_hash,
           error = EXCLUDED.error, attempts = EXCLUDED.attempts, block_number = EXCLUDED.block_number, payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at`,
        vals,
      );
    });
  }

  // ── Write queue ─────────────────────────────────────────────────────────

  /** Writes not yet in PostgreSQL. */
  get backlog(): number {
    return this.queue.length;
  }

  private enqueue(name: string, run: Op["run"]): void {
    if (this.closed) throw new Error("store is closed");
    if (this.queue.length === 0) this.oldestQueuedAt = Date.now();
    this.queue.push({ name, run });
    this.draining ??= this.drain().finally(() => (this.draining = undefined));
  }

  private async drain(): Promise<void> {
    let attempt = 0;
    while (this.queue.length) {
      const op = this.queue[0]!;
      let c: pg.PoolClient | undefined;
      try {
        c = await this.pool.connect();
        await op.run(c);
        c.release();
        this.queue.shift();
        this.oldestQueuedAt = this.queue.length ? Date.now() : undefined;
        if (this.lastError) this.log.info("postgres writes recovered", { backlog: this.queue.length });
        this.lastError = undefined;
        attempt = 0;
      } catch (e) {
        c?.release(true);
        this.lastError = `${op.name}: ${(e as Error).message}`;
        if (this.closed && attempt >= 3) {
          this.log.error("postgres write abandoned at shutdown (will be re-derived on restart)", { op: op.name, backlog: this.queue.length });
          this.queue = [];
          break;
        }
        const delay = Math.min(this.o.maxRetryDelayMs ?? 5_000, 100 * 2 ** attempt) * (0.5 + Math.random() / 2);
        attempt++;
        this.log.warn("postgres write failed; retrying", { op: op.name, attempt, err: (e as Error).message, backlog: this.queue.length });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    for (const w of this.waiters.splice(0)) w();
  }

  /** Wait until every queued write is in PostgreSQL. Rejects after `timeoutMs` (default 30000). */
  override async flush(timeoutMs = 30_000): Promise<void> {
    if (this.queue.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`postgres flush timed out with ${this.queue.length} writes queued${this.lastError ? ` (${this.lastError})` : ""}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  override async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  override health(): { ok: boolean; detail?: string } {
    const lag = this.oldestQueuedAt ? Date.now() - this.oldestQueuedAt : 0;
    if (lag > (this.o.maxLagMs ?? 30_000)) return { ok: false, detail: `postgres writes ${lag} ms behind (${this.queue.length} queued): ${this.lastError ?? "slow"}` };
    return { ok: true, ...(this.lastError ? { detail: this.lastError } : {}) };
  }

  override async shutdown(): Promise<void> {
    await this.flush(10_000).catch((e: Error) => this.log.error("postgres flush at shutdown failed", { err: e.message }));
    this.closed = true;
    await this.draining;
    try {
      if (this.lockClient) {
        await this.lockClient.query("SELECT pg_advisory_unlock($1)", [WRITER_LOCK]).catch(() => {});
        this.lockClient.release();
      }
    } finally {
      await this.pool.end().catch(() => {});
      this.close();
    }
  }
}
