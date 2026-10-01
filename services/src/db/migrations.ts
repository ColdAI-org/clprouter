// SPDX-License-Identifier: MIT
/**
 * Versioned schema migrations, one list for both dialects. Each version is applied once, in order, inside a
 * transaction, and recorded in `schema_migrations`. A database at a newer version than this build knows is refused
 * (no silent downgrade). Version 1 is the original schema with `IF NOT EXISTS`, so a database created before
 * migrations existed is adopted as-is.
 */

export interface Migration {
  version: number;
  name: string;
  sqlite: string;
  postgres: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sqlite: `
      CREATE TABLE IF NOT EXISTS events (
        ledger TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        contract TEXT NOT NULL,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        route_id TEXT,
        case_id TEXT,
        account_key TEXT,
        args TEXT NOT NULL,
        PRIMARY KEY (ledger, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS events_route ON events(route_id);
      CREATE INDEX IF NOT EXISTS events_case ON events(case_id);
      CREATE INDEX IF NOT EXISTS events_account ON events(account_key);
      CREATE INDEX IF NOT EXISTS events_block ON events(ledger, block_number);
      CREATE INDEX IF NOT EXISTS events_contract ON events(contract, ledger);
      CREATE TABLE IF NOT EXISTS cursors (
        ledger TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        ledger TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        PRIMARY KEY (ledger, block_number)
      );
      CREATE TABLE IF NOT EXISTS kv (
        ledger TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (ledger, key)
      );
      CREATE TABLE IF NOT EXISTS trigger_jobs (
        ledger TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        route_id TEXT,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        block_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ledger, kind, key)
      );`,
    postgres: `
      CREATE TABLE IF NOT EXISTS events (
        ledger TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        block_hash TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        contract TEXT NOT NULL,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        route_id TEXT,
        case_id TEXT,
        account_key TEXT,
        args TEXT NOT NULL,
        PRIMARY KEY (ledger, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS events_route ON events(route_id);
      CREATE INDEX IF NOT EXISTS events_case ON events(case_id);
      CREATE INDEX IF NOT EXISTS events_account ON events(account_key);
      CREATE INDEX IF NOT EXISTS events_block ON events(ledger, block_number);
      CREATE INDEX IF NOT EXISTS events_contract ON events(contract, ledger);
      CREATE TABLE IF NOT EXISTS cursors (
        ledger TEXT PRIMARY KEY,
        block_number BIGINT NOT NULL,
        block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        ledger TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        block_hash TEXT NOT NULL,
        PRIMARY KEY (ledger, block_number)
      );
      CREATE TABLE IF NOT EXISTS kv (
        ledger TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (ledger, key)
      );
      CREATE TABLE IF NOT EXISTS trigger_jobs (
        ledger TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        route_id TEXT,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        block_number BIGINT NOT NULL,
        payload TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (ledger, kind, key)
      );`,
  },
  {
    version: 2,
    name: "query-indexes",
    // Event-name scans (trigger restart, route listing) and job status filters.
    sqlite: `
      CREATE INDEX IF NOT EXISTS events_name ON events(name, ledger, block_number, log_index);
      CREATE INDEX IF NOT EXISTS events_route_sent ON events(timestamp, ledger, block_number, log_index) WHERE name = 'RouteSent';
      CREATE INDEX IF NOT EXISTS trigger_jobs_status ON trigger_jobs(status, ledger);`,
    postgres: `
      CREATE INDEX IF NOT EXISTS events_name ON events(name, ledger, block_number, log_index);
      CREATE INDEX IF NOT EXISTS events_route_sent ON events(timestamp, ledger, block_number, log_index) WHERE name = 'RouteSent';
      CREATE INDEX IF NOT EXISTS trigger_jobs_status ON trigger_jobs(status, ledger);`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export const MIGRATIONS_TABLE = {
  sqlite: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  postgres: `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)`,
};

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** Which migrations still need to run, given the versions already applied. */
export function pendingMigrations(applied: number[], all: readonly Migration[] = MIGRATIONS): Migration[] {
  const max = Math.max(0, ...applied);
  const latest = all[all.length - 1]?.version ?? 0;
  if (max > latest) {
    throw new MigrationError(`database schema is at version ${max}, newer than this build (${latest}); refusing to run an older build against it`);
  }
  const have = new Set(applied);
  return all.filter((m) => !have.has(m.version));
}
