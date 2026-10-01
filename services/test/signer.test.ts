// SPDX-License-Identifier: MIT
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex, TransactionSerializable } from "viem";
import { hexToBigInt, parseTransaction, recoverTransactionAddress, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { buildSigner, digestSignerAccount, web3SignerAccount } from "../src/signer.js";

// Throwaway keys generated per run: the "remote signer" and the "KMS" below are played by them.
const remoteKey = generatePrivateKey();
const remote = privateKeyToAccount(remoteKey);
const testKey = generatePrivateKey();
const A = "0x0000000000000000000000000000000000000001";

const TX: TransactionSerializable = {
  chainId: 31337,
  to: "0x1000000000000000000000000000000000000001",
  data: "0xabcdef",
  nonce: 7,
  gas: 500_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  type: "eip1559",
};

let server: Server;
let url = "";
let mode: "ok" | "tamper" | "wrong-key" | "error" | "http500" = "ok";
const seen: { auth?: string; params?: Record<string, string> }[] = [];

beforeAll(async () => {
  // A Web3Signer-like endpoint: eth_signTransaction over JSON-RPC.
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as { id: number; method: string; params: [Record<string, string>] };
    seen.push({ auth: req.headers.authorization, params: body.params[0] });
    if (mode === "http500") {
      res.writeHead(500);
      res.end();
      return;
    }
    if (mode === "error") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "key locked" } }));
      return;
    }
    const p = body.params[0];
    const tx: TransactionSerializable = {
      chainId: Number(hexToBigInt(p.chainId as Hex)),
      to: p.to as Hex,
      data: (mode === "tamper" ? "0xdeadbeef" : p.data) as Hex,
      nonce: Number(hexToBigInt(p.nonce as Hex)),
      gas: hexToBigInt(p.gas as Hex),
      maxFeePerGas: hexToBigInt(p.maxFeePerGas as Hex),
      maxPriorityFeePerGas: hexToBigInt(p.maxPriorityFeePerGas as Hex),
      value: hexToBigInt(p.value as Hex),
      type: "eip1559",
    };
    const signer = mode === "wrong-key" ? privateKeyToAccount(generatePrivateKey()) : remote;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: await signer.signTransaction(tx) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("trigger signers", () => {
  it("web3signer: sends hex quantities with the bearer token, checks the signature and returns the signed tx", async () => {
    mode = "ok";
    const acct = web3SignerAccount({ url, address: remote.address, authToken: "tkn" });
    const signed = await acct.signTransaction!(TX);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(remote.address);
    expect(parseTransaction(signed)).toMatchObject({ to: TX.to, data: TX.data, nonce: 7, chainId: 31337 });
    const last = seen.at(-1)!;
    expect(last.auth).toBe("Bearer tkn");
    expect(last.params).toMatchObject({ from: remote.address, nonce: "0x7", chainId: toHex(31337), gas: toHex(500_000n) });
  });

  it("web3signer: rejects a signature from another key, a changed transaction, refusals and HTTP errors", async () => {
    const acct = web3SignerAccount({ url, address: remote.address });
    mode = "wrong-key";
    await expect(acct.signTransaction!(TX)).rejects.toThrow(/signed by .*expected/);
    mode = "tamper";
    await expect(acct.signTransaction!(TX)).rejects.toThrow(/changed data/);
    mode = "error";
    await expect(acct.signTransaction!(TX)).rejects.toThrow(/signer refused: key locked/);
    mode = "http500";
    await expect(acct.signTransaction!(TX)).rejects.toThrow(/HTTP 500/);
    await expect(web3SignerAccount({ url: "http://127.0.0.1:1", address: remote.address, timeoutMs: 500 }).signTransaction!(TX)).rejects.toThrow(/unreachable/);
    await expect(acct.signMessage!({ message: "x" })).rejects.toThrow(/not supported/);
  });

  it("KMS-style digest signer: signs the digest, recovers and checks the address", async () => {
    const kms = { address: remote.address, signDigest: (d: Hex) => sign({ hash: d, privateKey: remoteKey }) };
    const signed = await digestSignerAccount(kms).signTransaction!(TX);
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(remote.address);
    const liar = { address: A as Hex, signDigest: (d: Hex) => sign({ hash: d, privateKey: remoteKey }) };
    await expect(digestSignerAccount(liar).signTransaction!(TX)).rejects.toThrow(/expected/);
  });

  const cfg = (rpcUrls: string[], extra: object = {}) =>
    resolveConfig({ ledgers: [{ id: "eip155:31337", rpcUrls, chainId: 31337, confirmations: 0, contracts: { router: A, registry: A, vault: A } }], ...extra });

  it("local test keys: only on local RPCs, never in strict mode, and absent key means record-only", () => {
    const local = cfg(["http://127.0.0.1:8545", "http://anvil.localhost:8545"]);
    const env = { K: testKey };
    expect(buildSigner({ kind: "local-test-key", keyEnv: "K" }, local.ledgers, { strict: false, env })?.account.address).toBe(privateKeyToAccount(testKey).address);
    const mixed = cfg(["http://127.0.0.1:8545", "https://rpc.example/v1"]);
    expect(() => buildSigner({ kind: "local-test-key", keyEnv: "K" }, mixed.ledgers, { strict: false, env })).toThrow(/refusing to sign on eip155:31337: https:\/\/rpc\.example\/v1/);
    expect(() => buildSigner({ kind: "local-test-key", keyEnv: "K" }, local.ledgers, { strict: true, env })).toThrow(/strict/);
    expect(buildSigner({ kind: "local-test-key", keyEnv: "K" }, local.ledgers, { strict: true, env: {} })).toBeUndefined();
    expect(() => buildSigner({ kind: "local-test-key", keyEnv: "K" }, local.ledgers, { strict: false, env: { K: "0x12" } })).toThrow(/32-byte/);
  });

  it("remote signer: any RPC, https unless localhost, token from env when configured", () => {
    const prod = cfg(["https://rpc.example/v1"]);
    const s = buildSigner({ kind: "web3signer", url: "https://signer.example", address: remote.address, authTokenEnv: "TOK" }, prod.ledgers, { strict: true, env: { TOK: "t" } });
    expect(s?.kind).toBe("web3signer");
    expect(() => buildSigner({ kind: "web3signer", url: "http://signer.example", address: remote.address }, prod.ledgers, { strict: true })).toThrow(/https/);
    expect(() => buildSigner({ kind: "web3signer", url: "https://signer.example", address: remote.address, authTokenEnv: "TOK" }, prod.ledgers, { strict: true, env: {} })).toThrow(/TOK is not set/);
  });

  it("an injected digest signer wins over the config", () => {
    const prod = cfg(["https://rpc.example/v1"]);
    const s = buildSigner({ kind: "local-test-key" }, prod.ledgers, { strict: true, injected: { address: remote.address, signDigest: (d) => sign({ hash: d, privateKey: remoteKey }) } });
    expect(s).toMatchObject({ kind: "injected" });
  });
});
