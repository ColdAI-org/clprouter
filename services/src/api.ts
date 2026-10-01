import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Hex } from "viem";
import type { IndexedEvent } from "./events.js";
import type { EventBus, ReorgInfo } from "./indexer.js";
import { accountNotices } from "./notices.js";
import type { QuoteRequestBody, QuoteService } from "./quote.js";
import { BadRequest } from "./quote.js";
import { loadRegistry, registryView, subjectIndex } from "./registry.js";
import { loadRouteStatus } from "./status.js";
import type { Cursor, Store } from "./store.js";
import type { ForwardTrigger } from "./trigger.js";

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
  /** SSE heartbeat, ms. Default 15000. */
  heartbeatMs?: number;
}

const ROUTE_ID = /^0x[0-9a-fA-F]{32}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Accepts a 16-byte hex route id or its UUID form (the UETR under the ISO 20022 filter). */
export function parseRouteId(s: string): Hex | undefined {
  if (ROUTE_ID.test(s)) return s.toLowerCase() as Hex;
  if (UUID.test(s)) return `0x${s.replace(/-/g, "").toLowerCase()}` as Hex;
  return undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest("body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

/**
 * Route status API (JSON over HTTP):
 *
 *   GET  /health                     confirmed block per ledger
 *   GET  /routes/:routeId            hop-by-hop status, tx hashes per ledger, final outcome
 *   GET  /accounts/:caip10/notices   quarantine notices, sender receipts and listings for an account
 *   GET  /registry[?ledger=]         certifications, disabled routes, blacklist with case ids, committee, vault
 *   GET  /stream[?routeId=&ledger=&names=]   server-sent events (indexed events, route updates, reorgs)
 *   POST /quote                      planner quote over the live graph, with its inputs
 *   GET  /graphs/:hash               graph snapshot a quote was computed on
 *   GET  /pending                    hops waiting for the public forward / flush trigger, with calldata
 */
export function createApi(o: ApiOptions): Server {
  const now = () => (o.clock ? o.clock() : Math.floor(Date.now() / 1000));
  const subjects = subjectIndex(o.subjects ?? { ledgers: o.ledgers });
  const resolve = (s: Hex) => subjects.get(s.toLowerCase());
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof BadRequest) send(res, 400, { error: err.message });
      else send(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, ledgers: o.cursors() });
    }

    if (method === "GET" && parts[0] === "routes" && parts.length === 2) {
      const id = parseRouteId(parts[1]!);
      if (!id) throw new BadRequest("route id must be 16-byte hex (0x + 32 hex) or a UUID");
      const view = loadRouteStatus(o.store, id, o.cursors(), now());
      return send(res, view.found ? 200 : 404, view);
    }

    if (method === "GET" && parts[0] === "accounts" && parts[2] === "notices" && parts.length === 3) {
      return send(res, 200, accountNotices(o.store, parts[1]!, o.cursors()));
    }

    if (method === "GET" && url.pathname === "/registry") {
      const t = now();
      const only = url.searchParams.get("ledger");
      const ids = o.ledgers.map((l) => l.id).filter((id) => !only || id === only);
      if (only && ids.length === 0) return send(res, 404, { error: `unknown ledger ${only}` });
      const ledgers = Object.fromEntries(ids.map((id) => [id, registryView(loadRegistry(o.store, id, resolve), t)]));
      const main = o.registryLedger ?? o.ledgers[0]?.id;
      return send(res, 200, {
        asOf: t,
        registryLedger: main,
        committee: main && ledgers[main] ? ledgers[main].committee : null,
        ledgers,
      });
    }

    if (method === "POST" && url.pathname === "/quote") {
      if (!o.quote) return send(res, 503, { error: "quote service not configured" });
      const body = (await readJson(req)) as QuoteRequestBody;
      return send(res, 200, await o.quote.quote(body));
    }

    if (method === "GET" && parts[0] === "graphs" && parts.length === 2) {
      const g = o.quote?.graphByHash(parts[1]!);
      return g ? send(res, 200, g) : send(res, 404, { error: "unknown graph hash (snapshots are kept briefly)" });
    }

    if (method === "GET" && url.pathname === "/pending") {
      return send(res, 200, { jobs: o.trigger?.pending() ?? [] });
    }

    if (method === "GET" && url.pathname === "/stream") {
      return stream(req, res, url);
    }

    send(res, 404, { error: "not found" });
  }

  function stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const routeFilter = url.searchParams.get("routeId");
    const routeId = routeFilter ? parseRouteId(routeFilter) : undefined;
    if (routeFilter && !routeId) throw new BadRequest("bad routeId");
    const ledger = url.searchParams.get("ledger");
    const names = url.searchParams.get("names")?.split(",").filter(Boolean);
    // Receipt ids of the watched route, so its receipt's journey streams too.
    const related = new Set<string>(routeId ? [routeId] : []);
    if (routeId) {
      for (const e of o.store.eventsByRouteIds([routeId])) if (e.name === "ReceiptSent") related.add(String(e.args.receiptId).toLowerCase());
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`retry: 3000\n\n`);
    const write = (event: string, data: unknown, id?: string) => {
      res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    sseClients.add(res);
    const hb = setInterval(() => res.write(`: ping\n\n`), o.heartbeatMs ?? 15_000);
    const close = () => {
      clearInterval(hb);
      o.bus.off("event", onEvent);
      o.bus.off("reorg", onReorg);
      sseClients.delete(res);
    };
    req.on("close", close);
    res.on("close", close);
  }

  server.on("close", () => {
    for (const r of sseClients) r.end();
  });
  return server;
}
