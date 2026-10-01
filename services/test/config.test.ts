// SPDX-License-Identifier: MIT
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, applyEnvOverrides, interpolateEnv, loadConfig, parseDatabase, resolveConfig, rpcEnvName, type ServicesConfig } from "../src/config.js";

const A = "0x0000000000000000000000000000000000000001";
const base = (): ServicesConfig => ({
  ledgers: [{ id: "eip155:296", rpcUrl: "https://rpc.example/v1", chainId: 296, confirmations: 0, contracts: { router: A, registry: A, vault: A } }],
});

describe("config", () => {
  it("fills defaults and keeps older single-rpcUrl configs working", () => {
    const c = resolveConfig(base());
    expect(c.ledgers[0]!.rpcUrls).toEqual(["https://rpc.example/v1"]);
    expect(c.ledgers[0]!.rpc).toMatchObject({ retries: 3, timeoutMs: 10_000 });
    expect(c.database).toEqual({ kind: "sqlite", path: "clprouter-services.sqlite" });
    expect(c.http).toMatchObject({ host: "127.0.0.1", port: 8787, bodyLimitBytes: 65_536, rateLimit: { enabled: true } });
    expect(c.registryLedger).toBe("eip155:296");
    expect(c.strict).toBe(false);
  });

  it("rejects typos, bad addresses, bad URLs and out-of-range values with the path", () => {
    const typo = { ...base(), htttp: {} } as unknown as ServicesConfig;
    expect(() => resolveConfig(typo)).toThrow(/Unrecognized key.*htttp|htttp/);
    const badAddr = base();
    badAddr.ledgers[0]!.contracts.router = "0x123" as never;
    expect(() => resolveConfig(badAddr)).toThrow(/ledgers\.0\.contracts\.router/);
    const badUrl = base();
    badUrl.ledgers[0]!.rpcUrl = "ftp://x";
    expect(() => resolveConfig(badUrl)).toThrow(/rpcUrl: must be an http/);
    const neg = base();
    neg.ledgers[0]!.confirmations = -1;
    expect(() => resolveConfig(neg)).toThrow(ConfigError);
    const noRpc = base();
    delete noRpc.ledgers[0]!.rpcUrl;
    expect(() => resolveConfig(noRpc)).toThrow(/needs rpcUrl or rpcUrls/);
  });

  it("checks cross-references", () => {
    expect(() => resolveConfig({ ...base(), registryLedger: "eip155:1" })).toThrow(/registryLedger/);
    expect(() => resolveConfig({ ...base(), ledgers: [...base().ledgers, ...base().ledgers] })).toThrow(/duplicate ledger/);
    expect(() => resolveConfig({ ...base(), trigger: { enabled: true, ledgers: ["eip155:2"] } })).toThrow(/trigger\.ledgers/);
    expect(() => resolveConfig({ ...base(), trigger: { enabled: true, keyEnv: "K", signer: { kind: "local-test-key" } } })).toThrow(/either keyEnv or signer/);
  });

  it("strict mode (NODE_ENV=production) requires a chainId on every ledger", () => {
    const c = base();
    delete c.ledgers[0]!.chainId;
    expect(() => resolveConfig(c, { NODE_ENV: "production" })).toThrow(/strict mode needs chainId/);
    expect(resolveConfig(c, { NODE_ENV: "production", CLPROUTER_STRICT: "0" }).strict).toBe(false);
    expect(resolveConfig(base(), { NODE_ENV: "production" }).strict).toBe(true);
  });

  it("maps the legacy keyEnv to a local test-key signer", () => {
    const c = resolveConfig({ ...base(), trigger: { enabled: true, keyEnv: "MY_KEY" } });
    expect(c.trigger.signer).toEqual({ kind: "local-test-key", keyEnv: "MY_KEY" });
  });

  it("parses database targets", () => {
    expect(parseDatabase("postgres://u@h/db")).toMatchObject({ kind: "postgres", poolMax: 10 });
    expect(parseDatabase({ url: "postgresql://h/db", poolMax: 3 })).toMatchObject({ kind: "postgres", poolMax: 3 });
    expect(parseDatabase("sqlite:/data/x.sqlite")).toEqual({ kind: "sqlite", path: "/data/x.sqlite" });
    expect(parseDatabase(":memory:")).toEqual({ kind: "sqlite", path: ":memory:" });
    expect(() => parseDatabase("sqlite:")).toThrow(/empty/);
  });

  it("interpolates ${VAR} and refuses unset variables", () => {
    expect(interpolateEnv({ a: ["x-${K}"] }, { K: "1" })).toEqual({ a: ["x-1"] });
    expect(() => interpolateEnv({ db: "${NOPE}" }, {})).toThrow(/db references unset env var NOPE/);
  });

  it("applies env overrides, including per-ledger RPC lists", () => {
    expect(rpcEnvName("eip155:296")).toBe("CLPROUTER_RPC_URLS_EIP155_296");
    const c = applyEnvOverrides(base(), {
      CLPROUTER_DATABASE_URL: "postgres://db/x",
      CLPROUTER_HTTP_PORT: "9000",
      CLPROUTER_HTTP_HOST: "0.0.0.0",
      CLPROUTER_LOG_LEVEL: "debug",
      CLPROUTER_METRICS_PORT: "9464",
      CLPROUTER_CORS_ORIGINS: "https://a.example, https://b.example",
      CLPROUTER_RPC_URLS_EIP155_296: "https://one.example, https://two.example",
    });
    const r = resolveConfig(c);
    expect(r.database.kind).toBe("postgres");
    expect(r.http).toMatchObject({ port: 9000, host: "0.0.0.0", cors: { origins: ["https://a.example", "https://b.example"] } });
    expect(r.log.level).toBe("debug");
    expect(r.metrics.port).toBe(9464);
    expect(r.ledgers[0]!.rpcUrls).toEqual(["https://one.example", "https://two.example"]);
    expect(() => applyEnvOverrides(base(), { CLPROUTER_HTTP_PORT: "80a" })).toThrow(/integer/);
  });

  it("loads from a file or from inline JSON in the env", () => {
    const dir = mkdtempSync(join(tmpdir(), "clpr-cfg-"));
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ ...base(), ledgers: [{ ...base().ledgers[0], rpcUrl: "https://rpc.example/${KEY}" }] }));
    expect(loadConfig(file, { KEY: "k" }).ledgers[0]!.rpcUrl).toBe("https://rpc.example/k");
    expect(loadConfig(undefined, { CLPROUTER_SERVICES_CONFIG_JSON: JSON.stringify(base()) }).ledgers).toHaveLength(1);
    expect(() => loadConfig(undefined, {})).toThrow(/no file given/);
    expect(() => loadConfig(join(dir, "missing.json"), {})).toThrow(/cannot read/);
    writeFileSync(file, "{");
    expect(() => loadConfig(file, {})).toThrow(/not valid JSON/);
  });

  it("the example configs are valid", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["config.example.json", "docker/config.compose.json"]) {
      const raw = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")) as ServicesConfig;
      const env = { CLPROUTER_DATABASE_URL: "postgres://u@db/x", ANVIL_RPC_URL: "http://anvil.localhost:8545", ROUTER_ADDRESS: A, REGISTRY_ADDRESS: A, VAULT_ADDRESS: A };
      expect(() => resolveConfig(interpolateEnv(raw, env))).not.toThrow();
    }
  });
});
