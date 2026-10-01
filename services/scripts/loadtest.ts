// SPDX-License-Identifier: MIT
/**
 * Load test for GET /routes/:routeId, GET /routes and POST /quote (autocannon).
 *
 *   pnpm loadtest                         # self-contained: fake chain with seeded routes + the services in a child process
 *   pnpm loadtest -- --url http://host:8787 --route 0x…   # against a running instance
 *
 * Options: --duration <s> (default 15), --connections <n> (default 50), --routes <n> seeded (default 2000),
 * --out <file> (default loadtest/results.json). Rate limiting is disabled in the self-contained run (it would
 * answer most requests with 429); everything else runs with production defaults.
 */
import autocannon from "autocannon";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FakeNode } from "../test/fakenode.js";
import { ADDR, R, rid } from "../test/helpers.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    route: { type: "string" },
    duration: { type: "string", default: "15" },
    connections: { type: "string", default: "50" },
    routes: { type: "string", default: "2000" },
    out: { type: "string", default: fileURLToPath(new URL("../loadtest/results.json", import.meta.url)) },
  },
});
const duration = Number(args.duration);
const connections = Number(args.connections);
const seeded = Number(args.routes);
const LEDGER = "eip155:31337";

async function waitFor(f: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (!(await f().catch(() => false))) {
    if (Date.now() > end) throw new Error("timed out waiting for the services");
    await new Promise((r) => setTimeout(r, 200));
  }
}

let child: ChildProcess | undefined;
let node: FakeNode | undefined;
let base = args.url ?? "";
let routeIds: string[] = args.route ? [args.route] : [];

if (!args.url) {
  node = await new FakeNode().start();
  for (let b = 0; b < seeded / 10; b++) node.chain.mine(Array.from({ length: 10 }, (_, i) => R.sent(rid(b * 10 + i + 1))));
  routeIds = Array.from({ length: seeded }, (_, i) => rid(i + 1));
  const dir = mkdtempSync(join(tmpdir(), "clpr-load-"));
  const cfg = {
    database: join(dir, "load.sqlite"),
    http: { host: "127.0.0.1", port: 0, rateLimit: { enabled: false } },
    log: { level: "warn" },
    ledgers: [{ id: LEDGER, chainId: 31337, rpcUrls: [node.url], confirmations: 0, pollIntervalMs: 1000, contracts: ADDR }],
  };
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", cfgPath], { cwd, env: { ...process.env, CLPROUTER_LOG_LEVEL: "info", NODE_ENV: "production", CLPROUTER_STRICT: "0" } });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  await waitFor(async () => /"msg":"api listening".*"port":(\d+)/.test(out), 30_000);
  base = `http://127.0.0.1:${/"msg":"api listening".*"port":(\d+)/.exec(out)![1]}`;
  await waitFor(async () => (await fetch(`${base}/readyz`)).ok, 60_000);
  await waitFor(async () => (await fetch(`${base}/routes/${routeIds.at(-1)}`)).status === 200, 60_000);
}

const quoteBodies = [
  { origin: "eip155:1", destination: "hedera:mainnet", mode: "fastest" },
  { origin: "eip155:1", destination: "hedera:mainnet", mode: "cheapest" },
  { origin: "eip155:1", destination: "hedera:mainnet", mode: "balanced", filters: { mica: true } },
].map((b) => JSON.stringify(b));

interface Scenario {
  name: string;
  requests: autocannon.Request[];
}
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const scenarios: Scenario[] = [
  { name: "GET /routes/:routeId", requests: [{ method: "GET", setupRequest: (r) => ({ ...r, path: `/routes/${pick(routeIds)}` }) }] },
  { name: "GET /routes?limit=50", requests: [{ method: "GET", path: "/routes?limit=50" }] },
  {
    name: "POST /quote",
    requests: [{ method: "POST", headers: { "content-type": "application/json" }, setupRequest: (r) => ({ ...r, path: "/quote", body: pick(quoteBodies) }) }],
  },
  {
    // A distinct evaluation time per request defeats the live-graph memo: the worst case.
    name: "POST /quote (uncached)",
    requests: [
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        setupRequest: (r) => ({ ...r, path: "/quote", body: JSON.stringify({ origin: "eip155:1", destination: "hedera:mainnet", mode: "fastest", now: 1_800_000_000 + Math.floor(Math.random() * 1e9) }) }),
      },
    ],
  },
];

const results: Record<string, unknown>[] = [];
for (const s of scenarios) {
  const r = await autocannon({ url: base, connections, duration, requests: s.requests });
  const row = {
    scenario: s.name,
    requests: r.requests.total,
    rps: Math.round(r.requests.average),
    latencyMs: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max },
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
  };
  results.push(row);
  console.log(`${s.name.padEnd(26)} ${String(row.rps).padStart(7)} req/s   p50 ${row.latencyMs.p50} ms   p99 ${row.latencyMs.p99} ms   non-2xx ${row.non2xx}   errors ${row.errors}`);
}

const report = {
  date: new Date().toISOString(),
  target: args.url ? "external" : `self-contained (SQLite, ${seeded} routes indexed, rate limiting off)`,
  connections,
  durationS: duration,
  machine: { cpus: cpus().length, cpu: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
  results,
};
mkdirSync(dirname(args.out!), { recursive: true });
writeFileSync(args.out!, JSON.stringify(report, null, 2) + "\n");
console.log(`results written to ${args.out}`);

child?.kill("SIGTERM");
await node?.stop();
