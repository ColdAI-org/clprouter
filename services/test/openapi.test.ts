// SPDX-License-Identifier: MIT
import { StaticJsonSource, sampleGraph } from "@clprouter/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type ApiServer } from "../src/api.js";
import { EventBus, Indexer, LedgerWatcher } from "../src/indexer.js";
import { QuoteService } from "../src/quote.js";
import { keys } from "../src/registry.js";
import { Store } from "../src/store.js";
import { ForwardTrigger } from "../src/trigger.js";
import { ADDR, G, MockChain, R, V, h32, rid } from "./helpers.js";

type Spec = { openapi: string; paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: object }> } | { $ref: string }> }>>; components: { schemas: Record<string, object>; responses: Record<string, { content?: Record<string, { schema: object }> }> } };
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const apiSource = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");

const L = "eip155:31001";
const ROUTE = rid(0x77);
const CASE = h32("case-oas");
const RECIPIENT = "eip155:31003:0xc0ffee0000000000000000000000000000000003";
let base = "";
let server: ApiServer;

beforeAll(async () => {
  const chain = new MockChain();
  const store = new Store();
  const bus = new EventBus();
  const indexer = new Indexer(store, bus);
  const cfg = { id: L, confirmations: 0, contracts: ADDR };
  indexer.add(new LedgerWatcher(cfg, chain, store, bus));
  chain.mine([G.applied(1, 5), G.listed(keys.account(RECIPIENT), RECIPIENT, CASE, 4_000_000_000)]);
  chain.mine([R.sent(ROUTE, { messageId: 0n }), R.notice(ROUTE, RECIPIENT, keys.account(RECIPIENT), CASE), V.deposited(1, ROUTE, CASE, 99n), R.settled(ROUTE, 5, 9, 0, CASE)]);
  chain.mine([R.pending(rid(0x88), 1, "0xabcdef")]);
  await indexer.pollAll();
  const quote = new QuoteService({ base: new StaticJsonSource(sampleGraph()), store, ledgers: [cfg], cursors: () => indexer.cursors() });
  const trigger = new ForwardTrigger({ store, bus, routers: { [L]: ADDR.router } });
  trigger.start();
  server = createApi({ store, bus, ledgers: [{ id: L, router: ADDR.router }], cursors: () => indexer.cursors(), quote, trigger, openapi: spec, readiness: async () => ({ ready: true, checks: {} }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const ajv = new Ajv2020({ strict: false, allErrors: true });
/** Resolve `#/components/...` refs by inlining the component schemas under a root that holds them. */
function validator(schema: object) {
  return ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", components: { schemas: spec.components.schemas }, ...schema });
}
function responseSchema(path: string, method: string, status: number): object | undefined {
  let r = spec.paths[path]?.[method]?.responses[String(status)];
  if (r && "$ref" in r) r = spec.components.responses[r.$ref.split("/").pop()!];
  return (r as { content?: Record<string, { schema: object }> } | undefined)?.content?.["application/json"]?.schema;
}

async function check(path: string, method: string, url: string, init?: RequestInit) {
  const res = await fetch(base + url, init);
  const schema = responseSchema(path, method, res.status);
  expect(schema, `${method.toUpperCase()} ${path} ${res.status} is documented`).toBeDefined();
  const body = (await res.json()) as unknown;
  const v = validator(schema!);
  expect(v(body), `${method.toUpperCase()} ${url}: ${ajv.errorsText(v.errors)}`).toBe(true);
  return { status: res.status, body };
}

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 and its schemas compile", () => {
    expect(spec.openapi).toBe("3.1.0");
    for (const s of Object.values(spec.components.schemas)) expect(() => validator(s)).not.toThrow();
    // The validator does reject non-conforming bodies.
    expect(validator({ $ref: "#/components/schemas/InternalError" })({ error: "internal error", requestId: "r", stack: "x" })).toBe(false);
    expect(validator({ $ref: "#/components/schemas/RouteStatus" })({ routeId: "0x" })).toBe(false);
  });

  it("documents every route the server implements", () => {
    const implemented = [...apiSource.matchAll(/ctx\.route = "(\/[^"]*)"/g)].map((m) => m[1]!.replace(/:([A-Za-z0-9]+)/g, "{$1}"));
    expect(implemented.length).toBeGreaterThan(10);
    for (const r of implemented) expect(Object.keys(spec.paths), r).toContain(r);
  });

  it("live responses match the documented schemas", async () => {
    await check("/routes", "get", "/routes?limit=1");
    await check("/routes/{routeId}", "get", `/routes/${ROUTE}`);
    await check("/routes/{routeId}", "get", `/routes/${rid(1)}`); // 404 body
    await check("/routes/{routeId}", "get", "/routes/nope"); // 400
    await check("/accounts/{caip10}/notices", "get", `/accounts/${encodeURIComponent(RECIPIENT)}/notices`);
    await check("/registry", "get", "/registry");
    await check("/registry", "get", "/registry?ledger=eip155:9");
    const q = await check("/quote", "post", "/quote", { method: "POST", body: JSON.stringify({ origin: "eip155:1", destination: "hedera:mainnet" }) });
    await check("/quote", "post", "/quote", { method: "POST", body: JSON.stringify({ origin: "eip155:1", destination: "hedera:mainnet", bogus: 1 }) });
    await check("/graphs/{hash}", "get", `/graphs/${(q.body as { inputs: { graph: { hash: string } } }).inputs.graph.hash}`);
    await check("/pending", "get", "/pending");
    await check("/health", "get", "/health");
    await check("/healthz", "get", "/healthz");
    await check("/readyz", "get", "/readyz");
  });
});
