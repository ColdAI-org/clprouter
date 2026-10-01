import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Hex } from "viem";
import type { ResolvedConfig } from "./config.js";
import { CAIP2 } from "./config.js";
import type { IndexedEvent } from "./events.js";
import { clientIp, corsHeaders, decodeCursor, encodeCursor, RateLimiter, Semaphore } from "./http.js";
import type { EventBus, ReorgInfo } from "./indexer.js";
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import type { Metrics } from "./metrics.js";
import { accountNotices, parseCaip10 } from "./notices.js";
import type { QuoteRequestBody, QuoteService } from "./quote.js";
import { BadRequest } from "./quote.js";
import { loadRegistry, registryView, subjectIndex } from "./registry.js";
import { loadRouteStatus } from "./status.js";
import type { Cursor, PageKey, Store } from "./store.js";
import type { ForwardTrigger } from "./trigger.js";

export type HttpOptions = ResolvedConfig["http"];

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface ApiOptions {
  store: Store;
  bus: EventBus;
  ledgers: { id: string; router?: Hex }[];
  cursors: () => Record<string, Cursor | null>;
  quote?: QuoteService;
  trigger?: ForwardTrigger;
  registryLedger?: string;
  /** Known edges and Router versions, so disabled subjects resolve to readable targets. */
  subjects?: Parameters<typeof subjectIndex>[0];
  clock?: () => number;
  /** SSE heartbeat, ms. Default 15000 (or `http.sse.heartbeatMs`). */
  heartbeatMs?: number;
  /** Limits, CORS, rate limiting, pagination. Defaults as in `resolveConfig`. */
  http?: Partial<HttpOptions>;
  logger?: Logger;
  metrics?: Metrics;
  /** Serve `/metrics` on this server (otherwise a separate metrics listener does). Default true when metrics are set. */
  metricsOnApi?: boolean;
  /** Readiness checks for `/readyz` (default: always ready). */
  readiness?: () => Promise<ReadinessReport>;
  /** OpenAPI document served at `/openapi.json`. */
  openapi?: unknown;
}

export interface ApiServer extends Server {
  /** Stop accepting new SSE streams and close the open ones (graceful shutdown). */
  drain(): void;
  sseClientCount(): number;
}

const ROUTE_ID = /^0x[0-9a-fA-F]{32}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_NAME = /^[A-Za-z]{1,64}$/;

/** Accepts a 16-byte hex route id or the same bytes in UUID form (route ids are Router-derived, not UETRs). */
export function parseRouteId(s: string): Hex | undefined {
  if (ROUTE_ID.test(s)) return s.toLowerCase() as Hex;
  if (UUID.test(s)) return `0x${s.replace(/-/g, "").toLowerCase()}` as Hex;
  return undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const DEFAULT_HTTP: HttpOptions = {
  host: "127.0.0.1",
  port: 8787,
  bodyLimitBytes: 64 * 1024,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  trustProxy: false,
  cors: { origins: ["*"], maxAgeS: 600 },
  rateLimit: { enabled: true, requestsPerMinute: 600, burst: 120, quoteCost: 5 },
  maxConcurrentQuotes: 32,
  sse: { maxClients: 1000, maxPerClient: 16, heartbeatMs: 15_000 },
  pagination: { defaultLimit: 50, maxLimit: 500 },
};

/** Paths exempt from rate limiting (probes and scrapes). */
const OPS_PATHS = new Set(["/healthz", "/readyz", "/metrics", "/health"]);

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `body larger than ${limit} bytes`, "too_large");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`, "too_large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

function isPageKey(v: unknown): v is PageKey {
  const k = v as PageKey;
  return (
    !!k &&
    typeof k === "object" &&
    Number.isSafeInteger(k.timestamp) &&
    typeof k.ledger === "string" &&
    k.ledger.length <= 64 &&
    Number.isSafeInteger(k.blockNumber) &&
    Number.isSafeInteger(k.logIndex)
  );
}

function isOffset(v: unknown): v is { o: number } {
  return !!v && typeof v === "object" && Number.isSafeInteger((v as { o: number }).o) && (v as { o: number }).o >= 0;
}

/**
 * Route status API (JSON over HTTP). The full contract is in `openapi.json`.
 *
 *   GET  /routes                     routes sent, newest first (paginated; ?ledger=&sender=&limit=&cursor=)
 *   GET  /routes/:routeId            hop-by-hop status, tx hashes per ledger, final outcome
 *   GET  /accounts/:caip10/notices   quarantine notices, sender receipts and listings for an account
 *   GET  /registry[?ledger=]         certifications, disabled routes, blacklist with case ids, committee, vault
 *   GET  /stream[?routeId=&ledger=&names=]   server-sent events (indexed events, route updates, reorgs)
 *   POST /quote                      planner quote over the live graph, with its inputs
 *   GET  /graphs/:hash               graph snapshot a quote was computed on
 *   GET  /pending                    hops waiting for the public forward / flush trigger, with calldata (paginated)
 *   GET  /health                     confirmed block per ledger
 *   GET  /healthz, /readyz           liveness and readiness probes
 *   GET  /metrics                    Prometheus metrics (when not on a separate port)
 *   GET  /openapi.json               this API's OpenAPI document
 */
export function createApi(o: ApiOptions): ApiServer {
  const h: HttpOptions = {
    ...DEFAULT_HTTP,
    ...(o.http ?? {}),
    cors: { ...DEFAULT_HTTP.cors, ...(o.http?.cors ?? {}) },
    rateLimit: { ...DEFAULT_HTTP.rateLimit, ...(o.http?.rateLimit ?? {}) },
    sse: { ...DEFAULT_HTTP.sse, ...(o.http?.sse ?? {}), ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}) },
    pagination: { ...DEFAULT_HTTP.pagination, ...(o.http?.pagination ?? {}) },
  };
  const log = o.logger ?? silentLogger;
  const now = () => (o.clock ? o.clock() : Math.floor(Date.now() / 1000));
  const subjects = subjectIndex(o.subjects ?? { ledgers: o.ledgers });
  const resolve = (s: Hex) => subjects.get(s.toLowerCase());
  const sseClients = new Map<ServerResponse, string>();
  const limiter = h.rateLimit.enabled ? new RateLimiter(h.rateLimit) : undefined;
  const quoteSlots = new Semaphore(h.maxConcurrentQuotes);
  const knownLedgers = new Set(o.ledgers.map((l) => l.id));
  let draining = false;

  const server = createServer((req, res) => {
    const started = performance.now();
    const reqId = typeof req.headers["x-request-id"] === "string" && REQUEST_ID.test(req.headers["x-request-id"]) ? req.headers["x-request-id"] : randomUUID();
    const ip = clientIp(req, h.trustProxy);
    const ctx: Ctx = { reqId, ip, route: "unmatched", method: req.method ?? "GET" };
    res.setHeader("x-request-id", reqId);
    res.on("finish", () => {
      const s = (performance.now() - started) / 1000;
      o.metrics?.httpRequests.inc({ route: ctx.route, method: ctx.method, status: String(res.statusCode) });
      if (ctx.route !== "/stream") o.metrics?.httpDuration.observe({ route: ctx.route, method: ctx.method }, s);
      if (res.statusCode >= 500) log.warn("request failed", { reqId, route: ctx.route, method: ctx.method, status: res.statusCode, ms: Math.round(s * 1000) });
      else log.debug("request", { reqId, route: ctx.route, method: ctx.method, status: res.statusCode, ms: Math.round(s * 1000) });
    });
    handle(req, res, ctx).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      let status = 500;
      let kind = "internal";
      let message = "internal error";
      let headers: Record<string, string> = {};
      if (err instanceof HttpError) ({ status, kind, message, headers } = err);
      else if (err instanceof BadRequest) [status, kind, message] = [400, "bad_request", err.message];
      else if (err instanceof URIError) [status, kind, message] = [400, "bad_request", "malformed percent-encoding in the path"];
      else log.error("unhandled error", { reqId, route: ctx.route, err });
      o.metrics?.apiErrors.inc({ route: ctx.route, kind });
      // Never a stack trace or an internal message: 5xx bodies carry only the request id to correlate with logs.
      send(req, res, status, status >= 500 ? { error: message, requestId: reqId } : { error: message }, headers);
    });
  }) as ApiServer;

  server.requestTimeout = h.requestTimeoutMs;
  server.headersTimeout = Math.min(h.headersTimeoutMs, h.requestTimeoutMs);
  server.keepAliveTimeout = h.keepAliveTimeoutMs;
  server.maxHeadersCount = 64;

  interface Ctx {
    reqId: string;
    ip: string;
    route: string;
    method: string;
  }

  function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const cors = corsHeaders(h.cors.origins, req.headers.origin, h.cors.maxAgeS, false) ?? {};
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      ...cors,
      ...extra,
    });
    res.end(json);
  }

  function limitParam(url: URL): number {
    const raw = url.searchParams.get("limit");
    if (raw === null) return h.pagination.defaultLimit;
    if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1 || Number(raw) > h.pagination.maxLimit) {
      throw new BadRequest(`limit must be an integer from 1 to ${h.pagination.maxLimit}`);
    }
    return Number(raw);
  }

  function ledgerParam(url: URL): string | undefined {
    const l = url.searchParams.get("ledger");
    if (l === null) return undefined;
    if (!CAIP2.test(l)) throw new BadRequest("ledger must be a CAIP-2 id");
    return l;
  }

  function rateLimit(ctx: Ctx, cost: number): void {
    if (!limiter) return;
    const wait = limiter.take(ctx.ip, cost);
    if (wait > 0) {
      const s = Math.max(1, Math.ceil(wait / 1000));
      throw new HttpError(429, "rate limit exceeded", "rate_limited", { "retry-after": String(s) });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
    const rawUrl = req.url ?? "/";
    if (rawUrl.length > 4096) throw new HttpError(414, "URI too long", "bad_request");
    const url = new URL(rawUrl, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = ctx.method;

    if (method === "OPTIONS") {
      ctx.route = "preflight";
      const cors = corsHeaders(h.cors.origins, req.headers.origin, h.cors.maxAgeS, true);
      res.writeHead(cors ? 204 : 403, cors ?? {});
      res.end();
      return;
    }

    if (!OPS_PATHS.has(url.pathname)) rateLimit(ctx, method === "POST" && url.pathname === "/quote" ? h.rateLimit.quoteCost : 1);

    // ── Probes and ops ──
    if (url.pathname === "/healthz" && method === "GET") {
      ctx.route = "/healthz";
      return send(req, res, 200, { status: "ok" });
    }
    if (url.pathname === "/readyz" && method === "GET") {
      ctx.route = "/readyz";
      const r: ReadinessReport = draining
        ? { ready: false, checks: { shutdown: { ok: false, detail: "shutting down" } } }
        : o.readiness
          ? await o.readiness()
          : { ready: true, checks: {} };
      return send(req, res, r.ready ? 200 : 503, r);
    }
    if (url.pathname === "/metrics" && method === "GET" && o.metrics && o.metricsOnApi !== false) {
      ctx.route = "/metrics";
      const m = await o.metrics.render();
      res.writeHead(200, { "content-type": m.contentType, "cache-control": "no-store" });
      res.end(m.body);
      return;
    }
    if (url.pathname === "/openapi.json" && method === "GET" && o.openapi) {
      ctx.route = "/openapi.json";
      return send(req, res, 200, o.openapi);
    }
    if (method === "GET" && url.pathname === "/health") {
      ctx.route = "/health";
      return send(req, res, 200, { ok: true, ledgers: o.cursors() });
    }

    // ── Routes ──
    if (method === "GET" && url.pathname === "/routes") {
      ctx.route = "/routes";
      const limit = limitParam(url);
      const ledger = ledgerParam(url);
      const sender = url.searchParams.get("sender") ?? undefined;
      if (sender !== undefined && !ADDRESS.test(sender)) throw new BadRequest("sender must be a 20-byte hex address");
      const c = url.searchParams.get("cursor");
      const after = c === null ? undefined : decodeCursor(c, isPageKey);
      if (c !== null && !after) throw new BadRequest("bad cursor");
      const page = o.store.routesPage({ ledger, sender, limit, after });
      return send(req, res, 200, {
        items: page.items.map((e) => ({
          routeId: e.routeId,
          ledger: e.ledger,
          sender: e.args.sender,
          destinationLedger: e.args.destinationLedger,
          txHash: e.txHash,
          blockNumber: e.blockNumber,
          timestamp: e.timestamp,
        })),
        next: page.next ? encodeCursor(page.next) : null,
        inputs: o.cursors(),
      });
    }

    if (method === "GET" && parts[0] === "routes" && parts.length === 2) {
      ctx.route = "/routes/:routeId";
      const id = parseRouteId(parts[1]!);
      if (!id) throw new BadRequest("route id must be 16-byte hex (0x + 32 hex) or a UUID");
      const view = loadRouteStatus(o.store, id, o.cursors(), now());
      return send(req, res, view.found ? 200 : 404, view);
    }

    if (method === "GET" && parts[0] === "accounts" && parts[2] === "notices" && parts.length === 3) {
      ctx.route = "/accounts/:caip10/notices";
      const acct = parts[1]!;
      const p = parseCaip10(acct);
      if (acct.length > 200 || !p || !CAIP2.test(p.ledger) || !/^[-.%a-zA-Z0-9]{1,128}$/.test(p.address)) {
        throw new BadRequest("account must be a CAIP-10 id (namespace:reference:address)");
      }
      return send(req, res, 200, accountNotices(o.store, acct, o.cursors()));
    }

    if (method === "GET" && url.pathname === "/registry") {
      ctx.route = "/registry";
      const t = now();
      const only = ledgerParam(url);
      const ids = o.ledgers.map((l) => l.id).filter((id) => !only || id === only);
      if (only && ids.length === 0) return send(req, res, 404, { error: `unknown ledger ${only}` });
      const ledgers = Object.fromEntries(ids.map((id) => [id, registryView(loadRegistry(o.store, id, resolve), t)]));
      const main = o.registryLedger ?? o.ledgers[0]?.id;
      return send(req, res, 200, {
        asOf: t,
        registryLedger: main,
        committee: main && ledgers[main] ? ledgers[main].committee : null,
        ledgers,
      });
    }

    if (method === "POST" && url.pathname === "/quote") {
      ctx.route = "/quote";
      if (!o.quote) throw new HttpError(503, "quote service not configured", "unavailable");
      const release = quoteSlots.tryAcquire();
      if (!release) throw new HttpError(503, "quote service busy, retry shortly", "overloaded", { "retry-after": "1" });
      const t0 = performance.now();
      try {
        const body = (await readJson(req, h.bodyLimitBytes)) as QuoteRequestBody;
        const q = await o.quote.quote(body);
        o.metrics?.quoteDuration.observe({ outcome: q.ok ? "ok" : "no_route" }, (performance.now() - t0) / 1000);
        return send(req, res, 200, q);
      } catch (e) {
        o.metrics?.quoteDuration.observe({ outcome: e instanceof BadRequest || e instanceof HttpError ? "rejected" : "error" }, (performance.now() - t0) / 1000);
        throw e;
      } finally {
        release();
      }
    }

    if (method === "GET" && parts[0] === "graphs" && parts.length === 2) {
      ctx.route = "/graphs/:hash";
      if (!/^0x[0-9a-fA-F]{64}$/.test(parts[1]!)) throw new BadRequest("graph hash must be 32-byte hex");
      const g = o.quote?.graphByHash(parts[1]!);
      return g ? send(req, res, 200, g) : send(req, res, 404, { error: "unknown graph hash (snapshots are kept briefly)" });
    }

    if (method === "GET" && url.pathname === "/pending") {
      ctx.route = "/pending";
      const limit = limitParam(url);
      const ledger = ledgerParam(url);
      const c = url.searchParams.get("cursor");
      const off = c === null ? { o: 0 } : decodeCursor(c, isOffset);
      if (!off) throw new BadRequest("bad cursor");
      const all = (o.trigger?.pending() ?? []).filter((j) => !ledger || j.ledger === ledger);
      const jobs = all.slice(off.o, off.o + limit);
      return send(req, res, 200, { jobs, next: off.o + limit < all.length ? encodeCursor({ o: off.o + limit }) : null, total: all.length });
    }

    if (method === "GET" && url.pathname === "/stream") {
      ctx.route = "/stream";
      return stream(req, res, url, ctx);
    }

    const known = ["/routes", "/registry", "/quote", "/pending", "/stream", "/health", "/healthz", "/readyz", "/openapi.json"];
    if (known.includes(url.pathname)) throw new HttpError(405, "method not allowed", "bad_request", { allow: url.pathname === "/quote" ? "POST, OPTIONS" : "GET, OPTIONS" });
    throw new HttpError(404, "not found", "not_found");
  }

  function stream(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx): void {
    if (draining) throw new HttpError(503, "shutting down", "unavailable", { "retry-after": "5" });
    const routeFilter = url.searchParams.get("routeId");
    const routeId = routeFilter ? parseRouteId(routeFilter) : undefined;
    if (routeFilter && !routeId) throw new BadRequest("bad routeId");
    const ledger = url.searchParams.get("ledger");
    if (ledger !== null && (!CAIP2.test(ledger) || !knownLedgers.has(ledger))) throw new BadRequest("ledger must be a configured CAIP-2 id");
    const names = url.searchParams.get("names")?.split(",").filter(Boolean);
    if (names && (names.length > 32 || names.some((n) => !EVENT_NAME.test(n)))) throw new BadRequest("names must be a comma-separated list of event names");
    if (sseClients.size >= h.sse.maxClients) throw new HttpError(503, "too many open streams", "overloaded", { "retry-after": "10" });
    let mine = 0;
    for (const ip of sseClients.values()) if (ip === ctx.ip) mine++;
    if (mine >= h.sse.maxPerClient) throw new HttpError(429, "too many open streams from this client", "rate_limited", { "retry-after": "10" });

    // Receipt ids of the watched route, so its receipt's journey streams too.
    const related = new Set<string>(routeId ? [routeId] : []);
    if (routeId) {
      for (const e of o.store.eventsByRouteIds([routeId])) if (e.name === "ReceiptSent") related.add(String(e.args.receiptId).toLowerCase());
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
      ...(corsHeaders(h.cors.origins, req.headers.origin, h.cors.maxAgeS, false) ?? {}),
    });
    res.write(`retry: 3000\n\n`);
    const write = (event: string, data: unknown, id?: string) => {
      res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
    };
    if (routeId) write("route", loadRouteStatus(o.store, routeId, o.cursors(), now()));

    const onEvent = (e: IndexedEvent) => {
      if (ledger && e.ledger !== ledger) return;
      if (names && !names.includes(e.name)) return;
      if (routeId) {
        const rid = (e.routeId ?? "").toLowerCase();
        if (e.name === "ReceiptSent" && rid === routeId) related.add(String(e.args.receiptId).toLowerCase());
        if (!related.has(rid)) return;
      }
      write("indexed", e, `${e.ledger}:${e.blockNumber}:${e.logIndex}`);
      if (routeId) write("route", loadRouteStatus(o.store, routeId, o.cursors(), now()));
    };
    const onReorg = (r: ReorgInfo) => {
      if (ledger && r.ledger !== ledger) return;
      write("reorg", r);
      if (routeId) write("route", loadRouteStatus(o.store, routeId, o.cursors(), now()));
    };
    o.bus.on("event", onEvent);
    o.bus.on("reorg", onReorg);
    sseClients.set(res, ctx.ip);
    const hb = setInterval(() => res.write(`: ping\n\n`), h.sse.heartbeatMs);
    const close = () => {
      clearInterval(hb);
      o.bus.off("event", onEvent);
      o.bus.off("reorg", onReorg);
      sseClients.delete(res);
    };
    req.on("close", close);
    res.on("close", close);
  }

  server.drain = () => {
    draining = true;
    for (const r of sseClients.keys()) {
      r.write("event: shutdown\ndata: {}\n\n");
      r.end();
    }
  };
  server.sseClientCount = () => sseClients.size;
  server.on("close", () => {
    for (const r of sseClients.keys()) r.end();
  });
  return server;
}
