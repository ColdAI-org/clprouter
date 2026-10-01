// SPDX-License-Identifier: MIT
import { StaticJsonSource, sampleGraph } from "@clprouter/sdk";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type ApiOptions, type ApiServer } from "../src/api.js";
import { RateLimiter, Semaphore, corsHeaders } from "../src/http.js";
import { EventBus } from "../src/indexer.js";
import { createLogger } from "../src/log.js";
import { Metrics } from "../src/metrics.js";
import { QuoteService } from "../src/quote.js";
import { Store } from "../src/store.js";
import { ForwardTrigger } from "../src/trigger.js";
import { ADDR, R, ev, h32, rid } from "./helpers.js";

const L = "eip155:31001";
const servers: ApiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function start(extra: Partial<ApiOptions> = {}, store = new Store()) {
  const bus = new EventBus();
  const cursors = () => ({ [L]: store.getCursor(L) ?? null });
  const quote = new QuoteService({ base: new StaticJsonSource(sampleGraph()), store, ledgers: [{ id: L, confirmations: 0, contracts: ADDR }], cursors });
  const trigger = new ForwardTrigger({ store, bus, routers: { [L]: ADDR.router } });
  const lines: Record<string, unknown>[] = [];
  const server = createApi({
    store,
    bus,
    ledgers: [{ id: L, router: ADDR.router }],
    cursors,
    quote,
    trigger,
    logger: createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
    ...extra,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, lines, trigger };
}

const quoteBody = { origin: "eip155:1", destination: "hedera:mainnet", mode: "fastest" };
const post = (base: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`${base}/quote`, { method: "POST", headers, body });

describe("API hardening", () => {
  it("rejects bodies over the limit with 413, by header and by streamed size", async () => {
    const { base } = await start({ http: { bodyLimitBytes: 256 } });
    const big = JSON.stringify({ ...quoteBody, pad: "x".repeat(1000) });
    expect((await post(base, big)).status).toBe(413);
    // Chunked upload without content-length still stops at the limit.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const r = await fetch(`${base}/quote`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("validates quote input strictly: unknown keys, types and ranges are 400 with the field path", async () => {
    const { base } = await start();
    const cases: [object, RegExp][] = [
      [{ ...quoteBody, extra: 1 }, /Unrecognized key/],
      [{ ...quoteBody, k: 1000 }, /k:/],
      [{ ...quoteBody, constraints: { maxHops: 0 } }, /constraints\.maxHops/],
      [{ ...quoteBody, origin: "not caip" }, /origin: must be a CAIP-2 id/],
      [{ ...quoteBody, filters: { energy: { capKgPerTx: -1 } } }, /filters\.energy/],
      [{ ...quoteBody, constraints: { excludedJurisdictions: ["usa"] } }, /alpha-2/],
      [[], /JSON object/],
    ];
    for (const [body, msg] of cases) {
      const r = await post(base, JSON.stringify(body));
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(msg);
    }
    expect((await post(base, JSON.stringify(quoteBody))).status).toBe(200);
  });

  it("validates path and query parameters", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/accounts/nope/notices`)).status).toBe(400);
    expect((await fetch(`${base}/routes/%E0%A4%A`)).status).toBe(400); // malformed percent-encoding
    expect((await fetch(`${base}/graphs/xyz`)).status).toBe(400);
    expect((await fetch(`${base}/registry?ledger=${encodeURIComponent("bad ledger")}`)).status).toBe(400);
    expect((await fetch(`${base}/routes?limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/routes?limit=100000`)).status).toBe(400);
    expect((await fetch(`${base}/routes?cursor=!!`)).status).toBe(400);
    expect((await fetch(`${base}/routes?sender=0x12`)).status).toBe(400);
    expect((await fetch(`${base}/stream?names=${encodeURIComponent("a b")}`)).status).toBe(400);
    expect((await fetch(`${base}/stream?ledger=eip155:9`)).status).toBe(400);
    expect((await fetch(`${base}/quote`)).status).toBe(405);
    expect((await fetch(`${base}/x${"a".repeat(5000)}`)).status).toBe(414);
  });

  it("rate limits per client with Retry-After, charges quotes more, and never limits probes", async () => {
    const { base } = await start({ http: { rateLimit: { enabled: true, requestsPerMinute: 60, burst: 6, quoteCost: 5 } } });
    expect((await post(base, JSON.stringify(quoteBody))).status).toBe(200); // 5 tokens
    expect((await fetch(`${base}/registry`)).status).toBe(200); // 1 token
    const r = await fetch(`${base}/registry`);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it("takes the client address from X-Forwarded-For only when trustProxy is on", async () => {
    const { base } = await start({ http: { trustProxy: true, rateLimit: { enabled: true, requestsPerMinute: 60, burst: 1, quoteCost: 1 } } });
    const as = (ip: string) => fetch(`${base}/registry`, { headers: { "x-forwarded-for": `9.9.9.9, ${ip}` } });
    expect((await as("1.1.1.1")).status).toBe(200);
    expect((await as("1.1.1.1")).status).toBe(429);
    expect((await as("2.2.2.2")).status).toBe(200);
  });

  it("applies the CORS allowlist to responses and preflights", async () => {
    const { base } = await start({ http: { cors: { origins: ["https://app.example"], maxAgeS: 60 } } });
    const ok = await fetch(`${base}/registry`, { headers: { origin: "https://app.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("vary")).toBe("Origin");
    const no = await fetch(`${base}/registry`, { headers: { origin: "https://evil.example" } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(`${base}/quote`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect((await fetch(`${base}/quote`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(corsHeaders(["*"], undefined, 1, false)).toMatchObject({ "access-control-allow-origin": "*" });
  });

  it("never leaks internals: 500s carry only a request id, the error goes to the log", async () => {
    const store = new Store();
    store.routesPage = () => {
      throw new Error("SQLITE_CORRUPT at /secret/path/db.sqlite");
    };
    const { base, lines } = await start({}, store);
    const r = await fetch(`${base}/routes`, { headers: { "x-request-id": "req-123" } });
    expect(r.status).toBe(500);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "internal error", requestId: "req-123" });
    expect(JSON.stringify(body)).not.toMatch(/secret|SQLITE|at /);
    expect(r.headers.get("x-request-id")).toBe("req-123");
    expect(lines.some((l) => l.msg === "unhandled error" && JSON.stringify(l).includes("SQLITE_CORRUPT"))).toBe(true);
  });

  it("sets security headers and generates request ids", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/registry`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("paginates /routes and /pending with opaque cursors", async () => {
    const store = new Store();
    store.applyRange(L, Array.from({ length: 5 }, (_, i) => ev(L, R.sent(rid(i + 1)), { block: i + 1 })), { blockNumber: 5, blockHash: h32("b5") }, []);
    for (let i = 0; i < 5; i++) store.addJob({ ledger: L, kind: "forward", key: `k${i}`, routeId: rid(i + 1), blockNumber: i, payload: { envelope: "0x01" } });
    const { base } = await start({}, store);
    const p1 = (await (await fetch(`${base}/routes?limit=2`)).json()) as { items: { routeId: string }[]; next: string };
    expect(p1.items.map((x) => x.routeId)).toEqual([rid(5), rid(4)]);
    const p2 = (await (await fetch(`${base}/routes?limit=2&cursor=${p1.next}`)).json()) as { items: { routeId: string }[]; next: string };
    expect(p2.items.map((x) => x.routeId)).toEqual([rid(3), rid(2)]);
    const j1 = (await (await fetch(`${base}/pending?limit=3`)).json()) as { jobs: unknown[]; next: string; total: number };
    expect(j1).toMatchObject({ total: 5 });
    expect(j1.jobs).toHaveLength(3);
    const j2 = (await (await fetch(`${base}/pending?limit=3&cursor=${j1.next}`)).json()) as { jobs: unknown[]; next: string | null };
    expect(j2.jobs).toHaveLength(2);
    expect(j2.next).toBeNull();
  });

  it("caps concurrent quotes (503 + Retry-After) and SSE streams per client", async () => {
    const { base, server } = await start({ http: { maxConcurrentQuotes: 1, sse: { maxClients: 10, maxPerClient: 1, heartbeatMs: 60_000 } } });
    // Hold the single quote slot open with a request whose body never finishes.
    const ctrl = new AbortController();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const slow = fetch(`${base}/quote`, { method: "POST", body: new ReadableStream({ start: (c) => void (push = c) }), duplex: "half", signal: ctrl.signal } as RequestInit).catch(() => undefined);
    push.enqueue(new TextEncoder().encode("{"));
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(base, JSON.stringify(quoteBody));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    ctrl.abort();
    await slow;

    const s1 = new AbortController();
    const first = await fetch(`${base}/stream`, { signal: s1.signal });
    expect(first.status).toBe(200);
    expect((await fetch(`${base}/stream`)).status).toBe(429);
    expect(server.sseClientCount()).toBe(1);
    server.drain();
    const text = await first.text();
    expect(text).toContain("event: shutdown");
    expect((await fetch(`${base}/stream`)).status).toBe(503);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("records request, error and quote metrics and serves /metrics", async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    const { base } = await start({ metrics });
    await post(base, JSON.stringify(quoteBody));
    await post(base, "{");
    await fetch(`${base}/nowhere`);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/clprouter_http_requests_total\{route="\/quote",method="POST",status="200"\} 1/);
    expect(text).toMatch(/clprouter_api_errors_total\{route="\/quote",kind="bad_request"\} 1/);
    expect(text).toMatch(/clprouter_api_errors_total\{route="unmatched",kind="not_found"\} 1/);
    expect(text).toMatch(/clprouter_quote_duration_seconds_count\{outcome="ok"\} 1/);
  });

  it("serves the OpenAPI document when given", async () => {
    const { base } = await start({ openapi: { openapi: "3.1.0" } });
    expect(await (await fetch(`${base}/openapi.json`)).json()).toEqual({ openapi: "3.1.0" });
  });
});

describe("rate limiter and semaphore", () => {
  it("refills continuously and bounds memory", () => {
    let t = 0;
    const rl = new RateLimiter({ requestsPerMinute: 60, burst: 2, maxKeys: 3 }, () => t);
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBe(1000);
    t += 1000;
    expect(rl.take("a")).toBe(0);
    for (const k of ["b", "c", "d", "e"]) rl.take(k);
    t += 1;
    rl.take("f");
    expect(rl.size).toBeLessThanOrEqual(4);
  });

  it("semaphore fails fast and releases once", () => {
    const s = new Semaphore(1);
    const r = s.tryAcquire()!;
    expect(s.tryAcquire()).toBeUndefined();
    r();
    r();
    expect(s.inUse).toBe(0);
  });
});
