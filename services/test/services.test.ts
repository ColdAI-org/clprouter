// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServicesConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { buildServices, type Services } from "../src/main.js";
import { FakeNode } from "./fakenode.js";
import { ADDR, R, rid } from "./helpers.js";

const L = "eip155:31337";
let node: FakeNode;
let svc: Services | undefined;

beforeEach(async () => {
  node = await new FakeNode().start();
});
afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await node.stop();
});

const config = (extra: Partial<ServicesConfig> = {}, ledger: object = {}): ServicesConfig => ({
  database: ":memory:",
  http: { host: "127.0.0.1", port: 0 },
  ledgers: [{ id: L, chainId: 31337, rpcUrls: [node.url], confirmations: 0, pollIntervalMs: 100, contracts: ADDR, rpc: { retries: 1, backoffMs: 1, timeoutMs: 1000 }, ...ledger }],
  readiness: { maxStalePolls: 3 },
  ...extra,
});
const quiet = createLogger({ write: () => {} });
const until = async (f: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("services lifecycle", () => {
  it("refuses to start when an RPC endpoint is on the wrong chain", async () => {
    await expect(buildServices(config({}, { chainId: 1 }), quiet)).rejects.toThrow(/wrong chain.*chain id 31337, expected 1/);
  });

  it("becomes ready after the first successful poll and exports indexer, reorg and pending-hop metrics", async () => {
    node.chain.mine([R.sent(rid(1))]);
    node.chain.mine([R.pending(rid(2), 1, "0xabcdef")]);
    svc = await buildServices(config(), quiet);
    expect((await svc.readiness()).ready).toBe(false);
    expect((await svc.readiness()).checks[`ledger:${L}`]?.detail).toBe("no successful poll yet");
    svc.start();
    await until(async () => (await svc!.readiness()).ready);
    // A reorg past the cursor.
    node.chain.reorg(2, [[], []], "fork");
    await until(() => svc!.indexer.watchers.get(L)!.cursor()?.blockNumber === 3);
    const m = (await svc.metrics.render()).body;
    expect(m).toMatch(new RegExp(`clprouter_indexer_head_block\\{ledger="${L}"\\} 3`));
    expect(m).toMatch(new RegExp(`clprouter_indexer_lag_blocks\\{ledger="${L}"\\} 0`));
    expect(m).toMatch(new RegExp(`clprouter_reorgs_total\\{ledger="${L}"\\} 1`));
    expect(m).toMatch(/clprouter_rpc_requests_total\{ledger="eip155:31337",endpoint="127\.0\.0\.1:\d+",outcome="ok"\}/);
    expect(m).toMatch(/clprouter_process_cpu_user_seconds_total/);
  });

  it("reports pending hops while they wait for the trigger", async () => {
    node.chain.mine([R.pending(rid(2), 1, "0xabcdef")]);
    svc = await buildServices(config(), quiet);
    svc.start();
    await until(() => svc!.store.jobs().length === 1);
    expect((await svc.metrics.render()).body).toMatch(new RegExp(`clprouter_pending_hops\\{ledger="${L}",kind="forward",status="pending"\\} 1`));
  });

  it("turns not-ready when the RPC stops answering, and ready again when it recovers", async () => {
    svc = await buildServices(config(), quiet);
    svc.start();
    await until(async () => (await svc!.readiness()).ready);
    node.failMethods.set("eth_blockNumber", { status: 503 });
    await until(async () => !(await svc!.readiness()).ready);
    expect((await svc.readiness()).checks[`ledger:${L}`]?.detail).toMatch(/last successful poll/);
    expect((await svc.metrics.render()).body).toMatch(new RegExp(`clprouter_indexer_poll_errors_total\\{ledger="${L}"\\} [1-9]`));
    node.failMethods.clear();
    await until(async () => (await svc!.readiness()).ready);
  });

  it("shuts down gracefully: not ready, streams told and closed, in-flight requests finish, store closed", async () => {
    svc = await buildServices(config(), quiet);
    svc.start();
    const port = await svc.listen();
    const base = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(`${base}/readyz`)).status === 200);
    const sse = await fetch(`${base}/stream`);
    const text = sse.text();
    const stopping = svc.stop();
    expect(await text).toContain("event: shutdown");
    await stopping;
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    expect(() => svc!.store.getCursor(L)).toThrow(); // closed
    await svc.stop(); // idempotent
    svc = undefined;
  });

  it("serves /metrics on a separate port when configured, not on the API", async () => {
    svc = await buildServices(config({ metrics: { port: 0 } }), quiet);
    const port = await svc.listen();
    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/openapi.json`)).status).toBe(200);
  });
});

describe("process entry point", () => {
  it("logs JSON, serves, and exits 0 on SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clpr-main-"));
    const cfgPath = join(dir, "c.json");
    writeFileSync(cfgPath, JSON.stringify({ ...config(), http: { host: "127.0.0.1", port: 0 } }));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", cfgPath], { cwd, env: { ...process.env, NODE_ENV: "production", CLPROUTER_LOG_LEVEL: "info" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    await until(() => out.includes('"msg":"api listening"'), 20_000);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(0);
    const lines = out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { msg: string; level: string });
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(["api listening", "shutdown requested", "stopped"]));
  }, 30_000);

  it("exits 2 with a clear message on a bad config", async () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd, env: { ...process.env, CLPROUTER_SERVICES_CONFIG_JSON: '{"ledgers":[]}', CLPROUTER_SERVICES_CONFIG: "" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(2);
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ level: "error", msg: "startup failed", err: expect.stringMatching(/ledgers/) });
  }, 30_000);
});
