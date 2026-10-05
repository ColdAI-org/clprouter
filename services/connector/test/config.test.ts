// SPDX-License-Identifier: MIT
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import { loadConnectorConfig, resolveConnectorConfig } from "../src/config.js";
import { E2ETestOnlyRelay, RelayRefused } from "../src/relay.js";
import { ANVIL_KEY_0, fakeLedger, rawConfig, tmpStorePath } from "./fixtures.js";

const web3 = { kind: "web3signer", url: "https://signer.example", address: "0x00000000000000000000000000000000000000aa" };

describe("connector config", () => {
  it("accepts the e2e config and fills defaults", () => {
    const c = resolveConnectorConfig(rawConfig());
    expect(c.chains).toHaveLength(2);
    expect(c.bond.target).toBe(50n * 10n ** 18n);
    expect(c.quote.maxDeadlineS).toBe(7 * 86_400);
    expect(c.http).toEqual({ host: "127.0.0.1", port: 8787, bodyLimitBytes: 16_384 });
    expect(c.cancelUndeliverable).toBe(false);
  });

  it("rejects unknown keys at any level", () => {
    expect(() => resolveConnectorConfig(rawConfig({ extra: 1 }))).toThrow(ConfigError);
    const r = rawConfig();
    (r.quote as Record<string, unknown>).ttl = 5;
    expect(() => resolveConnectorConfig(r)).toThrow(/quote/);
    const r2 = rawConfig();
    (r2.keys as { connector: Record<string, unknown> }).connector.keyEnv = "X";
    expect(() => resolveConnectorConfig(r2)).toThrow(ConfigError);
  });

  it("refuses a local test key when any RPC is not local", () => {
    const r = rawConfig({ relay: { kind: "none" } });
    (r.hedera as Record<string, unknown>).rpcUrl = "https://testnet.hashio.io/api";
    expect(() => resolveConnectorConfig(r)).toThrow(/local test key/);
  });

  it("refuses the test-only relay on non-local RPCs", () => {
    const r = rawConfig({ keys: { connector: web3, signer: { kind: "local-test-key", privateKey: ANVIL_KEY_0 } } });
    (r.chains as Record<string, unknown>[])[0]!.rpcUrl = "https://rpc.example";
    // The local signer key is refused first; with only remote-capable keys the relay check fires.
    expect(() => resolveConnectorConfig(r)).toThrow(ConfigError);
    expect(() => new E2ETestOnlyRelay({ ledger: fakeLedger({ ledgerId: "x", rpcUrl: "https://rpc.example" }), address: "0x00000000000000000000000000000000000000ee" }, console as never)).toThrow(RelayRefused);
    expect(() => E2ETestOnlyRelay.assertLocal("http://anvil.localhost:8545")).not.toThrow();
  });

  it("refuses a web3signer quote signer and a plain-http remote signer", () => {
    expect(() => resolveConnectorConfig(rawConfig({ keys: { connector: { kind: "local-test-key", privateKey: ANVIL_KEY_0 }, signer: { ...web3, url: "http://127.0.0.1:9000" } } }))).toThrow(/keys.signer/);
    const r = rawConfig({ relay: { kind: "none" }, keys: { connector: { ...web3, url: "http://signer.example" }, signer: { kind: "local-test-key", privateKey: ANVIL_KEY_0 } } });
    expect(() => resolveConnectorConfig(r)).toThrow(/https/);
  });

  it("checks routes, chains and relay ledgers", () => {
    expect(() => resolveConnectorConfig(rawConfig({ routes: [{ ...(rawConfig().routes as object[])[0], dstLedger: "eip155:9" }] }))).toThrow(/not in chains/);
    expect(() => resolveConnectorConfig(rawConfig({ relay: { kind: "e2e-test-only", bundleEncoder: "0x00000000000000000000000000000000000000ee", bundleEncoderLedger: "eip155:9" } }))).toThrow(/bundleEncoderLedger/);
    expect(() => resolveConnectorConfig(rawConfig({ routes: [{ ...(rawConfig().routes as object[])[0], rateDen: "0" }] }))).toThrow(/rateDen/);
  });

  it("substitutes ${ENV} in strings and errors on unset variables", () => {
    const f = tmpStorePath().replace(/store\.json$/, "config.json");
    const r = rawConfig({ keys: { connector: { kind: "local-test-key", privateKey: "${CONNECTOR_KEY}" }, signer: { kind: "local-test-key", privateKey: "${SIGNER_KEY}" } } });
    writeFileSync(f, JSON.stringify(r));
    const c = loadConnectorConfig(f, { CONNECTOR_KEY: ANVIL_KEY_0, SIGNER_KEY: ANVIL_KEY_0 });
    expect(c.keys.connector).toEqual({ kind: "local-test-key", privateKey: ANVIL_KEY_0 });
    expect(() => loadConnectorConfig(f, { CONNECTOR_KEY: ANVIL_KEY_0 })).toThrow(/SIGNER_KEY/);
  });
});

describe("testnet keys", () => {
  const testnet = (over: Record<string, unknown> = {}) => {
    const r = rawConfig({ relay: { kind: "none" }, keys: { connector: { kind: "testnet-key", privateKey: ANVIL_KEY_0 }, signer: { kind: "testnet-key", privateKey: ANVIL_KEY_0 } }, ...over });
    r.hedera = { ...(r.hedera as object), ledgerId: "eip155:296", chainId: 296, rpcUrl: "https://testnet.hashio.io/api" };
    const [y] = r.chains as Record<string, unknown>[];
    r.chains = [{ ...y, ledgerId: "eip155:11155111", chainId: 11155111, rpcUrl: "https://sepolia.example/rpc" }];
    r.routes = [{ ...(r.routes as Record<string, unknown>[])[0], srcLedger: "eip155:11155111", dstLedger: "eip155:11155111" }];
    return r;
  };

  it("accepts a testnet key when every chain is a public testnet, with remote RPCs", () => {
    const c = resolveConnectorConfig(testnet());
    expect(c.keys.connector.kind).toBe("testnet-key");
    expect(c.keys.signer.kind).toBe("testnet-key");
  });

  it("refuses a testnet key when any chain is not a known public testnet", () => {
    const r = testnet();
    (r.chains as Record<string, unknown>[])[0]!.chainId = 1;
    expect(() => resolveConnectorConfig(r)).toThrow(/not a known public testnet/);
    const h = testnet();
    (h.hedera as Record<string, unknown>).chainId = 295;
    expect(() => resolveConnectorConfig(h)).toThrow(/295 is not a known public testnet/);
  });

  it("still refuses the test-only relay on public testnets", () => {
    const r = testnet({ relay: { kind: "e2e-test-only", bundleEncoder: "0x00000000000000000000000000000000000000ee", bundleEncoderLedger: "eip155:296" } });
    expect(() => resolveConnectorConfig(r)).toThrow(/e2e-test-only relay refuses/);
  });
});
