// SPDX-License-Identifier: MIT
import type { Address, Hex, LocalAccount, TypedDataDomain } from "viem";
import { getAddress, hashTypedData, pad, recoverTypedDataAddress, toHex } from "viem";
import { z } from "zod";
import { CAIP2 } from "../../src/config.js";
import type { ConnectorConfig, RouteConfig } from "./config.js";
import { ledgerHash, routeKey } from "./config.js";

/** A Connector quote, as `SettleTypes.Quote`. Chain-side values are 32 bytes; times are unix seconds. */
export interface Quote {
  connector: Address;
  srcLedger: Hex;
  depositApp: Hex;
  user: Hex;
  payTo: Hex;
  assetIn: Hex;
  amountIn: bigint;
  dstLedger: Hex;
  assetOut: Hex;
  recipient: Hex;
  amountOut: bigint;
  coverAsset: Address;
  coverAmount: bigint;
  refundTo: Address;
  issuedAt: bigint;
  expiry: bigint;
  deadline: bigint;
  salt: Hex;
}

/** The quote as JSON (amounts as decimal strings, times as numbers). */
export interface QuoteJson {
  connector: string;
  srcLedger: string;
  depositApp: string;
  user: string;
  payTo: string;
  assetIn: string;
  amountIn: string;
  dstLedger: string;
  assetOut: string;
  recipient: string;
  amountOut: string;
  coverAsset: string;
  coverAmount: string;
  refundTo: string;
  issuedAt: number;
  expiry: number;
  deadline: number;
  salt: string;
}

/** Response of `POST /quote` and of the `quote` command. */
export interface QuoteResponse {
  quote: QuoteJson;
  signature: Hex;
  orderId: Hex;
  srcLedgerId: string;
  dstLedgerId: string;
  fee: { asset: string; amount: string };
  owedOnDefault: string;
  deliveryP90S: number;
  connector: { name: string; address: string; signer: string };
  orderBook: string;
  hederaChainId: number;
}

/** EIP-712 type of `SettleTypes.Quote` (field order is part of the type hash). */
export const QUOTE_TYPES = {
  Quote: [
    { name: "connector", type: "address" },
    { name: "srcLedger", type: "bytes32" },
    { name: "depositApp", type: "bytes32" },
    { name: "user", type: "bytes32" },
    { name: "payTo", type: "bytes32" },
    { name: "assetIn", type: "bytes32" },
    { name: "amountIn", type: "uint256" },
    { name: "dstLedger", type: "bytes32" },
    { name: "assetOut", type: "bytes32" },
    { name: "recipient", type: "bytes32" },
    { name: "amountOut", type: "uint256" },
    { name: "coverAsset", type: "address" },
    { name: "coverAmount", type: "uint256" },
    { name: "refundTo", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** The order book's EIP-712 domain: Hedera's chain id and the order book address. */
export function settleDomain(hederaChainId: number, orderBook: Address): TypedDataDomain {
  return { name: "ClprSettle", version: "1", chainId: hederaChainId, verifyingContract: orderBook };
}

/** The order id of a quote: its EIP-712 digest under the order book's domain. */
export function orderIdOf(q: Quote, domain: TypedDataDomain): Hex {
  return hashTypedData({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: q });
}

export async function signQuote(account: LocalAccount, q: Quote, domain: TypedDataDomain): Promise<Hex> {
  return account.signTypedData({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: q });
}

export async function recoverQuoteSigner(q: Quote, domain: TypedDataDomain, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: q, signature });
}

/** An EVM address left-padded to 32 bytes (lowercase). */
export const toBytes32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

/** The address inside a left-padded 32-byte value, or undefined if the high 12 bytes are not zero. */
export function fromBytes32(b: Hex): Address | undefined {
  const s = b.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(s) || !/^0x0{24}/.test(s)) return undefined;
  return getAddress(`0x${s.slice(26)}`);
}

export function quoteToJson(q: Quote): QuoteJson {
  return {
    connector: q.connector,
    srcLedger: q.srcLedger,
    depositApp: q.depositApp,
    user: q.user,
    payTo: q.payTo,
    assetIn: q.assetIn,
    amountIn: q.amountIn.toString(),
    dstLedger: q.dstLedger,
    assetOut: q.assetOut,
    recipient: q.recipient,
    amountOut: q.amountOut.toString(),
    coverAsset: q.coverAsset,
    coverAmount: q.coverAmount.toString(),
    refundTo: q.refundTo,
    issuedAt: Number(q.issuedAt),
    expiry: Number(q.expiry),
    deadline: Number(q.deadline),
    salt: q.salt,
  };
}

export function quoteFromJson(j: QuoteJson): Quote {
  return {
    connector: getAddress(j.connector),
    srcLedger: j.srcLedger as Hex,
    depositApp: j.depositApp as Hex,
    user: j.user as Hex,
    payTo: j.payTo as Hex,
    assetIn: j.assetIn as Hex,
    amountIn: BigInt(j.amountIn),
    dstLedger: j.dstLedger as Hex,
    assetOut: j.assetOut as Hex,
    recipient: j.recipient as Hex,
    amountOut: BigInt(j.amountOut),
    coverAsset: getAddress(j.coverAsset),
    coverAmount: BigInt(j.coverAmount),
    refundTo: getAddress(j.refundTo),
    issuedAt: BigInt(j.issuedAt),
    expiry: BigInt(j.expiry),
    deadline: BigInt(j.deadline),
    salt: j.salt as Hex,
  };
}

// ── Pricing ───────────────────────────────────────────────────────────────

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface Price {
  amountIn: bigint;
  /** Part of amountIn kept as fee (assetIn base units). */
  fee: bigint;
  coverAmount: bigint;
  owedOnDefault: bigint;
}

/** The order book's `owedFor`: cover plus the penalty, rounded down. */
export function owedFor(coverAmount: bigint, penaltyBps: bigint): bigint {
  return coverAmount + (coverAmount * penaltyBps) / 10_000n;
}

/**
 * Price `amountOut` on a route: the base input rounds up (`amountOut * rateDen / rateNum`), the fee is added on top
 * and rounds up, the cover is proportional to amountIn (rounded down) in bond-asset base units.
 */
export function price(route: Pick<RouteConfig, "rateNum" | "rateDen" | "feeBps" | "coverNum" | "coverDen">, amountOut: bigint, penaltyBps: bigint): Price {
  const base = ceilDiv(amountOut * route.rateDen, route.rateNum);
  const amountIn = ceilDiv(base * BigInt(10_000 + route.feeBps), 10_000n);
  const coverAmount = (amountIn * route.coverNum) / route.coverDen;
  return { amountIn, fee: amountIn - base, coverAmount, owedOnDefault: owedFor(coverAmount, penaltyBps) };
}

// ── Requests ──────────────────────────────────────────────────────────────

export class QuoteError extends Error {
  override name = "QuoteError";
  constructor(
    readonly code: "bad-request" | "unsupported-route" | "no-capacity" | "no-liquidity",
    message: string,
  ) {
    super(message);
  }
  get status(): number {
    return this.code === "no-capacity" || this.code === "no-liquidity" ? 503 : 400;
  }
}

const MAX_UINT256 = 2n ** 256n - 1n;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const nonZero = address.refine((a) => !/^0x0{40}$/.test(a), "must not be the zero address");

export const quoteRequestSchema = z
  .object({
    srcLedger: z.string().regex(CAIP2, "must be a CAIP-2 id"),
    assetIn: address,
    dstLedger: z.string().regex(CAIP2, "must be a CAIP-2 id"),
    assetOut: address,
    amountOut: z
      .string()
      .regex(/^[1-9][0-9]{0,77}$/, "must be a positive decimal integer string")
      .refine((s) => !/^[0-9]{1,78}$/.test(s) || BigInt(s) <= MAX_UINT256, "is too large"),
    recipient: nonZero,
    user: nonZero,
    refundTo: nonZero,
    deadline: z.number().int().min(1).max(2 ** 63).optional(),
  })
  .strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export function parseQuoteRequest(body: unknown): QuoteRequest {
  const r = quoteRequestSchema.safeParse(body);
  if (!r.success) {
    throw new QuoteError("bad-request", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  }
  return r.data;
}

export function findRoute(cfg: ConnectorConfig, req: Pick<QuoteRequest, "srcLedger" | "assetIn" | "dstLedger" | "assetOut">): RouteConfig {
  const k = routeKey(req.srcLedger, req.assetIn, req.dstLedger, req.assetOut);
  const r = cfg.routes.find((x) => routeKey(x.srcLedger, x.assetIn, x.dstLedger, x.assetOut) === k);
  if (!r) throw new QuoteError("unsupported-route", `no route ${req.srcLedger} ${req.assetIn} -> ${req.dstLedger} ${req.assetOut}`);
  return r;
}

export interface BuildContext {
  /** Source chain time (latest block timestamp), unix seconds. */
  now: bigint;
  penaltyBps: bigint;
  /** The Connector's account (its Hedera account and the payee on the source chain). */
  connector: Address;
  signer: LocalAccount;
  salt: Hex;
}

export interface BuiltQuote {
  quote: Quote;
  response: QuoteResponse;
  route: RouteConfig;
  price: Price;
}

/** Price, bind and sign a quote for a validated request. Capacity is checked by the caller. */
export async function buildQuote(cfg: ConnectorConfig, req: QuoteRequest, ctx: BuildContext): Promise<BuiltQuote> {
  const route = findRoute(cfg, req);
  const src = cfg.chains.find((c) => c.ledgerId === req.srcLedger)!;
  const p = price(route, BigInt(req.amountOut), ctx.penaltyBps);
  if (p.amountIn > MAX_UINT256) throw new QuoteError("bad-request", "amountOut is too large for this route");
  if (p.coverAmount === 0n && route.coverNum > 0n) throw new QuoteError("bad-request", "amountOut is too small for this route");
  const issuedAt = ctx.now;
  const expiry = issuedAt + BigInt(cfg.quote.ttlS);
  const deadline = req.deadline !== undefined ? BigInt(req.deadline) : issuedAt + BigInt(cfg.quote.defaultDeadlineS);
  if (deadline <= expiry + BigInt(route.deliveryP90S)) {
    throw new QuoteError("bad-request", `deadline must be later than ${expiry + BigInt(route.deliveryP90S)} (quote expiry plus the route's delivery time)`);
  }
  if (deadline > issuedAt + BigInt(cfg.quote.maxDeadlineS)) {
    throw new QuoteError("bad-request", `deadline must be at most ${cfg.quote.maxDeadlineS} s after ${issuedAt}`);
  }
  const quote: Quote = {
    connector: ctx.connector,
    srcLedger: ledgerHash(req.srcLedger),
    depositApp: toBytes32(src.deposit),
    user: toBytes32(getAddress(req.user)),
    payTo: toBytes32(ctx.connector),
    assetIn: toBytes32(route.assetIn),
    amountIn: p.amountIn,
    dstLedger: ledgerHash(req.dstLedger),
    assetOut: toBytes32(route.assetOut),
    recipient: toBytes32(getAddress(req.recipient)),
    amountOut: BigInt(req.amountOut),
    coverAsset: cfg.bond.asset,
    coverAmount: p.coverAmount,
    refundTo: getAddress(req.refundTo),
    issuedAt,
    expiry,
    deadline,
    salt: ctx.salt,
  };
  const domain = settleDomain(cfg.hedera.chainId, cfg.hedera.orderBook);
  const signature = await signQuote(ctx.signer, quote, domain);
  const response: QuoteResponse = {
    quote: quoteToJson(quote),
    signature,
    orderId: orderIdOf(quote, domain),
    srcLedgerId: req.srcLedger,
    dstLedgerId: req.dstLedger,
    fee: { asset: route.assetIn, amount: p.fee.toString() },
    owedOnDefault: p.owedOnDefault.toString(),
    deliveryP90S: route.deliveryP90S,
    connector: { name: cfg.name, address: ctx.connector, signer: ctx.signer.address },
    orderBook: cfg.hedera.orderBook,
    hederaChainId: cfg.hedera.chainId,
  };
  return { quote, response, route, price: p };
}

export const randomSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));
