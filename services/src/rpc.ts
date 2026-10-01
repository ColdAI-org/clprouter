// SPDX-License-Identifier: MIT
import { custom, HttpRequestError, RpcRequestError, TimeoutError, type CustomTransport } from "viem";
import type { RpcPolicy } from "./config.js";
import { RPC_DEFAULTS } from "./config.js";
import type { Logger } from "./log.js";
import { redactUrl, scrubMessage, silentLogger, urlHost } from "./log.js";

/** Hooks for metrics. */
export interface RpcObserver {
  request?(o: { ledger: string; endpoint: string; method: string; outcome: "ok" | "rpc_error" | "http_error" | "rate_limited" | "timeout" | "network_error"; seconds: number }): void;
  retry?(o: { ledger: string; endpoint: string; method: string; reason: string }): void;
}

interface Endpoint {
  /** URL without user info (fetch refuses credentials in URLs). */
  url: string;
  /** Basic auth from the URL's user info, sent as a header. */
  auth?: string;
  /** Host label (metrics, logs): never contains a path or credentials. */
  label: string;
  /** Skip until this time (rate limit / failure cooldown). */
  coolUntil: number;
  /** Chain id check: undefined = not checked yet. */
  verified?: boolean;
  /** Fatal: wrong chain. */
  disabled?: string;
}

export interface ResilientRpcOptions {
  ledger: string;
  urls: string[];
  policy?: RpcPolicy;
  /** Expected chain id; when set, every endpoint is checked before its first use and on {@link checkChainId}. */
  chainId?: number;
  log?: Logger;
  observer?: RpcObserver;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** JSON-RPC error codes that will not get better on another endpoint or a retry (bad input, reverts). */
const DETERMINISTIC_RPC_CODES = new Set([3, -32600, -32601, -32602, -32700]);
/** HTTP statuses worth retrying (elsewhere). */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ChainIdMismatchError extends Error {
  override name = "ChainIdMismatchError";
}

class RetryableError extends Error {
  constructor(
    message: string,
    readonly cause: Error,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * JSON-RPC client over several endpoints for one ledger: per-request timeout, retries with exponential backoff and
 * full jitter, `Retry-After` honoured (capped), endpoints cooled down after a rate limit or failure, and the
 * configured chain id checked on every endpoint before use. Deterministic errors (reverts, bad params) are returned
 * at once. Use {@link transport} to plug it into viem.
 */
export class ResilientRpc {
  readonly endpoints: Endpoint[];
  readonly policy: Required<RpcPolicy>;
  private next = 0;
  private id = 0;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly o: ResilientRpcOptions) {
    if (o.urls.length === 0) throw new Error(`rpc ${o.ledger}: no endpoints`);
    this.endpoints = o.urls.map((raw) => {
      const u = new URL(raw);
      let auth: string | undefined;
      if (u.username || u.password) {
        auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
        u.username = "";
        u.password = "";
      }
      return { url: u.toString(), auth, label: urlHost(raw), coolUntil: 0 };
    });
    this.policy = { ...RPC_DEFAULTS, ...(o.policy ?? {}) };
    this.log = o.log ?? silentLogger;
    this.fetchFn = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  /** viem transport (viem's own retries are off: this class retries). */
  transport(): CustomTransport {
    return custom({ request: ({ method, params }: { method: string; params?: unknown }) => this.request(method, params) }, { retryCount: 0, key: "resilient", name: `ResilientRpc(${this.o.ledger})` });
  }

  /**
   * Check `eth_chainId` on every endpoint. A mismatch disables the endpoint and throws {@link ChainIdMismatchError}
   * (fatal at startup). Unreachable endpoints are left unverified and checked again before their first use.
   * Returns per-endpoint results.
   */
  async checkChainId(): Promise<{ endpoint: string; chainId?: number; error?: string }[]> {
    const want = this.o.chainId;
    const out: { endpoint: string; chainId?: number; error?: string }[] = [];
    for (const e of this.endpoints) {
      try {
        const got = Number(BigInt((await this.call(e, "eth_chainId", [])) as string));
        out.push({ endpoint: e.label, chainId: got });
        if (want !== undefined && got !== want) {
          e.disabled = `chain id ${got}, expected ${want}`;
          e.verified = false;
        } else e.verified = true;
      } catch (err) {
        out.push({ endpoint: e.label, error: (err as Error).message });
        this.log.warn("rpc endpoint unreachable at startup", { ledger: this.o.ledger, endpoint: e.label, err: (err as Error).message });
      }
    }
    const bad = this.endpoints.filter((e) => e.disabled);
    if (bad.length) {
      throw new ChainIdMismatchError(`${this.o.ledger}: wrong chain on ${bad.map((e) => `${e.label} (${e.disabled})`).join(", ")}`);
    }
    return out;
  }

  /** True if at least one endpoint is usable (not disabled, chain id verified or not required). */
  usable(): boolean {
    return this.endpoints.some((e) => !e.disabled && (this.o.chainId === undefined || e.verified === true));
  }

  /** Endpoints in the order to try: round-robin start, cooled-down ones last. */
  private order(): Endpoint[] {
    const n = this.endpoints.length;
    const start = this.next++ % n;
    const all = Array.from({ length: n }, (_, i) => this.endpoints[(start + i) % n]!).filter((e) => !e.disabled);
    const t = this.now();
    return [...all.filter((e) => e.coolUntil <= t), ...all.filter((e) => e.coolUntil > t).sort((a, b) => a.coolUntil - b.coolUntil)];
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const p = this.policy;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= p.retries; attempt++) {
      const order = this.order();
      if (order.length === 0) throw new Error(`rpc ${this.o.ledger}: every endpoint is disabled`);
      const e = order[0]!;
      // Lazily verify the chain of an endpoint that was down at startup.
      if (this.o.chainId !== undefined && e.verified !== true && method !== "eth_chainId") {
        try {
          const got = Number(BigInt((await this.call(e, "eth_chainId", [])) as string));
          if (got !== this.o.chainId) {
            e.disabled = `chain id ${got}, expected ${this.o.chainId}`;
            this.log.error("rpc endpoint on the wrong chain; disabled", { ledger: this.o.ledger, endpoint: e.label, chainId: got, expected: this.o.chainId });
            attempt--;
            continue;
          }
          e.verified = true;
        } catch (err) {
          lastErr = err as Error;
          this.cool(e, err);
          if (attempt < p.retries) await this.backoff(attempt, err, method, e);
          continue;
        }
      }
      try {
        return await this.call(e, method, params);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        lastErr = err.cause;
        this.cool(e, err);
        if (attempt < p.retries) await this.backoff(attempt, err, method, e);
      }
    }
    throw lastErr ?? new Error(`rpc ${this.o.ledger}: ${method} failed`);
  }

  private cool(e: Endpoint, err: unknown): void {
    if (this.endpoints.length < 2) return;
    const ra = err instanceof RetryableError ? err.retryAfterMs : undefined;
    e.coolUntil = this.now() + Math.min(Math.max(ra ?? 0, this.policy.cooldownMs), this.policy.maxBackoffMs * 8);
  }

  private async backoff(attempt: number, err: unknown, method: string, e: Endpoint): Promise<void> {
    const p = this.policy;
    const ra = err instanceof RetryableError ? err.retryAfterMs : undefined;
    // Another endpoint available right now: switch without waiting (unless the server asked us to wait).
    const other = this.endpoints.some((x) => x !== e && !x.disabled && x.coolUntil <= this.now());
    const exp = Math.min(p.maxBackoffMs, p.backoffMs * 2 ** attempt);
    const delay = ra !== undefined ? Math.min(ra, p.maxBackoffMs) : other ? 0 : Math.floor(this.random() * exp);
    this.o.observer?.retry?.({ ledger: this.o.ledger, endpoint: e.label, method, reason: (err as Error).message.slice(0, 80) });
    this.log.debug("rpc retry", { ledger: this.o.ledger, endpoint: e.label, method, attempt: attempt + 1, delayMs: delay, err: (err as Error).message });
    if (delay > 0) await this.sleep(delay);
  }

  /** One HTTP round trip to one endpoint. Throws {@link RetryableError} for transient failures. */
  private async call(e: Endpoint, method: string, params: unknown): Promise<unknown> {
    const body = { jsonrpc: "2.0" as const, id: ++this.id, method, params: params ?? [] };
    const started = performance.now();
    const safeUrl = redactUrl(e.url);
    const observe = (outcome: Parameters<NonNullable<RpcObserver["request"]>>[0]["outcome"]) =>
      this.o.observer?.request?.({ ledger: this.o.ledger, endpoint: e.label, method, outcome, seconds: (performance.now() - started) / 1000 });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.policy.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(e.url, { method: "POST", headers: { "content-type": "application/json", ...(e.auth ? { authorization: e.auth } : {}) }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) {
        observe("timeout");
        throw new RetryableError("timeout", new TimeoutError({ body, url: safeUrl }));
      }
      observe("network_error");
      throw new RetryableError("network error", new HttpRequestError({ body, url: safeUrl, details: scrubMessage((err as Error).message) }));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      observe(ctrl.signal.aborted ? "timeout" : "network_error");
      throw new RetryableError("body read failed", new HttpRequestError({ body, url: safeUrl, details: scrubMessage((err as Error).message) }));
    }
    clearTimeout(timer);
    if (!res.ok) {
      const httpErr = new HttpRequestError({ body, url: safeUrl, status: res.status, headers: res.headers, details: scrubMessage(text.slice(0, 200)) });
      if (RETRY_STATUS.has(res.status)) {
        observe(res.status === 429 ? "rate_limited" : "http_error");
        throw new RetryableError(`HTTP ${res.status}`, httpErr, parseRetryAfter(res.headers.get("retry-after"), this.now()));
      }
      observe("http_error");
      throw httpErr;
    }
    let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      observe("http_error");
      throw new RetryableError("invalid JSON", new HttpRequestError({ body, url: safeUrl, status: res.status, details: "response is not JSON" }));
    }
    if (json.error) {
      const rpcErr = new RpcRequestError({ body, error: json.error, url: safeUrl });
      // Rate limits reported inside JSON-RPC (-32005 "limit exceeded", 429 in code) are transient.
      if (json.error.code === -32005 || json.error.code === 429 || /rate limit|too many requests/i.test(json.error.message)) {
        observe("rate_limited");
        throw new RetryableError("rate limited", rpcErr);
      }
      observe("rpc_error");
      if (DETERMINISTIC_RPC_CODES.has(json.error.code) || json.error.data !== undefined) throw rpcErr;
      // Other server-side errors (-32000 "header not found" on a lagging node, internal errors) may pass elsewhere,
      // except well-known transaction errors that must not be resent blindly.
      if (/revert|nonce|already known|insufficient funds|underpriced|intrinsic gas/i.test(json.error.message)) throw rpcErr;
      throw new RetryableError(`rpc error ${json.error.code}`, rpcErr);
    }
    observe("ok");
    return json.result;
  }
}

/** `Retry-After` as ms: delta-seconds or an HTTP date. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}
