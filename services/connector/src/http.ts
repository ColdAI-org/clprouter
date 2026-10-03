// SPDX-License-Identifier: MIT
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Hex } from "viem";
import type { Logger } from "../../src/log.js";
import { silentLogger } from "../../src/log.js";
import type { Info } from "./connector.js";
import type { QuoteResponse } from "./quote.js";
import { QuoteError } from "./quote.js";

/** What the HTTP API needs from the Connector (a fake in tests). */
export interface ConnectorApi {
  quote(body: unknown): Promise<QuoteResponse>;
  info(): Promise<Info>;
  order(orderId: Hex): Promise<Record<string, unknown> | undefined>;
}

export interface HttpOptions {
  bodyLimitBytes: number;
  log?: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, "body-too-large", `request body is larger than ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, "body-too-large", `request body is larger than ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!done) reject(e);
    });
  });
}

/**
 * The Connector's HTTP API:
 *   POST /quote        quote request JSON -> quote response JSON
 *   GET  /info         Connector, routes and bond
 *   GET  /orders/:id   what the Connector knows about an order and its state on the order book
 * Errors are `{ error, code }` with 400 (bad request, unsupported route), 404, 405, 413, 415 or 503 (no capacity).
 */
export function createHandler(api: ConnectorApi, o: HttpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = o.log ?? silentLogger;
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        if (path === "/quote") {
          if (req.method !== "POST") throw new HttpError(405, "method-not-allowed", "use POST");
          const ct = String(req.headers["content-type"] ?? "");
          if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, "unsupported-media-type", "content-type must be application/json");
          const text = await readBody(req, o.bodyLimitBytes);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            throw new HttpError(400, "bad-request", "body is not valid JSON");
          }
          send(res, 200, await api.quote(body));
          return;
        }
        if (req.method !== "GET") throw new HttpError(405, "method-not-allowed", "use GET");
        if (path === "/info") {
          send(res, 200, await api.info());
          return;
        }
        const m = /^\/orders\/(0x[0-9a-fA-F]{64})$/.exec(path);
        if (m) {
          const r = await api.order(m[1] as Hex);
          if (!r) throw new HttpError(404, "not-found", "unknown order");
          send(res, 200, r);
          return;
        }
        if (path.startsWith("/orders/")) throw new HttpError(400, "bad-request", "order id must be 32 bytes of hex");
        throw new HttpError(404, "not-found", "no such endpoint");
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
        if (e instanceof QuoteError) return send(res, e.status, { error: e.message, code: e.code });
        log.error("request failed", { path: req.url, err: (e as Error).message });
        send(res, 500, { error: "internal error", code: "internal" });
      }
    })();
  };
}

export function startHttp(api: ConnectorApi, o: HttpOptions & { host: string; port: number }): Promise<Server> {
  const server = createServer(createHandler(api, o));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve(server));
  });
}
