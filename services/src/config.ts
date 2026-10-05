import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { z } from "zod";
import type { LogLevel } from "./log.js";

/**
 * Services configuration.
 *
 * Sources, later ones winning: a JSON file (`CLPROUTER_SERVICES_CONFIG` or argv) or inline JSON
 * (`CLPROUTER_SERVICES_CONFIG_JSON`), `${VAR}` references inside its strings, then the `CLPROUTER_*` env overrides
 * listed in {@link ENV_OVERRIDES}. The result is validated with a strict schema (unknown keys are errors, so a typo
 * cannot silently drop a setting) and defaults are filled in ({@link resolveConfig}).
 */

// ── Schema ────────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** CAIP-2: namespace (3-8 chars) and reference (1-32 chars). */
export const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

const address = z.string().regex(ADDRESS, "must be a 20-byte hex address");
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const rpcUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}, "must be an http(s) URL");

const rpcPolicy = z
  .object({
    /** Per-request timeout, ms. */
    timeoutMs: int(100, 120_000).optional(),
    /** Retries after the first attempt (across endpoints). */
    retries: int(0, 10).optional(),
    /** Base delay of the exponential backoff, ms (full jitter). */
    backoffMs: int(1, 60_000).optional(),
    /** Cap on one backoff delay, including a server's Retry-After. */
    maxBackoffMs: int(1, 300_000).optional(),
    /** How long an endpoint is skipped after a rate limit or failure, ms. */
    cooldownMs: int(0, 600_000).optional(),
  })
  .strict();

const ledgerSchema = z
  .object({
    id: z.string().regex(CAIP2, "must be a CAIP-2 id"),
    /** Single RPC URL (kept for older configs). */
    rpcUrl: rpcUrl.optional(),
    /** RPC endpoints in order of preference; later ones are fallbacks. */
    rpcUrls: z.array(rpcUrl).min(1).max(16).optional(),
    /** Expected `eth_chainId`. Every endpoint is checked at startup; a mismatch is fatal. */
    chainId: int(1, Number.MAX_SAFE_INTEGER).optional(),
    confirmations: int(0, 10_000),
    contracts: z
      .object({ router: address, registry: address, vault: address, clprService: address.optional() })
      .strict(),
    startBlock: int(0, Number.MAX_SAFE_INTEGER).optional(),
    batchSize: int(1, 100_000).optional(),
    pollIntervalMs: int(100, 3_600_000).optional(),
    rpc: rpcPolicy.optional(),
  })
  .strict()
  .refine((l) => l.rpcUrl !== undefined || l.rpcUrls !== undefined, { message: "needs rpcUrl or rpcUrls" });

const signerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      /** A TEST private key read from an env var. Only accepted when every trigger RPC is local and not in strict mode. */
      kind: z.literal("local-test-key"),
      keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    })
    .strict(),
  z
    .object({
      /**
       * External signer speaking JSON-RPC `eth_signTransaction` (Web3Signer, or anything compatible, fronting a KMS or
       * HSM). The service never sees the key.
       */
      kind: z.literal("web3signer"),
      url: rpcUrl,
      /** Account the signer signs for; every signature is checked against it. */
      address,
      /** Env var holding a bearer token for the signer (optional). */
      authTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      timeoutMs: int(100, 120_000).optional(),
    })
    .strict(),
]);

const triggerSchema = z
  .object({
    enabled: z.boolean(),
    /** Shorthand for `signer: { kind: "local-test-key", keyEnv }` (older configs). */
    keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    signer: signerSchema.optional(),
    completeRejected: z.boolean().optional(),
    ledgers: z.array(z.string().regex(CAIP2)).optional(),
    /** Attempts per job before it is left for someone else. Default 3. */
    maxAttempts: int(1, 100).optional(),
    /**
     * Other Connectors to send a queued receipt over, by Channel id, when the one the route named refuses it. Routers
     * accept a receipt over any Connector of its Channel.
     */
    receiptConnectors: z.record(z.string().regex(/^0x[0-9a-fA-F]{64}$/), z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))).optional(),
  })
  .strict()
  .refine((t) => !(t.keyEnv && t.signer), { message: "set either keyEnv or signer, not both" });

const databaseSchema = z.union([
  z.string().min(1),
  z
    .object({
      /** `postgres://…`, `sqlite:<path>`, a plain path, or `:memory:`. */
      url: z.string().min(1),
      /** PostgreSQL pool size. Default 10. */
      poolMax: int(1, 200).optional(),
      /** PostgreSQL statement timeout, ms. Default 15000. */
      statementTimeoutMs: int(100, 600_000).optional(),
    })
    .strict(),
]);

const httpSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: int(0, 65_535).optional(),
    /** Max request body, bytes. Default 64 KiB. */
    bodyLimitBytes: int(1, 1_048_576).optional(),
    /** Time to receive a whole request, ms. Default 30000. */
    requestTimeoutMs: int(1_000, 600_000).optional(),
    headersTimeoutMs: int(1_000, 120_000).optional(),
    keepAliveTimeoutMs: int(100, 120_000).optional(),
    /** Take the client address from the last `X-Forwarded-For` entry (one trusted proxy in front). Default false. */
    trustProxy: z.boolean().optional(),
    cors: z
      .object({
        /** Allowed origins; `["*"]` allows any (the API is public, read-only and never uses credentials). */
        origins: z.array(z.string().min(1)).max(100),
        maxAgeS: int(0, 86_400).optional(),
      })
      .strict()
      .optional(),
    rateLimit: z
      .object({
        enabled: z.boolean().optional(),
        /** Sustained requests per minute per client. Default 600. */
        requestsPerMinute: int(1, 1_000_000).optional(),
        /** Burst size per client. Default 120. */
        burst: int(1, 1_000_000).optional(),
        /** Tokens a POST /quote costs. Default 5. */
        quoteCost: int(1, 1000).optional(),
      })
      .strict()
      .optional(),
    /** Quotes computed at once; more get 503 + Retry-After. Default 32. */
    maxConcurrentQuotes: int(1, 10_000).optional(),
    sse: z
      .object({ maxClients: int(1, 100_000).optional(), maxPerClient: int(1, 10_000).optional(), heartbeatMs: int(1_000, 600_000).optional() })
      .strict()
      .optional(),
    pagination: z.object({ defaultLimit: int(1, 1000).optional(), maxLimit: int(1, 10_000).optional() }).strict().optional(),
  })
  .strict();

export const servicesConfigSchema = z
  .object({
    ledgers: z.array(ledgerSchema).min(1).max(256),
    database: databaseSchema.optional(),
    http: httpSchema.optional(),
    graph: z.object({ file: z.string().min(1).optional() }).strict().optional(),
    registryLedger: z.string().regex(CAIP2).optional(),
    routerVersions: z.array(int(0, 2 ** 32 - 1)).min(1).optional(),
    trigger: triggerSchema.optional(),
    rpc: rpcPolicy.optional(),
    log: z.object({ level: z.enum(["debug", "info", "warn", "error"]).optional() }).strict().optional(),
    metrics: z
      .object({ enabled: z.boolean().optional(), host: z.string().min(1).optional(), port: int(0, 65_535).optional() })
      .strict()
      .optional(),
    /** A ledger whose last successful poll is older than this many poll intervals makes /readyz fail. Default 10. */
    readiness: z.object({ maxStalePolls: int(1, 10_000).optional() }).strict().optional(),
    shutdownTimeoutMs: int(1_000, 600_000).optional(),
    /**
     * Production mode: every ledger needs `chainId`, and the local test-key signer is refused. Default: on when
     * `NODE_ENV=production`, overridable with `CLPROUTER_STRICT`.
     */
    strict: z.boolean().optional(),
  })
  .strict();

// ── Types ─────────────────────────────────────────────────────────────────

/** One ledger the services watch. Ledger ids are CAIP-2 (`eip155:296`, ...). */
export interface LedgerConfig {
  id: string;
  /** Single RPC URL (older configs). Use `rpcUrls` for fallbacks. */
  rpcUrl?: string;
  rpcUrls?: string[];
  chainId?: number;
  /**
   * Blocks behind the head before an event is indexed (reorg safety). Pick it per ledger: 0 on instant-finality
   * ledgers (Hedera, local anvil), more on probabilistic ones.
   */
  confirmations: number;
  contracts: {
    router: Address;
    registry: Address;
    vault: Address;
    /** CLPR Service on this ledger; when set, the quote service reads live Channel and Connector state. */
    clprService?: Address;
  };
  /** First block to index (the deployment block). Default 0. */
  startBlock?: number;
  /** Max blocks per `eth_getLogs` call. Default 2000. */
  batchSize?: number;
  /** Poll interval, ms. Default 2000. */
  pollIntervalMs?: number;
  rpc?: RpcPolicy;
}

export interface RpcPolicy {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  cooldownMs?: number;
}

export type SignerConfig =
  | { kind: "local-test-key"; keyEnv?: string }
  | { kind: "web3signer"; url: string; address: Address; authTokenEnv?: string; timeoutMs?: number };

export interface TriggerConfig {
  enabled: boolean;
  /** Shorthand for a local test-key signer reading this env var (default `CLPROUTER_TRIGGER_KEY`). */
  keyEnv?: string;
  signer?: SignerConfig;
  /** Also complete `ForwardRejected` hops with a FAILED receipt so the origin is refunded. Default false. */
  completeRejected?: boolean;
  /** Ledgers the trigger may submit on (default: all). */
  ledgers?: string[];
  maxAttempts?: number;
  /** Fallback Connectors for queued receipts, by Channel id (tried in order after the route's own Connector). */
  receiptConnectors?: Record<string, string[]>;
}

export type DatabaseConfig = string | { url: string; poolMax?: number; statementTimeoutMs?: number };

export interface HttpConfig {
  host?: string;
  port?: number;
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  trustProxy?: boolean;
  cors?: { origins: string[]; maxAgeS?: number };
  rateLimit?: { enabled?: boolean; requestsPerMinute?: number; burst?: number; quoteCost?: number };
  maxConcurrentQuotes?: number;
  sse?: { maxClients?: number; maxPerClient?: number; heartbeatMs?: number };
  pagination?: { defaultLimit?: number; maxLimit?: number };
}

/** Configuration as written (file / env / code). See {@link resolveConfig} for the defaults. */
export interface ServicesConfig {
  ledgers: LedgerConfig[];
  /** SQLite path, `:memory:`, `sqlite:<path>` or a `postgres://` URL. Default `clprouter-services.sqlite`. */
  database?: DatabaseConfig;
  http?: HttpConfig;
  /** Base route graph (measured timing, gas, emissions) the live state is overlaid on. Default: SDK sample graph. */
  graph?: { file?: string };
  /** Ledger whose registry supplies certifications for quotes. Default: the first ledger. */
  registryLedger?: string;
  /** Router versions to check for disables in quotes. Default [1]. */
  routerVersions?: number[];
  trigger?: TriggerConfig;
  /** Default RPC policy (per-ledger `rpc` overrides it). */
  rpc?: RpcPolicy;
  log?: { level?: LogLevel };
  metrics?: { enabled?: boolean; host?: string; port?: number };
  readiness?: { maxStalePolls?: number };
  shutdownTimeoutMs?: number;
  strict?: boolean;
}

export type DatabaseTarget =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string; poolMax: number; statementTimeoutMs: number };

export interface ResolvedLedger extends LedgerConfig {
  rpcUrls: string[];
  rpc: Required<RpcPolicy>;
}

/** A validated config with every default filled in. */
export interface ResolvedConfig {
  ledgers: ResolvedLedger[];
  database: DatabaseTarget;
  http: {
    host: string;
    port: number;
    bodyLimitBytes: number;
    requestTimeoutMs: number;
    headersTimeoutMs: number;
    keepAliveTimeoutMs: number;
    trustProxy: boolean;
    cors: { origins: string[]; maxAgeS: number };
    rateLimit: { enabled: boolean; requestsPerMinute: number; burst: number; quoteCost: number };
    maxConcurrentQuotes: number;
    sse: { maxClients: number; maxPerClient: number; heartbeatMs: number };
    pagination: { defaultLimit: number; maxLimit: number };
  };
  graph?: { file?: string };
  registryLedger: string;
  routerVersions: number[];
  trigger: {
    enabled: boolean;
    signer: SignerConfig | undefined;
    completeRejected: boolean;
    ledgers: string[] | undefined;
    maxAttempts: number;
    receiptConnectors: Record<string, string[]>;
  };
  log: { level: LogLevel };
  metrics: { enabled: boolean; host: string; port: number | undefined };
  readiness: { maxStalePolls: number };
  shutdownTimeoutMs: number;
  strict: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const RPC_DEFAULTS: Required<RpcPolicy> = { timeoutMs: 10_000, retries: 3, backoffMs: 250, maxBackoffMs: 8_000, cooldownMs: 30_000 };

// ── Validation and defaults ─────────────────────────────────────────────

function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 10)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/** Validate a config's shape and cross-references. Throws {@link ConfigError}. */
export function validateConfig(cfg: ServicesConfig): void {
  const r = servicesConfigSchema.safeParse(cfg);
  if (!r.success) throw new ConfigError(`config: ${formatIssues(r.error)}`);
  const seen = new Set<string>();
  for (const l of cfg.ledgers) {
    if (seen.has(l.id)) throw new ConfigError(`config: duplicate ledger ${l.id}`);
    seen.add(l.id);
  }
  if (cfg.registryLedger && !seen.has(cfg.registryLedger)) {
    throw new ConfigError(`config: registryLedger ${cfg.registryLedger} is not a configured ledger`);
  }
  for (const id of cfg.trigger?.ledgers ?? []) {
    if (!seen.has(id)) throw new ConfigError(`config: trigger.ledgers: ${id} is not a configured ledger`);
  }
}

export function parseDatabase(db: DatabaseConfig | undefined): DatabaseTarget {
  const o = typeof db === "string" || db === undefined ? { url: db ?? "clprouter-services.sqlite" } : db;
  if (/^postgres(ql)?:\/\//i.test(o.url)) {
    return { kind: "postgres", url: o.url, poolMax: o.poolMax ?? 10, statementTimeoutMs: o.statementTimeoutMs ?? 15_000 };
  }
  const path = o.url.startsWith("sqlite:") ? o.url.slice("sqlite:".length) : o.url;
  if (!path) throw new ConfigError("config: database: empty SQLite path");
  return { kind: "sqlite", path };
}

/** Validate and fill defaults. `env` supplies the strict-mode default (`NODE_ENV`, `CLPROUTER_STRICT`). */
export function resolveConfig(cfg: ServicesConfig, env: NodeJS.ProcessEnv = {}): ResolvedConfig {
  validateConfig(cfg);
  const strictEnv = env.CLPROUTER_STRICT;
  const strict = cfg.strict ?? (strictEnv !== undefined ? /^(1|true|yes)$/i.test(strictEnv) : env.NODE_ENV === "production");
  const ledgers: ResolvedLedger[] = cfg.ledgers.map((l) => ({
    ...l,
    rpcUrls: [...new Set(l.rpcUrls ?? [l.rpcUrl!])],
    rpc: { ...RPC_DEFAULTS, ...(cfg.rpc ?? {}), ...(l.rpc ?? {}) },
  }));
  if (strict) {
    const missing = ledgers.filter((l) => l.chainId === undefined).map((l) => l.id);
    if (missing.length) throw new ConfigError(`config: strict mode needs chainId on every ledger (missing: ${missing.join(", ")})`);
  }
  const t = cfg.trigger;
  const signer: SignerConfig | undefined = t?.signer ?? (t ? { kind: "local-test-key", keyEnv: t.keyEnv } : undefined);
  const h = cfg.http ?? {};
  const maxLimit = h.pagination?.maxLimit ?? 500;
  return {
    ledgers,
    database: parseDatabase(cfg.database),
    http: {
      host: h.host ?? "127.0.0.1",
      port: h.port ?? 8787,
      bodyLimitBytes: h.bodyLimitBytes ?? 64 * 1024,
      requestTimeoutMs: h.requestTimeoutMs ?? 30_000,
      headersTimeoutMs: h.headersTimeoutMs ?? 10_000,
      keepAliveTimeoutMs: h.keepAliveTimeoutMs ?? 5_000,
      trustProxy: h.trustProxy ?? false,
      cors: { origins: h.cors?.origins ?? ["*"], maxAgeS: h.cors?.maxAgeS ?? 600 },
      rateLimit: {
        enabled: h.rateLimit?.enabled ?? true,
        requestsPerMinute: h.rateLimit?.requestsPerMinute ?? 600,
        burst: h.rateLimit?.burst ?? 120,
        quoteCost: h.rateLimit?.quoteCost ?? 5,
      },
      maxConcurrentQuotes: h.maxConcurrentQuotes ?? 32,
      sse: { maxClients: h.sse?.maxClients ?? 1000, maxPerClient: h.sse?.maxPerClient ?? 16, heartbeatMs: h.sse?.heartbeatMs ?? 15_000 },
      pagination: { defaultLimit: Math.min(h.pagination?.defaultLimit ?? 50, maxLimit), maxLimit },
    },
    ...(cfg.graph ? { graph: cfg.graph } : {}),
    registryLedger: cfg.registryLedger ?? cfg.ledgers[0]!.id,
    routerVersions: cfg.routerVersions ?? [1],
    trigger: {
      enabled: t?.enabled ?? false,
      signer,
      completeRejected: t?.completeRejected ?? false,
      ledgers: t?.ledgers,
      maxAttempts: t?.maxAttempts ?? 3,
      receiptConnectors: Object.fromEntries(
        Object.entries(t?.receiptConnectors ?? {}).map(([ch, ids]) => [ch.toLowerCase(), ids.map((i) => i.toLowerCase())]),
      ),
    },
    log: { level: cfg.log?.level ?? "info" },
    metrics: { enabled: cfg.metrics?.enabled ?? true, host: cfg.metrics?.host ?? h.host ?? "127.0.0.1", port: cfg.metrics?.port },
    readiness: { maxStalePolls: cfg.readiness?.maxStalePolls ?? 10 },
    shutdownTimeoutMs: cfg.shutdownTimeoutMs ?? 25_000,
    strict,
  };
}

// ── Loading (file + env) ────────────────────────────────────────────────

/** Replace `${VAR}` in every string of a parsed JSON value. A missing variable is an error. */
export function interpolateEnv<T>(v: T, env: NodeJS.ProcessEnv, path = ""): T {
  if (typeof v === "string") {
    return v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, name: string) => {
      const x = env[name];
      if (x === undefined) throw new ConfigError(`config: ${path || "(root)"} references unset env var ${name}`);
      return x;
    }) as T;
  }
  if (Array.isArray(v)) return v.map((x, i) => interpolateEnv(x, env, `${path}[${i}]`)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolateEnv(x, env, path ? `${path}.${k}` : k)])) as T;
  }
  return v;
}

/** Env var name for a ledger's RPC URL override: `CLPROUTER_RPC_URLS_<ID>` with non-alphanumerics as `_`. */
export function rpcEnvName(ledgerId: string): string {
  return `CLPROUTER_RPC_URLS_${ledgerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Env overrides applied on top of the file. */
export const ENV_OVERRIDES = [
  "CLPROUTER_DATABASE_URL",
  "CLPROUTER_HTTP_HOST",
  "CLPROUTER_HTTP_PORT",
  "CLPROUTER_LOG_LEVEL",
  "CLPROUTER_METRICS_PORT",
  "CLPROUTER_CORS_ORIGINS",
  "CLPROUTER_SIGNER_URL",
  "CLPROUTER_RPC_URLS_<LEDGER>",
] as const;

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new ConfigError(`config: ${name} must be an integer`);
  return Number(v);
}

export function applyEnvOverrides(cfg: ServicesConfig, env: NodeJS.ProcessEnv): ServicesConfig {
  const out: ServicesConfig = structuredClone(cfg);
  if (env.CLPROUTER_DATABASE_URL) out.database = typeof out.database === "object" ? { ...out.database, url: env.CLPROUTER_DATABASE_URL } : env.CLPROUTER_DATABASE_URL;
  if (env.CLPROUTER_HTTP_HOST) out.http = { ...out.http, host: env.CLPROUTER_HTTP_HOST };
  const port = envInt(env, "CLPROUTER_HTTP_PORT");
  if (port !== undefined) out.http = { ...out.http, port };
  if (env.CLPROUTER_LOG_LEVEL) out.log = { ...out.log, level: env.CLPROUTER_LOG_LEVEL as LogLevel };
  const mport = envInt(env, "CLPROUTER_METRICS_PORT");
  if (mport !== undefined) out.metrics = { ...out.metrics, port: mport };
  if (env.CLPROUTER_CORS_ORIGINS !== undefined) out.http = { ...out.http, cors: { ...out.http?.cors, origins: list(env.CLPROUTER_CORS_ORIGINS) } };
  if (env.CLPROUTER_SIGNER_URL && out.trigger?.signer?.kind === "web3signer") {
    out.trigger = { ...out.trigger, signer: { ...out.trigger.signer, url: env.CLPROUTER_SIGNER_URL } };
  }
  for (const l of out.ledgers ?? []) {
    const v = env[rpcEnvName(l.id)];
    if (v) {
      l.rpcUrls = list(v);
      delete l.rpcUrl;
    }
  }
  return out;
}

/**
 * Load from a file (or `CLPROUTER_SERVICES_CONFIG_JSON`), apply env, validate. The raw object is returned; pass it
 * to {@link resolveConfig} for defaults (`buildServices` does).
 */
export function loadConfig(path: string | undefined, env: NodeJS.ProcessEnv = process.env): ServicesConfig {
  let text: string;
  if (path) {
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError(`config: cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  } else if (env.CLPROUTER_SERVICES_CONFIG_JSON) {
    text = env.CLPROUTER_SERVICES_CONFIG_JSON;
  } else {
    throw new ConfigError("config: no file given (argv or CLPROUTER_SERVICES_CONFIG) and no CLPROUTER_SERVICES_CONFIG_JSON");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config: not valid JSON: ${(e as Error).message}`);
  }
  const cfg = applyEnvOverrides(interpolateEnv(raw as ServicesConfig, env), env);
  validateConfig(cfg);
  return cfg;
}

// ── Signing guard rails ─────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True if the RPC URL points at a local development node (the only place the test-key signer may sign). */
export function isLocalRpc(url: string): boolean {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Read the local TEST key named by a signer config. Never logged. */
export function triggerKey(cfg: { keyEnv?: string }, env: NodeJS.ProcessEnv = process.env): Hex | undefined {
  const v = env[cfg.keyEnv ?? "CLPROUTER_TRIGGER_KEY"];
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ConfigError("trigger key must be a 32-byte hex private key");
  return v as Hex;
}
