#!/usr/bin/env node
/**
 * Checks the package as a consumer gets it from npm or a packed tarball:
 *
 *   1. builds dist/ and runs `pnpm pack`;
 *   2. checks the tarball holds what `exports` points at, and no sources or tests;
 *   3. installs the tarball into a throwaway consumer project;
 *   4. imports `@clprouter/sdk`, `@clprouter/sdk/iso20022` and `@clprouter/sdk/data/edges.json` from that project
 *      with plain Node, plans a route on the sample graph and on the shipped route data;
 *   5. type-checks a TypeScript consumer against the published `.d.ts` files (moduleResolution NodeNext).
 *
 *   pnpm run test:pack            (KEEP_PACK_DIR=1 keeps the temp directory for inspection)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "clprouter-sdk-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ok = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg) => {
  console.error(`  FAIL ${msg}`);
  process.exitCode = 1;
};

try {
  console.log(`check-pack: ${pkg.name}@${pkg.version}`);

  // 1. Build and pack.
  run("pnpm", ["run", "build"], SDK);
  const packOut = run("pnpm", ["pack", "--pack-destination", work], SDK).trim().split("\n");
  const tarball = packOut.map((l) => l.trim()).find((l) => l.endsWith(".tgz"));
  if (!tarball) throw new Error(`pnpm pack printed no tarball:\n${packOut.join("\n")}`);
  const tgz = tarball.startsWith("/") ? tarball : join(work, tarball.split("/").pop());
  ok(`packed ${tgz.split("/").pop()}`);

  // 2. Tarball contents.
  const files = run("tar", ["-tzf", tgz], work)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ""));
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/iso20022/index.js",
    "dist/iso20022/index.d.ts",
    "dist/data/sample-graph.json",
    "data/edges.json",
    "data/chains.json",
  ];
  for (const f of required) if (!files.includes(f)) fail(`tarball is missing ${f}`);
  const stray = files.filter((f) => /^(src|test|scripts)\//.test(f) || f.endsWith(".tsbuildinfo") || f.startsWith("node_modules/"));
  if (stray.length) fail(`tarball ships files it should not: ${stray.slice(0, 5).join(", ")}`);
  if (!process.exitCode) ok(`tarball has ${files.length} files, all export targets present, no sources or tests`);

  // 3. Throwaway consumer project.
  const app = join(work, "consumer");
  run("mkdir", ["-p", app], work);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: { [pkg.name]: `file:${tgz}` } }, null, 2),
  );
  run("pnpm", ["install", "--prefer-offline", "--ignore-workspace", "--config.confirmModulesPurge=false"], app);
  ok("installed the tarball into a fresh consumer project");

  // 4. Runtime imports through the exports map.
  writeFileSync(
    join(app, "smoke.mjs"),
    `
import { createRequire } from "node:module";
import { plan, sampleGraph, StaticJsonSource, encodeEnvelope } from "@clprouter/sdk";
import * as iso from "@clprouter/sdk/iso20022";
import edges from "@clprouter/sdk/data/edges.json" with { type: "json" };

const require = createRequire(import.meta.url);
const r = plan(sampleGraph(), { origin: "stellar:pubnet", destination: "hedera:mainnet", mode: "fastest" });
if (!r.ok) throw new Error("sample plan failed: " + r.reason);
if (typeof encodeEnvelope !== "function") throw new Error("encodeEnvelope missing");
if (!iso.isUetr(iso.generateUetr())) throw new Error("iso20022 entry point broken");
const g = await new StaticJsonSource({ file: require.resolve("@clprouter/sdk/data/edges.json") }).load();
const version = require("@clprouter/sdk/package.json").version;
console.log(JSON.stringify({ hops: r.route.ledgers.length, edgesFileLedgers: Object.keys(edges.ledgers ?? {}).length, graphLoaded: !!g, version }));
`,
  );
  const smoke = JSON.parse(run("node", ["smoke.mjs"], app).trim());
  ok(`node imports @clprouter/sdk, /iso20022, /data/edges.json, /package.json (v${smoke.version}); sample route has ${smoke.hops} ledgers`);

  // 5. Types as a TypeScript consumer sees them.
  writeFileSync(
    join(app, "consumer.ts"),
    `
import { plan, sampleGraph, type PlanResult } from "@clprouter/sdk";
import { generateUetr, isUetr } from "@clprouter/sdk/iso20022";
const r: PlanResult = plan(sampleGraph(), { origin: "stellar:pubnet", destination: "hedera:mainnet", mode: "cheapest" });
const u: string = generateUetr();
export const out: [boolean, boolean] = [r.ok, isUetr(u)];
`,
  );
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: [] },
      files: ["consumer.ts"],
    }),
  );
  run(join(SDK, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], app);
  ok("tsc (NodeNext) type-checks a consumer against the published .d.ts files");
} catch (e) {
  fail(e.stderr?.toString() || e.stdout?.toString() || e.message);
} finally {
  if (process.env.KEEP_PACK_DIR) console.log(`  kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
console.log(process.exitCode ? "check-pack: FAILED" : "check-pack: passed");
