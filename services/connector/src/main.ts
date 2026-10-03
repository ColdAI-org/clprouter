// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import type { LogLevel } from "../../src/log.js";
import { executeWithdraw, ensureRegistered, postBond, requestWithdraw } from "./bond.js";
import { loadConnectorConfig } from "./config.js";
import type { RelayOrder } from "./connector.js";
import { Connector } from "./connector.js";
import { startHttp } from "./http.js";
import { QuoteError } from "./quote.js";

const USAGE = `usage:
  connector run   --config <file> [--once] [--relay-order deposit-first|delivery-first] [--skip-delivery all|<orderId>]
  connector quote --config <file> --request <request.json> --out <quote.json>
  connector serve --config <file> [--http-only]
  connector bond  --config <file> post <amount> | withdraw-request <amount> | withdraw-execute`;

class UsageError extends Error {}

const DECIMAL = /^[1-9][0-9]{0,77}$/;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      once: { type: "boolean" },
      "relay-order": { type: "string" },
      "skip-delivery": { type: "string" },
      request: { type: "string" },
      out: { type: "string" },
      "http-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stderr.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  if (!values.config) throw new UsageError("--config <file> is required");
  // Logs go to stderr; stdout carries only command output (the run summary).
  const log = createLogger({ level: (process.env.CONNECTOR_LOG_LEVEL as LogLevel | undefined) ?? "info", write: (line) => process.stderr.write(`${line}\n`) });
  const cfg = loadConnectorConfig(values.config);
  const c = Connector.fromConfig(cfg, { log });

  switch (cmd) {
    case "run": {
      const order = values["relay-order"] ?? "deposit-first";
      if (order !== "deposit-first" && order !== "delivery-first") throw new UsageError("--relay-order must be deposit-first or delivery-first");
      const skip = values["skip-delivery"];
      if (skip !== undefined && skip !== "all" && !/^0x[0-9a-fA-F]{64}$/.test(skip)) throw new UsageError("--skip-delivery must be all or a 32-byte order id");
      const opts = { relayOrder: order as RelayOrder, skipDelivery: skip };
      if (values.once) {
        const s = await c.runOnce(opts);
        process.stdout.write(`${JSON.stringify(s)}\n`);
        return s.errors.length ? 1 : 0;
      }
      await loop(c, opts, cfg.pollIntervalMs);
      return 0;
    }
    case "quote": {
      if (!values.request || !values.out) throw new UsageError("quote needs --request <file> and --out <file>");
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(values.request, "utf8"));
      } catch (e) {
        throw new UsageError(`cannot read ${values.request}: ${(e as Error).message}`);
      }
      const r = await c.quote(body);
      writeFileSync(values.out, `${JSON.stringify(r, null, 2)}\n`);
      return 0;
    }
    case "serve": {
      const server = await startHttp(c, { ...cfg.http, log });
      log.info("connector API listening", { host: cfg.http.host, port: cfg.http.port });
      const stop = () => server.close(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (!values["http-only"]) await loop(c, {}, cfg.pollIntervalMs);
      else await new Promise(() => undefined);
      return 0;
    }
    case "bond": {
      const [op, amount] = rest;
      const h = c.deps.hedera;
      const ob = cfg.hedera.orderBook;
      if (op === "post") {
        if (!amount || !DECIMAL.test(amount)) throw new UsageError("bond post <amount> needs a positive decimal amount");
        await ensureRegistered(h, ob, c.deps.signer.address, log);
        await postBond(h, ob, cfg.bond.asset, BigInt(amount), log);
      } else if (op === "withdraw-request") {
        if (!amount || !DECIMAL.test(amount)) throw new UsageError("bond withdraw-request <amount> needs a positive decimal amount");
        await requestWithdraw(h, ob, cfg.bond.asset, BigInt(amount));
      } else if (op === "withdraw-execute") {
        await executeWithdraw(h, ob, cfg.bond.asset);
      } else {
        throw new UsageError("bond needs post <amount>, withdraw-request <amount> or withdraw-execute");
      }
      process.stdout.write(`${JSON.stringify({ ok: true, op })}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

async function loop(c: Connector, opts: { relayOrder?: RelayOrder; skipDelivery?: string }, intervalMs: number): Promise<never> {
  for (;;) {
    try {
      const s = await c.runOnce(opts);
      if (s.delivered.length || s.skipped.length || s.closed.length || s.errors.length) c.log.info("pass", { ...s });
    } catch (e) {
      c.log.error("pass failed", { err: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError || e instanceof ConfigError) {
      process.stderr.write(`${(e as Error).message}\n${e instanceof UsageError ? USAGE + "\n" : ""}`);
      process.exit(2);
    }
    if (e instanceof QuoteError) {
      process.stderr.write(`${JSON.stringify({ error: e.message, code: e.code })}\n`);
      process.exit(1);
    }
    const x = e as { shortMessage?: string; message?: string };
    process.stderr.write(`connector: ${x.shortMessage ?? x.message ?? String(e)}\n`);
    process.exit(1);
  },
);
