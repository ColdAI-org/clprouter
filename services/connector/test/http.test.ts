// SPDX-License-Identifier: MIT
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Connector } from "../src/connector.js";
import { startHttp } from "../src/http.js";
import { NoRelay } from "../src/relay.js";
import { Store } from "../src/store.js";
import { connectorAccount, fakeLedger, quoteRequest, signerAccount, testConfig, tmpStorePath, ZERO } from "./fixtures.js";

const ORDER_NONE = [ZERO, 0, 0n, ZERO, 0n, ZERO, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 0n, 0n, 0n] as const;

function connector(o: { free: bigint; balance?: bigint }): Connector {
  const cfg = testConfig();
  const hedera = fakeLedger({
    ledgerId: cfg.hedera.ledgerId,
    reads: {
      PENALTY_BPS: () => 1000,
      bonds: () => [o.free, 0n, 0n, 0n],
      freeCapacity: () => o.free,
      orders: () => ORDER_NONE,
    },
  });
  const chains = new Map([
    ["eip155:31001", fakeLedger({ ledgerId: "eip155:31001", time: 1_800_000_000n })],
    ["eip155:31002", fakeLedger({ ledgerId: "eip155:31002", balance: o.balance })],
  ]);
  let n = 0;
  return new Connector(cfg, Store.open(tmpStorePath()), {
    hedera,
    chains,
    connector: connectorAccount,
    signer: signerAccount,
    relay: new NoRelay(),
    salt: () => `0x${(++n).toString(16).padStart(64, "0")}`,
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(c: Connector, bodyLimitBytes = 4096): Promise<string> {
  server = await startHttp(c, { host: "127.0.0.1", port: 0, bodyLimitBytes });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, body: string, ct = "application/json") => fetch(`${url}/quote`, { method: "POST", headers: { "content-type": ct }, body });

describe("HTTP API", () => {
  it("issues a quote and records it", async () => {
    const c = connector({ free: 10n ** 21n });
    const url = await serve(c);
    const res = await post(url, JSON.stringify(quoteRequest()));
    expect(res.status).toBe(200);
    const q = (await res.json()) as { orderId: string; quote: { amountIn: string } };
    expect(q.quote.amountIn).toBe("1010000000000000000");
    expect(c.store.data.quotes[q.orderId.toLowerCase()]).toBeDefined();
    const o = await fetch(`${url}/orders/${q.orderId}`);
    expect(o.status).toBe(200);
    expect(((await o.json()) as { onchain: { status: string } }).onchain.status).toBe("NONE");
  });

  it("answers 400 for bad input and unsupported routes", async () => {
    const url = await serve(connector({ free: 10n ** 21n }));
    const bad = await post(url, "{nope");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "body is not valid JSON", code: "bad-request" });
    const invalid = await post(url, JSON.stringify(quoteRequest({ amountOut: "-1" })));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe("bad-request");
    const route = await post(url, JSON.stringify(quoteRequest({ srcLedger: "eip155:31002", dstLedger: "eip155:31001" })));
    expect(route.status).toBe(400);
    expect(((await route.json()) as { code: string }).code).toBe("unsupported-route");
    expect((await post(url, JSON.stringify(quoteRequest()), "text/plain")).status).toBe(415);
    expect((await fetch(`${url}/quote`)).status).toBe(405);
    expect((await fetch(`${url}/orders/0x12`)).status).toBe(400);
    expect((await fetch(`${url}/orders/0x${"12".repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it("answers 503 no-capacity once outstanding quotes use the free bond", async () => {
    // owedOnDefault of one quote = 1.111e18; a free bond of 2.5e18 covers two.
    const url = await serve(connector({ free: 2_500_000_000_000_000_000n }));
    expect((await post(url, JSON.stringify(quoteRequest()))).status).toBe(200);
    expect((await post(url, JSON.stringify(quoteRequest()))).status).toBe(200);
    const third = await post(url, JSON.stringify(quoteRequest()));
    expect(third.status).toBe(503);
    expect(((await third.json()) as { code: string }).code).toBe("no-capacity");
    const info = (await (await fetch(`${url}/info`)).json()) as { bond: { free: string }; routes: unknown[] };
    expect(info.bond.free).toBe((2_500_000_000_000_000_000n - 2n * 1_111_000_000_000_000_000n).toString());
    expect(info.routes).toHaveLength(1);
  });

  it("answers 503 when the Connector cannot deliver the amount", async () => {
    const url = await serve(connector({ free: 10n ** 21n, balance: 1n }));
    const r = await post(url, JSON.stringify(quoteRequest()));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe("no-liquidity");
  });

  it("enforces the body limit", async () => {
    const url = await serve(connector({ free: 10n ** 21n }), 256);
    const r = await post(url, JSON.stringify({ ...quoteRequest(), pad: "x".repeat(1000) }));
    expect(r.status).toBe(413);
    expect(((await r.json()) as { code: string }).code).toBe("body-too-large");
  });
});
