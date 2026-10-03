// SPDX-License-Identifier: MIT
import type { Address, Hex, LocalAccount } from "viem";
import { isAddressEqual, zeroAddress } from "viem";
import type { Logger } from "../../src/log.js";
import { silentLogger } from "../../src/log.js";
import { ERC20_ABI, ORDER_BOOK_ABI } from "./abi.js";
import { ensureBond, ensureRegistered, readBond } from "./bond.js";
import { available, requireCapacity } from "./capacity.js";
import type { Ledger } from "./clients.js";
import { accountFromKey, chainNow, makeLedger } from "./clients.js";
import type { ChainConfig, ConnectorConfig } from "./config.js";
import { decide, deliver } from "./deliver.js";
import { reconcile, readOrder, STATUS_NAMES } from "./orders.js";
import type { QuoteResponse } from "./quote.js";
import { buildQuote, parseQuoteRequest, QuoteError, randomSalt } from "./quote.js";
import type { ProofRelay } from "./relay.js";
import { E2ETestOnlyRelay, NoRelay } from "./relay.js";
import { key, Store } from "./store.js";
import { scanDeposits } from "./watcher.js";

export type RelayOrder = "deposit-first" | "delivery-first";

export interface RunOptions {
  relayOrder?: RelayOrder;
  /** "all" or one order id: do not deliver (simulates a Connector that misses the deadline). */
  skipDelivery?: string;
}

export interface RunSummary {
  delivered: string[];
  skipped: { orderId: string; reason: string }[];
  relayed: number;
  closed: string[];
  cancelled: string[];
  settled: string[];
  deposits: number;
  ignored: number;
  errors: { step: string; orderId?: string; message: string }[];
}

export interface Info {
  name: string;
  connector: Address;
  signer: Address;
  orderBook: Address;
  hederaChainId: number;
  routes: { srcLedgerId: string; dstLedgerId: string; assetIn: Address; assetOut: Address; feeBps: number; deliveryP90S: number }[];
  bond: { asset: Address; total: string; free: string };
}

export interface ConnectorDeps {
  hedera: Ledger;
  chains: Map<string, Ledger>;
  connector: LocalAccount;
  signer: LocalAccount;
  relay: ProofRelay;
  log?: Logger;
  salt?: () => Hex;
}

const errMsg = (e: unknown): string => {
  const x = e as { shortMessage?: string; message?: string };
  return String(x.shortMessage ?? x.message ?? e).slice(0, 500);
};

/** The Connector: quotes, watches deposits, delivers, relays (test networks) and settles orders on Hedera. */
export class Connector {
  readonly log: Logger;
  private penalty?: bigint;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly cfg: ConnectorConfig,
    readonly store: Store,
    readonly deps: ConnectorDeps,
  ) {
    this.log = deps.log ?? silentLogger;
  }

  static fromConfig(cfg: ConnectorConfig, o: { log?: Logger; env?: NodeJS.ProcessEnv } = {}): Connector {
    const connector = accountFromKey(cfg.keys.connector, o.env);
    const signer = accountFromKey(cfg.keys.signer, o.env);
    const hedera = makeLedger({ ledgerId: cfg.hedera.ledgerId, chainId: cfg.hedera.chainId, rpcUrl: cfg.hedera.rpcUrl, account: connector, log: o.log });
    const chains = new Map(cfg.chains.map((c) => [c.ledgerId, makeLedger({ ledgerId: c.ledgerId, chainId: c.chainId, rpcUrl: c.rpcUrl, account: connector, log: o.log })]));
    let relay: ProofRelay = new NoRelay();
    if (cfg.relay.kind === "e2e-test-only") {
      const l = cfg.relay.bundleEncoderLedger === cfg.hedera.ledgerId ? hedera : chains.get(cfg.relay.bundleEncoderLedger)!;
      relay = new E2ETestOnlyRelay(
        { ledger: l, address: cfg.relay.bundleEncoder },
        o.log ?? silentLogger,
        cfg.relay.maxMessagesPerBundle !== undefined ? BigInt(cfg.relay.maxMessagesPerBundle) : undefined,
      );
    }
    return new Connector(cfg, Store.open(cfg.store), { hedera, chains, connector, signer, relay, log: o.log });
  }

  get address(): Address {
    return this.deps.connector.address;
  }

  /** Run `fn` after every earlier call finished (one writer to the store at a time). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async penaltyBps(): Promise<bigint> {
    if (this.penalty === undefined) {
      this.penalty = BigInt(await this.deps.hedera.public.readContract({ address: this.cfg.hedera.orderBook, abi: ORDER_BOOK_ABI, functionName: "PENALTY_BPS" }));
    }
    return this.penalty;
  }

  private chain(ledgerId: string): { c: ChainConfig; l: Ledger } {
    const c = this.cfg.chains.find((x) => x.ledgerId === ledgerId);
    const l = this.deps.chains.get(ledgerId);
    if (!c || !l) throw new Error(`ledger ${ledgerId} is not configured`);
    return { c, l };
  }

  private async balance(l: Ledger, asset: Address): Promise<bigint> {
    if (isAddressEqual(asset, zeroAddress)) return l.public.getBalance({ address: this.address });
    return l.public.readContract({ address: asset, abi: ERC20_ABI, functionName: "balanceOf", args: [this.address] });
  }

  /** Validate a request, price it, check bond capacity and liquidity, sign and record the quote. */
  quote(body: unknown): Promise<QuoteResponse> {
    const req = parseQuoteRequest(body);
    return this.serial(async () => {
      const src = this.chain(req.srcLedger);
      const dst = this.chain(req.dstLedger);
      const [now, penaltyBps] = await Promise.all([chainNow(src.l), this.penaltyBps()]);
      const built = await buildQuote(this.cfg, req, { now, penaltyBps, connector: this.address, signer: this.deps.signer, salt: (this.deps.salt ?? randomSalt)() });
      const bond = await readBond(this.deps.hedera, this.cfg.hedera.orderBook, this.address, this.cfg.bond.asset);
      requireCapacity(bond.free, this.store.data, built.price.owedOnDefault);
      const have = await this.balance(dst.l, built.route.assetOut);
      if (have < built.quote.amountOut) throw new QuoteError("no-liquidity", `the Connector cannot deliver ${built.quote.amountOut} on ${req.dstLedger} right now`);
      const id = key(built.response.orderId);
      this.store.update((d) => {
        d.quotes[id] = { orderId: id, response: built.response, owedOnDefault: built.price.owedOnDefault.toString(), expiry: Number(built.quote.expiry) };
      });
      this.log.info("quote issued", { orderId: id, src: req.srcLedger, dst: req.dstLedger, amountIn: built.quote.amountIn.toString(), amountOut: req.amountOut });
      return built.response;
    });
  }

  async info(): Promise<Info> {
    const bond = await readBond(this.deps.hedera, this.cfg.hedera.orderBook, this.address, this.cfg.bond.asset);
    return {
      name: this.cfg.name,
      connector: this.address,
      signer: this.deps.signer.address,
      orderBook: this.cfg.hedera.orderBook,
      hederaChainId: this.cfg.hedera.chainId,
      routes: this.cfg.routes.map((r) => ({ srcLedgerId: r.srcLedger, dstLedgerId: r.dstLedger, assetIn: r.assetIn, assetOut: r.assetOut, feeBps: r.feeBps, deliveryP90S: r.deliveryP90S })),
      bond: { asset: this.cfg.bond.asset, total: bond.total.toString(), free: available(bond.free, this.store.data).toString() },
    };
  }

  /** What this Connector knows about an order, plus its state on the order book. Undefined if unknown to both. */
  async order(orderId: Hex): Promise<Record<string, unknown> | undefined> {
    const id = key(orderId);
    const d = this.store.data;
    const o = await readOrder(this.deps.hedera, this.cfg.hedera.orderBook, id as Hex);
    if (!d.quotes[id] && o.status === 0) return undefined;
    return {
      orderId: id,
      quote: d.quotes[id]?.response,
      deposit: d.deposits[id],
      delivery: d.deliveries[id],
      skipped: d.skipped[id],
      closed: d.closed[id],
      onchain: {
        status: STATUS_NAMES[o.status] ?? String(o.status),
        connector: o.connector,
        deadline: Number(o.deadline),
        owedOnDefault: o.owedOnDefault.toString(),
        reserved: o.reserved.toString(),
        refundTo: o.refundTo,
      },
    };
  }

  /** One pass: bond, deposits, deliveries, relay, settlement. */
  runOnce(opts: RunOptions = {}): Promise<RunSummary> {
    return this.serial(() => this.pass(opts));
  }

  private async pass(opts: RunOptions): Promise<RunSummary> {
    const s: RunSummary = { delivered: [], skipped: [], relayed: 0, closed: [], cancelled: [], settled: [], deposits: 0, ignored: 0, errors: [] };
    const h = this.deps.hedera;
    const ob = this.cfg.hedera.orderBook;
    await ensureRegistered(h, ob, this.deps.signer.address, this.log);
    await ensureBond(h, ob, this.cfg.bond.asset, this.cfg.bond.target, this.log);

    for (const c of this.cfg.chains) {
      try {
        const r = await scanDeposits(this.chain(c.ledgerId).l, c, this.store, this.log);
        s.deposits += r.found.length;
        s.ignored += r.ignored;
      } catch (e) {
        s.errors.push({ step: `scan ${c.ledgerId}`, message: errMsg(e) });
      }
    }

    const dstNow = new Map<string, bigint>();
    for (const dep of Object.values(this.store.data.deposits)) {
      const q = this.store.data.quotes[dep.orderId];
      if (!q) continue;
      try {
        const dstId = q.response.dstLedgerId;
        const dst = this.chain(dstId);
        if (!dstNow.has(dstId)) dstNow.set(dstId, await chainNow(dst.l));
        const dec = decide(this.store.data, dep, {
          connector: this.address,
          signer: this.deps.signer.address,
          dstNow: dstNow.get(dstId)!,
          minDeliveryMarginS: this.cfg.quote.minDeliveryMarginS,
          skip: opts.skipDelivery,
        });
        if (dec.kind === "skip") {
          this.store.update((d) => {
            d.skipped[dep.orderId] = { reason: dec.reason, at: Number(dstNow.get(dstId)) };
          });
          s.skipped.push({ orderId: dep.orderId, reason: dec.reason });
          this.log.warn("order not delivered", { orderId: dep.orderId, reason: dec.reason });
        } else if (dec.kind === "deliver") {
          await deliver(dst.l, dst.c, this.store, dep.orderId, this.log);
          s.delivered.push(dep.orderId);
        }
      } catch (e) {
        s.errors.push({ step: "deliver", orderId: dep.orderId, message: errMsg(e) });
      }
    }

    s.relayed = await this.relayAll(opts.relayOrder ?? "deposit-first", s);

    try {
      const r = await reconcile(h, ob, this.store, { cancelUndeliverable: this.cfg.cancelUndeliverable, log: this.log });
      s.closed = r.closed;
      s.cancelled = r.cancelled;
      s.settled = r.settled;
    } catch (e) {
      s.errors.push({ step: "settle", message: errMsg(e) });
    }
    return s;
  }

  /**
   * Relay every Channel in both directions. Chain-to-Hedera goes first so the order book sees new deposits and
   * deliveries, then Hedera-to-chain carries the acknowledgements back. `delivery-first` relays the chains this
   * Connector delivers on before the chains users paid on (the order book then records the delivery and the order
   * is closed with {@link reconcile}); `deposit-first` does the reverse.
   */
  private async relayAll(order: RelayOrder, s: RunSummary): Promise<number> {
    if (this.deps.relay.kind === "none") return 0;
    const d = this.store.data;
    const pending = Object.keys(d.deposits).filter((id) => !d.closed[id]);
    const srcs = new Set(pending.map((id) => d.quotes[id]?.response.srcLedgerId));
    const dsts = new Set(pending.filter((id) => d.deliveries[id]?.delivery).map((id) => d.quotes[id]?.response.dstLedgerId));
    const first = order === "delivery-first" ? dsts : srcs;
    const second = order === "delivery-first" ? srcs : dsts;
    const rank = (id: string) => (first.has(id) && !second.has(id) ? 0 : first.has(id) ? 1 : second.has(id) ? 2 : 3);
    const chains = [...this.cfg.chains].sort((a, b) => rank(a.ledgerId) - rank(b.ledgerId));
    const hEnd = { ledger: this.deps.hedera, clprService: this.cfg.hedera.clprService };
    let n = 0;
    const one = async (from: typeof hEnd, to: typeof hEnd, ch: Hex) => {
      try {
        if ((await this.deps.relay.relay(from, to, ch)).submitted) n++;
      } catch (e) {
        s.errors.push({ step: `relay ${from.ledger.ledgerId} -> ${to.ledger.ledgerId}`, message: errMsg(e) });
      }
    };
    for (const c of chains) await one({ ledger: this.chain(c.ledgerId).l, clprService: c.clprService }, hEnd, c.channelId);
    for (const c of chains) await one(hEnd, { ledger: this.chain(c.ledgerId).l, clprService: c.clprService }, c.channelId);
    return n;
  }
}
