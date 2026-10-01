// SPDX-License-Identifier: MIT
import type { IncomingMessage } from "node:http";

/**
 * Token-bucket rate limiter keyed by client. Buckets refill continuously; idle buckets are swept so memory stays
 * bounded under address churn.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMs: number;
  private lastSweep: number;

  constructor(
    private readonly o: { requestsPerMinute: number; burst: number; maxKeys?: number },
    private readonly now: () => number = Date.now,
  ) {
    this.perMs = o.requestsPerMinute / 60_000;
    this.lastSweep = now();
  }

  /** Take `cost` tokens. Returns 0 if allowed, else the ms until enough tokens are back. */
  take(key: string, cost = 1): number {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.o.burst, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.o.burst, b.tokens + (t - b.at) * this.perMs);
      b.at = t;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil((cost - b.tokens) / this.perMs);
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(t: number): void {
    const full = this.o.burst / this.perMs;
    const tooMany = this.buckets.size > (this.o.maxKeys ?? 100_000);
    if (!tooMany && t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (tooMany || t - b.at >= full) this.buckets.delete(k);
  }
}

/** Counting semaphore without queueing: `tryAcquire` fails fast when saturated. */
export class Semaphore {
  private used = 0;
  constructor(readonly max: number) {}
  tryAcquire(): (() => void) | undefined {
    if (this.used >= this.max) return undefined;
    this.used++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.used--;
      }
    };
  }
  get inUse(): number {
    return this.used;
  }
}

/** Client address for rate limiting: the socket peer, or the last X-Forwarded-For hop behind one trusted proxy. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const v = Array.isArray(xff) ? xff.join(",") : xff;
    const last = v?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last && last.length <= 64) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** CORS response headers for a request origin, or undefined when the origin is not allowed. */
export function corsHeaders(origins: string[], requestOrigin: string | undefined, maxAgeS: number, preflight: boolean): Record<string, string> | undefined {
  let allow: string | undefined;
  if (origins.includes("*")) allow = "*";
  else if (requestOrigin && origins.includes(requestOrigin)) allow = requestOrigin;
  if (!allow) return undefined;
  const h: Record<string, string> = { "access-control-allow-origin": allow, "access-control-expose-headers": "x-request-id, retry-after" };
  if (allow !== "*") h.vary = "Origin";
  if (preflight) {
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type, x-request-id";
    h["access-control-max-age"] = String(maxAgeS);
  }
  return h;
}

/** Opaque pagination cursor (base64url JSON). */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

export function decodeCursor<T>(s: string, check: (v: unknown) => v is T): T | undefined {
  if (s.length > 512 || !/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    return check(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
