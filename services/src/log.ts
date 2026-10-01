// SPDX-License-Identifier: MIT
/**
 * Structured JSON logging: one JSON object per line on stdout (`level`, `time`, `msg`, plus fields).
 * No dependency; secrets never reach a line because URLs are redacted and known secret fields are masked.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never written. */
const SECRET_KEYS = /^(authorization|cookie|password|passwd|secret|token|apikey|api_key|privatekey|private_key|key|mnemonic|seed)$/i;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  /** Adapter for components that take `(msg: string) => void`. */
  fn(level?: LogLevel): (msg: string) => void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Line sink (default: process.stdout). */
  write?: (line: string) => void;
  clock?: () => Date;
  base?: LogFields;
}

/**
 * Remove credentials from a URL: user info, query values and long path segments (RPC providers put API keys in the
 * path, e.g. `/v3/<key>`). Returns the input unchanged if it is not a URL.
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.username || u.password) {
    u.username = "***";
    u.password = "";
  }
  u.pathname = u.pathname
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_\-]{16,}$/.test(seg) ? "***" : seg))
    .join("/");
  for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
  return u.toString();
}

/** Host[:port] of a URL, the label used for an RPC endpoint in metrics and logs. */
export function urlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "invalid-url";
  }
}

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return /^(https?|wss?|postgres(ql)?):\/\//i.test(v) ? redactUrl(v) : v;
  if (v instanceof Error) {
    const out: LogFields = { name: v.name, message: scrubMessage(v.message) };
    if (v.stack) out.stack = scrubMessage(v.stack);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === "object") {
    const out: LogFields = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(x, depth + 1);
    return out;
  }
  return v;
}

/** Redact URLs embedded in free text (error messages from RPC libraries quote the URL they called). */
export function scrubMessage(s: string): string {
  return s.replace(/\b(https?|wss?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const min = ORDER[o.level ?? "info"];
  const write = o.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const clock = o.clock ?? (() => new Date());
  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
      if (ORDER[level] < min) return;
      const rec = { level, time: clock().toISOString(), msg: scrubMessage(msg), ...(scrub(base) as LogFields), ...(scrub(fields ?? {}) as LogFields) };
      try {
        write(JSON.stringify(rec));
      } catch {
        // Never let logging take the process down.
      }
    };
    const l: Logger = {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (f) => make({ ...base, ...f }),
      fn: (level = "info") => (m: string) => emit(level, m),
    };
    return l;
  };
  return make(o.base ?? {});
}

/** A logger that drops everything (tests, library defaults). */
export const silentLogger: Logger = createLogger({ write: () => {}, level: "error" });

/** Wrap a legacy `(msg) => void` callback as a Logger (fields are appended as JSON). */
export function loggerFromFn(fn: (msg: string) => void): Logger {
  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel, m: string, f?: LogFields) => {
      const all = { ...base, ...(f ?? {}) };
      fn(Object.keys(all).length ? `${level}: ${m} ${JSON.stringify(scrub(all))}` : m);
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (f) => make({ ...base, ...f }),
      fn: () => fn,
    };
  };
  return make({});
}
