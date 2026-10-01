// SPDX-License-Identifier: MIT
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RpcObserver } from "./rpc.js";

/** Sources read at scrape time. */
export interface MetricSources {
  /** Per ledger: chain head seen by the indexer and the confirmed (indexed) block. */
  ledgers?: () => { ledger: string; head?: number; cursor?: number; confirmations: number; lastSuccessAt?: number }[];
  /** Open trigger jobs. */
  jobs?: () => { ledger: string; kind: string; status: string; n: number }[];
  /** Writes not yet durable (PostgreSQL backlog). */
  storeBacklog?: () => number;
  sseClients?: () => number;
}

/**
 * Prometheus metrics (one registry per Services instance, so tests and multiple instances do not collide).
 * Names are prefixed `clprouter_`.
 */
export class Metrics {
  readonly registry = new Registry();
  private sources: MetricSources = {};

  readonly httpRequests = new Counter({ name: "clprouter_http_requests_total", help: "HTTP requests by route, method and status", labelNames: ["route", "method", "status"] as const, registers: [this.registry] });
  readonly httpDuration = new Histogram({
    name: "clprouter_http_request_duration_seconds",
    help: "HTTP request latency by route",
    labelNames: ["route", "method"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly apiErrors = new Counter({ name: "clprouter_api_errors_total", help: "API error responses by route and kind (bad_request, not_found, rate_limited, too_large, overloaded, internal)", labelNames: ["route", "kind"] as const, registers: [this.registry] });
  readonly quoteDuration = new Histogram({
    name: "clprouter_quote_duration_seconds",
    help: "Time to build the live graph and plan a quote",
    labelNames: ["outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  readonly reorgs = new Counter({ name: "clprouter_reorgs_total", help: "Reorgs past the confirmation depth that rolled indexed state back", labelNames: ["ledger"] as const, registers: [this.registry] });
  readonly reorgEvents = new Counter({ name: "clprouter_reorg_removed_events_total", help: "Indexed events removed by reorg rollbacks", labelNames: ["ledger"] as const, registers: [this.registry] });
  readonly indexedEvents = new Counter({ name: "clprouter_indexed_events_total", help: "Events indexed", labelNames: ["ledger", "name"] as const, registers: [this.registry] });
  readonly pollErrors = new Counter({ name: "clprouter_indexer_poll_errors_total", help: "Indexer poll failures", labelNames: ["ledger"] as const, registers: [this.registry] });
  readonly rpcRequests = new Counter({ name: "clprouter_rpc_requests_total", help: "JSON-RPC requests by ledger, endpoint host and outcome", labelNames: ["ledger", "endpoint", "outcome"] as const, registers: [this.registry] });
  readonly rpcDuration = new Histogram({
    name: "clprouter_rpc_request_duration_seconds",
    help: "JSON-RPC latency by ledger",
    labelNames: ["ledger"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly rpcRetries = new Counter({ name: "clprouter_rpc_retries_total", help: "JSON-RPC retries (after a rate limit, timeout or server error)", labelNames: ["ledger", "endpoint"] as const, registers: [this.registry] });
  readonly triggerTx = new Counter({ name: "clprouter_trigger_jobs_total", help: "Trigger job results (done, skipped, failed)", labelNames: ["ledger", "kind", "result"] as const, registers: [this.registry] });

  constructor(o: { defaultMetrics?: boolean } = {}) {
    if (o.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry, prefix: "clprouter_" });
    const self = this;
    new Gauge({
      name: "clprouter_indexer_head_block",
      help: "Latest chain head seen by the indexer",
      labelNames: ["ledger"] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const l of self.sources.ledgers?.() ?? []) if (l.head !== undefined) this.set({ ledger: l.ledger }, l.head);
      },
    });
    new Gauge({
      name: "clprouter_indexer_cursor_block",
      help: "Last confirmed block indexed",
      labelNames: ["ledger"] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const l of self.sources.ledgers?.() ?? []) if (l.cursor !== undefined) this.set({ ledger: l.ledger }, l.cursor);
      },
    });
    new Gauge({
      name: "clprouter_indexer_lag_blocks",
      help: "Blocks between the head and the indexed cursor, beyond the confirmation depth",
      labelNames: ["ledger"] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const l of self.sources.ledgers?.() ?? []) {
          if (l.head === undefined) continue;
          this.set({ ledger: l.ledger }, Math.max(0, l.head - l.confirmations - (l.cursor ?? -1)));
        }
      },
    });
    new Gauge({
      name: "clprouter_indexer_last_success_timestamp_seconds",
      help: "Unix time of the last successful poll",
      labelNames: ["ledger"] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const l of self.sources.ledgers?.() ?? []) if (l.lastSuccessAt) this.set({ ledger: l.ledger }, l.lastSuccessAt / 1000);
      },
    });
    new Gauge({
      name: "clprouter_pending_hops",
      help: "Trigger jobs (forward, flush, reject) not completed, by ledger, kind and status",
      labelNames: ["ledger", "kind", "status"] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const j of self.sources.jobs?.() ?? []) {
          if (j.status === "pending" || j.status === "failed" || j.status === "submitted") this.set({ ledger: j.ledger, kind: j.kind, status: j.status }, j.n);
        }
      },
    });
    new Gauge({
      name: "clprouter_store_write_backlog",
      help: "Store writes not yet durable (PostgreSQL)",
      registers: [this.registry],
      collect() {
        this.set(self.sources.storeBacklog?.() ?? 0);
      },
    });
    new Gauge({
      name: "clprouter_sse_clients",
      help: "Open server-sent event streams",
      registers: [this.registry],
      collect() {
        this.set(self.sources.sseClients?.() ?? 0);
      },
    });
  }

  setSources(s: MetricSources): void {
    this.sources = { ...this.sources, ...s };
  }

  rpcObserver(): RpcObserver {
    return {
      request: (o) => {
        this.rpcRequests.inc({ ledger: o.ledger, endpoint: o.endpoint, outcome: o.outcome });
        this.rpcDuration.observe({ ledger: o.ledger }, o.seconds);
      },
      retry: (o) => this.rpcRetries.inc({ ledger: o.ledger, endpoint: o.endpoint }),
    };
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
