// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { getAddress, keccak256, toBytes } from "viem";
import { z } from "zod";
import { CAIP2, ConfigError, interpolateEnv, isLocalRpc } from "../../src/config.js";
import { redactUrl } from "../../src/log.js";

/**
 * Connector configuration: one JSON file, `${ENV}` references substituted in every string, validated with a strict
 * schema (unknown keys are errors). See `connector/README.md` for the fields.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

const address = z.string().regex(ADDRESS, "must be a 20-byte hex address");
const bytes32 = z.string().regex(BYTES32, "must be a 32-byte hex value");
const ledgerId = z.string().regex(CAIP2, "must be a CAIP-2 id");
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const decimal = z.string().regex(DECIMAL, "must be a decimal integer string");
const positive = decimal.refine((s) => !DECIMAL.test(s) || BigInt(s) > 0n, "must be greater than zero");
const rpcUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}, "must be an http(s) URL");

const keySchema = z.discriminatedUnion("kind", [
  z
    .object({
      /** A TEST private key. Accepted only when every RPC URL in the config is local. */
      kind: z.literal("local-test-key"),
      privateKey: bytes32,
    })
    .strict(),
  z
    .object({
      /** External signer speaking `eth_signTransaction` (transactions only: not usable as the quote signer). */
      kind: z.literal("web3signer"),
      url: rpcUrl,
      address,
      authTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      timeoutMs: int(100, 120_000).optional(),
    })
    .strict(),
]);

const chainSchema = z
  .object({
    ledgerId,
    rpcUrl,
    chainId: int(1, Number.MAX_SAFE_INTEGER),
    clprService: address,
    /** SettleDeposit on this chain (users pay here). */
    deposit: address,
    /** SettleDelivery on this chain (the Connector pays here). */
    delivery: address,
    /** CLPR Channel between this chain and Hedera (same id on both ends). */
    channelId: bytes32,
    /** Blocks behind the head before a `Deposited` event is acted on. */
    confirmations: int(0, 10_000),
    startBlock: int(0, Number.MAX_SAFE_INTEGER),
    /** Blocks per `eth_getLogs` call. Default 2000. */
    logBatch: int(1, 100_000).optional(),
  })
  .strict();

const routeSchema = z
  .object({
    srcLedger: ledgerId,
    assetIn: address,
    dstLedger: ledgerId,
    assetOut: address,
    /** Base units of assetOut per base unit of assetIn = rateNum / rateDen. */
    rateNum: positive,
    rateDen: positive,
    feeBps: int(0, 10_000),
    /** Cover in bond-asset base units per base unit of assetIn = coverNum / coverDen. */
    coverNum: decimal,
    coverDen: positive,
    deliveryP90S: int(0, 30 * 86_400),
  })
  .strict();

export const connectorConfigSchema = z
  .object({
    name: z.string().min(1).max(64),
    hedera: z
      .object({ ledgerId, rpcUrl, chainId: int(1, Number.MAX_SAFE_INTEGER), orderBook: address, clprService: address })
      .strict(),
    chains: z.array(chainSchema).min(1).max(64),
    routes: z.array(routeSchema).min(1).max(1000),
    bond: z.object({ asset: address, target: decimal }).strict(),
    quote: z
      .object({
        ttlS: int(10, 86_400),
        defaultDeadlineS: int(60, 30 * 86_400),
        minDeliveryMarginS: int(0, 86_400),
        /** Latest deadline a request may ask for, seconds after issue. Default 7 days. */
        maxDeadlineS: int(60, 365 * 86_400).optional(),
      })
      .strict(),
    keys: z.object({ connector: keySchema, signer: keySchema }).strict(),
    relay: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({
          /** TEST ONLY: relays CLPR bundles without proofs; works only with the CLPR repo's E2EVerifier. */
          kind: z.literal("e2e-test-only"),
          bundleEncoder: address,
          bundleEncoderLedger: ledgerId,
          /** Most messages per bundle (default 12): keeps a bundle's Hedera call trace well under the node's limit. */
          maxMessagesPerBundle: int(1, 100).optional(),
        })
        .strict(),
    ]),
    /** JSON store path, relative to the working directory. */
    store: z.string().min(1),
    http: z
      .object({
        host: z.string().min(1).optional(),
        port: int(0, 65_535).optional(),
        bodyLimitBytes: int(64, 1_048_576).optional(),
      })
      .strict()
      .optional(),
    /** `serve` loop interval, ms. Default 5000. */
    pollIntervalMs: int(100, 3_600_000).optional(),
    /** Cancel open orders the Connector decided not to deliver (too late), so the user is paid at once. Default false. */
    cancelUndeliverable: z.boolean().optional(),
  })
  .strict();

export type ConnectorConfigInput = z.infer<typeof connectorConfigSchema>;
export type KeyConfig = z.infer<typeof keySchema>;

export interface ChainConfig {
  ledgerId: string;
  /** keccak256(utf8(ledgerId)). */
  ledger: Hex;
  rpcUrl: string;
  chainId: number;
  clprService: Address;
  deposit: Address;
  delivery: Address;
  channelId: Hex;
  confirmations: number;
  startBlock: number;
  logBatch: number;
}

export interface RouteConfig {
  srcLedger: string;
  assetIn: Address;
  dstLedger: string;
  assetOut: Address;
  rateNum: bigint;
  rateDen: bigint;
  feeBps: number;
  coverNum: bigint;
  coverDen: bigint;
  deliveryP90S: number;
}

export interface ConnectorConfig {
  name: string;
  hedera: { ledgerId: string; ledger: Hex; rpcUrl: string; chainId: number; orderBook: Address; clprService: Address };
  chains: ChainConfig[];
  routes: RouteConfig[];
  bond: { asset: Address; target: bigint };
  quote: { ttlS: number; defaultDeadlineS: number; minDeliveryMarginS: number; maxDeadlineS: number };
  keys: { connector: KeyConfig; signer: KeyConfig };
  relay: { kind: "none" } | { kind: "e2e-test-only"; bundleEncoder: Address; bundleEncoderLedger: string; maxMessagesPerBundle?: number };
  store: string;
  http: { host: string; port: number; bodyLimitBytes: number };
  pollIntervalMs: number;
  cancelUndeliverable: boolean;
}

export const ledgerHash = (caip2: string): Hex => keccak256(toBytes(caip2));

/** Every RPC URL the config reaches. */
export function allRpcUrls(c: { hedera: { rpcUrl: string }; chains: { rpcUrl: string }[] }): string[] {
  return [c.hedera.rpcUrl, ...c.chains.map((x) => x.rpcUrl)];
}

/** Validate and resolve a parsed config (after env substitution). Throws {@link ConfigError}. */
export function resolveConnectorConfig(raw: unknown): ConnectorConfig {
  const r = connectorConfigSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`connector config: ${msg}`);
  }
  const c = r.data;
  const chains: ChainConfig[] = c.chains.map((x) => ({
    ledgerId: x.ledgerId,
    ledger: ledgerHash(x.ledgerId),
    rpcUrl: x.rpcUrl,
    chainId: x.chainId,
    clprService: getAddress(x.clprService),
    deposit: getAddress(x.deposit),
    delivery: getAddress(x.delivery),
    channelId: x.channelId.toLowerCase() as Hex,
    confirmations: x.confirmations,
    startBlock: x.startBlock,
    logBatch: x.logBatch ?? 2000,
  }));
  const ids = new Set<string>();
  for (const ch of chains) {
    if (ids.has(ch.ledgerId)) throw new ConfigError(`connector config: chain ${ch.ledgerId} is listed twice`);
    if (ch.ledgerId === c.hedera.ledgerId) throw new ConfigError(`connector config: chain ${ch.ledgerId} is the Hedera ledger`);
    ids.add(ch.ledgerId);
  }
  const routes: RouteConfig[] = c.routes.map((x, i) => {
    if (!ids.has(x.srcLedger)) throw new ConfigError(`connector config: routes[${i}].srcLedger ${x.srcLedger} is not in chains`);
    if (!ids.has(x.dstLedger)) throw new ConfigError(`connector config: routes[${i}].dstLedger ${x.dstLedger} is not in chains`);
    return {
      srcLedger: x.srcLedger,
      assetIn: getAddress(x.assetIn),
      dstLedger: x.dstLedger,
      assetOut: getAddress(x.assetOut),
      rateNum: BigInt(x.rateNum),
      rateDen: BigInt(x.rateDen),
      feeBps: x.feeBps,
      coverNum: BigInt(x.coverNum),
      coverDen: BigInt(x.coverDen),
      deliveryP90S: x.deliveryP90S,
    };
  });
  const seen = new Set<string>();
  for (const r2 of routes) {
    const k = routeKey(r2.srcLedger, r2.assetIn, r2.dstLedger, r2.assetOut);
    if (seen.has(k)) throw new ConfigError(`connector config: route ${k} is listed twice`);
    seen.add(k);
  }

  const urls = allRpcUrls(c);
  const remote = urls.filter((u) => !isLocalRpc(u));
  for (const [name, k] of [["connector", c.keys.connector], ["signer", c.keys.signer]] as const) {
    // Test keys, local networks only: refuse to sign anywhere else.
    if (k.kind === "local-test-key" && remote.length) {
      throw new ConfigError(`connector config: keys.${name} is a local test key but ${remote.map(redactUrl).join(", ")} is not a local RPC`);
    }
    if (k.kind === "web3signer") {
      const u = new URL(k.url);
      if (u.protocol !== "https:" && !isLocalRpc(k.url)) throw new ConfigError(`connector config: keys.${name}: a remote signer must use https unless it is on localhost`);
    }
  }
  if (c.keys.signer.kind !== "local-test-key") {
    // The quote signer signs EIP-712 typed data, which the transaction-only web3signer adapter does not do.
    throw new ConfigError("connector config: keys.signer must be local-test-key (typed-data signing through web3signer is not supported yet)");
  }
  if (c.relay.kind === "e2e-test-only") {
    if (remote.length) throw new ConfigError(`connector config: the e2e-test-only relay refuses non-local RPC URLs (${remote.map(redactUrl).join(", ")})`);
    const encLedger = c.relay.bundleEncoderLedger;
    if (encLedger !== c.hedera.ledgerId && !ids.has(encLedger)) throw new ConfigError(`connector config: relay.bundleEncoderLedger ${encLedger} is not configured`);
  }

  return {
    name: c.name,
    hedera: {
      ledgerId: c.hedera.ledgerId,
      ledger: ledgerHash(c.hedera.ledgerId),
      rpcUrl: c.hedera.rpcUrl,
      chainId: c.hedera.chainId,
      orderBook: getAddress(c.hedera.orderBook),
      clprService: getAddress(c.hedera.clprService),
    },
    chains,
    routes,
    bond: { asset: getAddress(c.bond.asset), target: BigInt(c.bond.target) },
    quote: { ...c.quote, maxDeadlineS: c.quote.maxDeadlineS ?? 7 * 86_400 },
    keys: c.keys,
    relay: c.relay.kind === "none" ? { kind: "none" } : { kind: "e2e-test-only", bundleEncoder: getAddress(c.relay.bundleEncoder), bundleEncoderLedger: c.relay.bundleEncoderLedger, maxMessagesPerBundle: c.relay.maxMessagesPerBundle },
    store: c.store,
    http: { host: c.http?.host ?? "127.0.0.1", port: c.http?.port ?? 8787, bodyLimitBytes: c.http?.bodyLimitBytes ?? 16_384 },
    pollIntervalMs: c.pollIntervalMs ?? 5_000,
    cancelUndeliverable: c.cancelUndeliverable ?? false,
  };
}

export function routeKey(srcLedger: string, assetIn: string, dstLedger: string, assetOut: string): string {
  return `${srcLedger}|${assetIn.toLowerCase()}|${dstLedger}|${assetOut.toLowerCase()}`;
}

/** Read a config file, substitute `${ENV}` and validate. */
export function loadConnectorConfig(file: string, env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`connector config: cannot read ${file}: ${(e as Error).message}`);
  }
  return resolveConnectorConfig(interpolateEnv(raw, env));
}
