// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, LATEST_VERSION, MigrationError, pendingMigrations } from "../src/db/migrations.js";
import { PgStore, migratePostgres } from "../src/db/pg.js";
import { Store } from "../src/store.js";
import { R, ev, h32, rid } from "./helpers.js";
import { startPg, type PgCluster } from "./pgcluster.js";

const L = "eip155:31001";
const tmp = () => join(mkdtempSync(join(tmpdir(), "clpr-store-")), "s.sqlite");

describe("migrations (SQLite)", () => {
  it("creates a fresh database at the latest version and records every step", () => {
    const s = new Store();
    expect(s.schemaVersion()).toBe(LATEST_VERSION);
    const rows = s.db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    const idx = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'trigger_jobs_status'").get();
    expect(idx).toBeTruthy();
  });

  it("is idempotent across restarts", () => {
    const path = tmp();
    new Store(path).close();
    const s = new Store(path);
    expect(s.migrate()).toEqual([]);
    s.close();
  });

  it("adopts a database created before migrations existed, keeping its data", () => {
    const path = tmp();
    const legacy = new DatabaseSync(path);
    legacy.exec(MIGRATIONS[0]!.sqlite);
    legacy.prepare("INSERT INTO cursors (ledger, block_number, block_hash) VALUES (?, ?, ?)").run(L, 7, h32("b7"));
    legacy.close();
    const s = new Store(path);
    expect(s.schemaVersion()).toBe(LATEST_VERSION);
    expect(s.getCursor(L)?.blockNumber).toBe(7);
    s.close();
  });

  it("refuses a database from a newer build", () => {
    const path = tmp();
    const s = new Store(path);
    s.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(LATEST_VERSION + 1, "future", 0);
    s.close();
    expect(() => new Store(path)).toThrow(MigrationError);
    expect(() => pendingMigrations([99])).toThrow(/newer than this build/);
  });
});

describe("routesPage (keyset pagination)", () => {
  it("pages newest first, filters by ledger and sender, and never repeats or skips", () => {
    const s = new Store();
    const other = "0xb0b0000000000000000000000000000000000002";
    const events = Array.from({ length: 25 }, (_, i) => ev(L, R.sent(rid(i + 1), i % 5 === 0 ? { sender: other } : {}), { block: i + 1 }));
    s.applyRange(L, events, { blockNumber: 25, blockHash: h32("b25") }, []);
    const seen: string[] = [];
    let after;
    for (let p = 0; p < 10; p++) {
      const page = s.routesPage({ limit: 7, after });
      seen.push(...page.items.map((e) => e.routeId!));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe(rid(25));
    const bySender = s.routesPage({ limit: 3, sender: other });
    expect(bySender.items.map((e) => e.routeId)).toEqual([rid(21), rid(16), rid(11)]);
    expect(s.routesPage({ limit: 3, sender: other, after: bySender.next! }).items.map((e) => e.routeId)).toEqual([rid(6), rid(1)]);
    expect(s.routesPage({ limit: 5, ledger: "eip155:9" }).items).toEqual([]);
  });
});

let cluster: PgCluster | undefined;
beforeAll(async () => {
  cluster = await startPg();
}, 120_000);
afterAll(() => cluster?.stop());

describe("PostgreSQL store", () => {
  const need = () => {
    if (!cluster) {
      console.warn("PostgreSQL tests skipped: no initdb/pg_ctl and no CLPROUTER_TEST_PG_URL");
      return false;
    }
    return true;
  };

  it("migrates under a lock, idempotently", async () => {
    if (!need()) return;
    const url = await cluster!.database("clpr_migrate");
    const pool = new pg.Pool({ connectionString: url });
    const [a, b] = await Promise.all([migratePostgres(pool), migratePostgres(pool)]);
    expect([...a, ...b].sort()).toEqual(MIGRATIONS.map((m) => m.version));
    const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    await pool.end();
  });

  it("replicates every mutation, survives a restart (hydration) and rolls back reorgs", async () => {
    if (!need()) return;
    const url = await cluster!.database("clpr_store");
    let s = await PgStore.open({ url });
    expect(s.backend).toBe("postgres");
    s.applyRange(L, [ev(L, R.sent(rid(1)), { block: 1 }), ev(L, R.sent(rid(2)), { block: 2 })], { blockNumber: 2, blockHash: h32("b2") }, [{ blockNumber: 1, blockHash: h32("b1") }]);
    s.setKv(L, "registrySnapshot", { version: 3 });
    expect(s.addJob({ ledger: L, kind: "forward", key: "k1", routeId: rid(1), blockNumber: 2, payload: { envelope: "0x01" } })).toBe(true);
    s.updateJob(L, "forward", "k1", { status: "failed", error: "boom", attempt: true });
    await s.flush();
    expect(s.backlog).toBe(0);
    await s.shutdown();

    s = await PgStore.open({ url });
    expect(s.getCursor(L)).toEqual({ blockNumber: 2, blockHash: h32("b2") });
    expect(s.eventsByRouteIds([rid(1), rid(2)])).toHaveLength(2);
    expect(s.getKv(L, "registrySnapshot")).toEqual({ version: 3 });
    expect(s.jobs()[0]).toMatchObject({ key: "k1", status: "failed", attempts: 1, error: "boom" });

    expect(s.rollback(L, { blockNumber: 1, blockHash: h32("b1") })).toBe(1);
    s.dropJobsAbove(L, 1);
    await s.flush();
    await s.shutdown();

    s = await PgStore.open({ url });
    expect(s.getCursor(L)?.blockNumber).toBe(1);
    expect(s.eventsByRouteIds([rid(2)])).toHaveLength(0);
    expect(s.jobs()).toHaveLength(0);
    await s.shutdown();
  });

  it("allows one writer per database", async () => {
    if (!need()) return;
    const url = await cluster!.database("clpr_lock");
    const a = await PgStore.open({ url });
    await expect(PgStore.open({ url })).rejects.toThrow(/writer lock/);
    await a.shutdown();
    const b = await PgStore.open({ url });
    await b.shutdown();
  });

  it("keeps writes queued (in order) while PostgreSQL is unreachable and reports it in health", async () => {
    if (!need()) return;
    const url = await cluster!.database("clpr_outage");
    const s = await PgStore.open({ url, maxLagMs: 50, maxRetryDelayMs: 50, writerLock: false });
    // Break the pool: every new connection fails until restored.
    const pool = (s as unknown as { pool: pg.Pool }).pool;
    const connect = pool.connect.bind(pool);
    let broken = true;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = () => (broken ? Promise.reject(new Error("ECONNREFUSED")) : connect());
    s.applyRange(L, [ev(L, R.sent(rid(5)), { block: 5 })], { blockNumber: 5, blockHash: h32("b5") }, []);
    s.setKv(L, "x", 1);
    await expect(s.flush(150)).rejects.toThrow(/timed out with 2 writes queued/);
    expect(s.health().ok).toBe(false);
    broken = false;
    await s.flush(5_000);
    expect(s.health().ok).toBe(true);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    expect((await c.query("SELECT block_number FROM cursors")).rows[0].block_number).toBe("5");
    await c.end();
    await s.shutdown();
  });
});
