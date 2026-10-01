// SPDX-License-Identifier: MIT
import type { Address, Hex, LocalAccount, Signature, TransactionSerializable } from "viem";
import { isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, toHex } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import type { ResolvedLedger, SignerConfig } from "./config.js";
import { ConfigError, isLocalRpc, triggerKey } from "./config.js";
import { redactUrl } from "./log.js";

/**
 * Signers for the forward trigger. The service never needs a production key in its environment:
 *
 * - `web3signer`: an external signer reached over JSON-RPC `eth_signTransaction` (Web3Signer, or a compatible
 *   proxy in front of a KMS or HSM). Only a bearer token for the signer may sit in the env.
 * - {@link DigestSigner}: a KMS-style interface (sign a 32-byte digest, return r/s/yParity) for in-process adapters;
 *   pass one to `buildServices` as `options.signer`.
 * - `local-test-key`: a TEST key from an env var, accepted only when every RPC the trigger uses is local and the
 *   service is not in strict (production) mode.
 *
 * Every signature from a remote party is recovered and checked against the expected address, and the signed
 * transaction is checked against the one requested, before it is sent.
 */

export interface DigestSigner {
  address: Address;
  /** Sign a 32-byte digest (no prefixing). KMS adapters convert DER to r/s and find yParity by recovery. */
  signDigest(digest: Hex): Promise<Signature>;
}

export class SignerError extends Error {
  override name = "SignerError";
}

function unsupported(what: string): never {
  throw new SignerError(`${what} is not supported by the trigger signer (transactions only)`);
}

/** Check that a signed transaction is the one requested and signed by `address`. */
async function checkSigned(signed: Hex, want: TransactionSerializable, address: Address): Promise<void> {
  const got = parseTransaction(signed);
  const from = await recoverTransactionAddress({ serializedTransaction: signed as never });
  if (!isAddressEqual(from, address)) throw new SignerError(`signer returned a transaction signed by ${from}, expected ${address}`);
  const same = (a: unknown, b: unknown) => (a === undefined || a === null ? b === undefined || b === null : String(a).toLowerCase() === String(b ?? "").toLowerCase());
  for (const k of ["to", "data", "nonce", "chainId", "value", "gas"] as const) {
    const a = (want as Record<string, unknown>)[k];
    const b = (got as Record<string, unknown>)[k];
    if (a !== undefined && !same(a, b ?? (k === "value" ? 0n : undefined))) throw new SignerError(`signer changed ${k} of the transaction`);
  }
}

/** viem account over a KMS-style digest signer. */
export function digestSignerAccount(ds: DigestSigner): LocalAccount {
  return toAccount({
    address: ds.address,
    async signTransaction(tx, opts) {
      const serializer = (opts?.serializer ?? serializeTransaction) as typeof serializeTransaction;
      const digest = keccak256(serializer(tx));
      const sig = await ds.signDigest(digest);
      const signed = serializer(tx, sig);
      await checkSigned(signed, tx, ds.address);
      return signed;
    },
    signMessage: async () => unsupported("signMessage"),
    signTypedData: async () => unsupported("signTypedData"),
  });
}

export interface Web3SignerOptions {
  url: string;
  address: Address;
  authToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const q = (v: bigint | number | undefined) => (v === undefined ? undefined : toHex(v));

/** viem account that signs through a remote `eth_signTransaction` endpoint (Web3Signer-compatible). */
export function web3SignerAccount(o: Web3SignerOptions): LocalAccount {
  const f = o.fetch ?? fetch;
  let id = 0;
  return toAccount({
    address: o.address,
    async signTransaction(tx) {
      const t = tx as TransactionSerializable & { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
      const params = Object.fromEntries(
        Object.entries({
          from: o.address,
          to: t.to ?? undefined,
          data: t.data,
          value: q(t.value ?? 0n),
          gas: q(t.gas),
          nonce: q(t.nonce),
          chainId: q(t.chainId),
          gasPrice: q(t.gasPrice),
          maxFeePerGas: q(t.maxFeePerGas),
          maxPriorityFeePerGas: q(t.maxPriorityFeePerGas),
        }).filter(([, v]) => v !== undefined),
      );
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
      let res: Response;
      try {
        res = await f(o.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(o.authToken ? { authorization: `Bearer ${o.authToken}` } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_signTransaction", params: [params] }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new SignerError(`signer ${redactUrl(o.url)} unreachable: ${ctrl.signal.aborted ? "timeout" : (e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new SignerError(`signer ${redactUrl(o.url)} answered HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new SignerError(`signer refused: ${String(body.error.message ?? "error").slice(0, 200)}`);
      // Web3Signer returns the signed RLP; some proxies wrap it as { raw }.
      const signed = (typeof body.result === "string" ? body.result : (body.result as { raw?: string } | undefined)?.raw) as Hex | undefined;
      if (!signed || !/^0x[0-9a-fA-F]+$/.test(signed)) throw new SignerError("signer returned no signed transaction");
      await checkSigned(signed, tx, o.address);
      return signed;
    },
    signMessage: async () => unsupported("signMessage"),
    signTypedData: async () => unsupported("signTypedData"),
  });
}

export interface BuiltSigner {
  account: LocalAccount;
  kind: SignerConfig["kind"] | "injected";
}

/**
 * Build the trigger's account from config, enforcing where each kind may sign. Returns undefined when the local
 * test-key signer has no key in the env (the trigger then only records jobs).
 */
export function buildSigner(
  cfg: SignerConfig | undefined,
  ledgers: ResolvedLedger[],
  o: { strict: boolean; env?: NodeJS.ProcessEnv; injected?: DigestSigner; fetch?: typeof fetch },
): BuiltSigner | undefined {
  const env = o.env ?? process.env;
  if (o.injected) return { account: digestSignerAccount(o.injected), kind: "injected" };
  if (!cfg) return undefined;
  if (cfg.kind === "local-test-key") {
    const key = triggerKey(cfg, env);
    if (!key) return undefined;
    if (o.strict) throw new ConfigError("trigger: the local test-key signer is refused in strict (production) mode; use a web3signer or an injected signer");
    for (const l of ledgers) {
      const remote = l.rpcUrls.filter((u) => !isLocalRpc(u));
      // Test keys, local networks only: refuse to sign anywhere else.
      if (remote.length) throw new ConfigError(`trigger: refusing to sign on ${l.id}: ${remote.map(redactUrl).join(", ")} is not a local RPC`);
    }
    return { account: privateKeyToAccount(key), kind: "local-test-key" };
  }
  const u = new URL(cfg.url);
  if (u.protocol !== "https:" && !isLocalRpc(cfg.url)) throw new ConfigError("trigger: a remote signer must use https unless it is on localhost");
  const token = cfg.authTokenEnv ? env[cfg.authTokenEnv] : undefined;
  if (cfg.authTokenEnv && !token) throw new ConfigError(`trigger: signer auth token env var ${cfg.authTokenEnv} is not set`);
  return {
    account: web3SignerAccount({ url: cfg.url, address: cfg.address, authToken: token, timeoutMs: cfg.timeoutMs, fetch: o.fetch }),
    kind: "web3signer",
  };
}
