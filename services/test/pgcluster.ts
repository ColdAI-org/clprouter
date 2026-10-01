// SPDX-License-Identifier: MIT
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway PostgreSQL for tests: `CLPROUTER_TEST_PG_URL` if set, else a private cluster (initdb + pg_ctl) in a
 * temp dir on a free port, removed afterwards. Undefined when neither is available (the PostgreSQL tests skip).
 */
export interface PgCluster {
  url: string;
  /** A fresh, empty database on the cluster. */
  database(name: string): Promise<string>;
  stop(): void;
}

const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function startPg(): Promise<PgCluster | undefined> {
  const pg = await import("pg");
  const fromEnv = process.env.CLPROUTER_TEST_PG_URL;
  const mk = (base: string, stop: () => void): PgCluster => ({
    url: base,
    async database(name) {
      const c = new pg.default.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name}`);
      await c.query(`CREATE DATABASE ${name}`);
      await c.end();
      const u = new URL(base);
      u.pathname = `/${name}`;
      return u.toString();
    },
    stop,
  });
  if (fromEnv) return mk(fromEnv, () => {});
  if (!has("initdb") || !has("pg_ctl")) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "clpr-pg-"));
  const port = await freePort();
  execFileSync("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  execFileSync("pg_ctl", ["-D", join(dir, "data"), "-l", join(dir, "log"), "-w", "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, "start"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  return mk(`postgres://postgres@127.0.0.1:${port}/postgres`, () => {
    spawnSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });
}
