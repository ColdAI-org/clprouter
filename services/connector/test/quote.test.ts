// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { decodeAbiParameters, domainSeparator, encodeAbiParameters, hashStruct, isAddressEqual, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DELIVERY_COMPONENTS, deliveryHash, encodeDeliveryMessage } from "../src/deliver.js";
import type { QuoteJson } from "../src/quote.js";
import { buildQuote, owedFor, parseQuoteRequest, price, QUOTE_TYPES, QuoteError, quoteFromJson, quoteToJson, recoverQuoteSigner, settleDomain, signQuote, orderIdOf } from "../src/quote.js";
import { connectorAccount, quoteRequest, signerAccount, testConfig } from "./fixtures.js";

const vector = JSON.parse(readFileSync(new URL("../../../sdk/test/vectors/settle-quote.json", import.meta.url), "utf8")) as {
  quoteJson: QuoteJson;
  orderId: Hex;
  domainSeparator: Hex;
  structHash: Hex;
  signature: Hex;
  signer: Address;
  hederaChainId: number;
  orderBook: Address;
  deliveryMessage: Hex;
};

/** The public BIP-39 test mnemonic the vector was signed with. */
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("EIP-712 quote (cross-language vector)", () => {
  const domain = settleDomain(vector.hederaChainId, vector.orderBook);
  const q = quoteFromJson(vector.quoteJson);

  it("reproduces the domain separator, struct hash and order id", () => {
    expect(domainSeparator({ domain })).toBe(vector.domainSeparator);
    expect(hashStruct({ data: q, primaryType: "Quote", types: QUOTE_TYPES })).toBe(vector.structHash);
    expect(orderIdOf(q, domain)).toBe(vector.orderId);
  });

  it("recovers the vector's signer and signs identically", async () => {
    expect(isAddressEqual(await recoverQuoteSigner(q, domain, vector.signature), vector.signer)).toBe(true);
    const acct = mnemonicToAccount(TEST_MNEMONIC);
    expect(isAddressEqual(acct.address, vector.signer)).toBe(true);
    expect(await signQuote(acct, q, domain)).toBe(vector.signature);
  });

  it("round-trips the quote JSON", () => {
    const j = quoteToJson(q);
    expect(orderIdOf(quoteFromJson(j), domain)).toBe(vector.orderId);
  });

  it("encodes the delivery message and its hash as the contracts do", () => {
    const [, , d] = decodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "tuple", components: DELIVERY_COMPONENTS }], vector.deliveryMessage);
    const json = { orderId: d.orderId, asset: d.asset, recipient: d.recipient, amount: d.amount.toString(), deliveredAt: Number(d.deliveredAt), deliverer: d.deliverer };
    expect(encodeDeliveryMessage(json)).toBe(vector.deliveryMessage);
    expect(json.orderId).toBe(vector.orderId);
    const ledger = keccak256(new TextEncoder().encode("eip155:84532"));
    // keccak256(abi.encode(ledger, d)) with a static tuple = ledger word followed by the struct words.
    const words = encodeAbiParameters([{ type: "tuple", components: DELIVERY_COMPONENTS }], [d]);
    expect(deliveryHash(ledger, json)).toBe(keccak256(`${ledger}${words.slice(2)}` as Hex));
  });
});

describe("pricing", () => {
  const r = { rateNum: 1n, rateDen: 1n, feeBps: 100, coverNum: 1n, coverDen: 1n };

  it("adds the fee on top and rounds up", () => {
    expect(price(r, 1000n, 0n)).toEqual({ amountIn: 1010n, fee: 10n, coverAmount: 1010n, owedOnDefault: 1010n });
    // base = ceil(10 / 3) = 4, amountIn = ceil(4 * 1.0001) = 5
    expect(price({ ...r, rateNum: 3n, feeBps: 1 }, 10n, 0n)).toMatchObject({ amountIn: 5n, fee: 1n });
    // base = ceil(7 * 2 / 1) = 14, no fee
    expect(price({ ...r, rateDen: 2n, feeBps: 0 }, 7n, 0n)).toMatchObject({ amountIn: 14n, fee: 0n });
  });

  it("computes the cover in bond units, rounded down, and owedOnDefault like the order book", () => {
    const p = price({ ...r, coverNum: 3n, coverDen: 2n }, 1001n, 2000n);
    // amountIn = ceil(1001 * 1.01) = 1012 (1011.01 rounds up); cover = floor(1012 * 3 / 2) = 1518; owed = 1518 + 303
    expect(p.amountIn).toBe(1012n);
    expect(p.coverAmount).toBe(1518n);
    expect(p.owedOnDefault).toBe(1518n + 303n);
    expect(owedFor(1n, 5000n)).toBe(1n);
    expect(owedFor(3n, 5000n)).toBe(4n);
  });
});

describe("quote requests", () => {
  const cfg = testConfig();
  const ctx = { now: 1_800_000_000n, penaltyBps: 1000n, connector: connectorAccount.address, signer: signerAccount, salt: `0x${"ab".repeat(32)}` as Hex };

  it("builds a signed quote bound to the source chain and the order book", async () => {
    const b = await buildQuote(cfg, parseQuoteRequest(quoteRequest()), ctx);
    const r = b.response;
    expect(r.quote.amountIn).toBe("1010000000000000000");
    expect(r.quote.coverAmount).toBe("1010000000000000000");
    expect(r.owedOnDefault).toBe("1111000000000000000");
    expect(r.fee).toEqual({ asset: "0x0000000000000000000000000000000000000000", amount: "10000000000000000" });
    expect(r.quote.issuedAt).toBe(1_800_000_000);
    expect(r.quote.expiry).toBe(1_800_000_300);
    expect(r.quote.deadline).toBe(1_800_003_600);
    expect(r.quote.payTo).toBe(`0x${"0".repeat(24)}${connectorAccount.address.slice(2).toLowerCase()}`);
    expect(r.quote.depositApp).toBe(`0x${"0".repeat(24)}${"00".repeat(19)}d1`);
    expect(r.quote.srcLedger).toBe(keccak256(new TextEncoder().encode("eip155:31001")));
    expect(r.connector).toEqual({ name: "test-connector", address: connectorAccount.address, signer: signerAccount.address });
    expect(r.hederaChainId).toBe(31003);
    expect(Object.keys(r).sort()).toEqual(["connector", "deliveryP90S", "dstLedgerId", "fee", "hederaChainId", "orderBook", "orderId", "owedOnDefault", "quote", "signature", "srcLedgerId"].sort());
    const domain = settleDomain(31003, cfg.hedera.orderBook);
    expect(r.orderId).toBe(orderIdOf(b.quote, domain));
    expect(isAddressEqual(await recoverQuoteSigner(b.quote, domain, r.signature), signerAccount.address)).toBe(true);
  });

  it("checks the deadline against expiry plus delivery time", async () => {
    const tooSoon = 1_800_000_000 + 300 + 60;
    await expect(buildQuote(cfg, parseQuoteRequest(quoteRequest({ deadline: tooSoon })), ctx)).rejects.toThrow(/deadline/);
    const ok = await buildQuote(cfg, parseQuoteRequest(quoteRequest({ deadline: tooSoon + 1 })), ctx);
    expect(ok.response.quote.deadline).toBe(tooSoon + 1);
    await expect(buildQuote(cfg, parseQuoteRequest(quoteRequest({ deadline: 1_800_000_000 + 8 * 86_400 })), ctx)).rejects.toThrow(/at most/);
  });

  it("rejects unsupported routes and malformed requests", async () => {
    await expect(buildQuote(cfg, parseQuoteRequest(quoteRequest({ dstLedger: "eip155:1" })), ctx)).rejects.toMatchObject({ code: "unsupported-route" });
    for (const bad of [
      quoteRequest({ amountOut: "0" }),
      quoteRequest({ amountOut: "1.5" }),
      quoteRequest({ amountOut: 5 }),
      quoteRequest({ recipient: "0x0000000000000000000000000000000000000000" }),
      quoteRequest({ user: "0x1234" }),
      quoteRequest({ extra: 1 }),
      quoteRequest({ deadline: "123" }),
      { ...quoteRequest(), refundTo: undefined },
    ]) {
      expect(() => parseQuoteRequest(bad)).toThrow(QuoteError);
    }
  });
});
